import { app, nativeImage, type DownloadItem, type Session, type WebContents } from 'electron'
import fs from 'fs'
import path from 'path'
import type { DownloadInfo } from '../shared/types'
import { JsonFile } from './store'

// История загрузок, как chrome://downloads: что скачивали, когда и откуда — и есть ли файл ещё на диске.
// Сами файлы Masaki не трогает: «убрать из списка» стирает только запись.

/** Сколько записей помнить; старые уходят из списка, файлы остаются в папке. */
const KEEP = 1000
const file = new JsonFile<DownloadInfo[]>('downloads.json')
const STATES = new Set(['progressing', 'completed', 'cancelled', 'interrupted'])
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|avif|heic|ico|tiff?)$/i

let list: DownloadInfo[] = []
/** Живые DownloadItem: interrupted бывает и до done — пока объект жив, загрузку ещё можно отменить. */
const items = new Map<string, DownloadItem>()
const thumbs = new Map<string, string | null>()
let send: (d: DownloadInfo) => void = () => {}
let completed: (p: string) => void = () => {}

function valid(d: unknown): d is DownloadInfo {
  const x = d as DownloadInfo
  return (
    !!x &&
    typeof x.id === 'string' &&
    typeof x.filename === 'string' &&
    typeof x.url === 'string' &&
    typeof x.path === 'string' &&
    STATES.has(x.state) &&
    Number.isFinite(x.received) &&
    Number.isFinite(x.total) &&
    Number.isFinite(x.startedAt)
  )
}

export async function initDownloads(hooks: { send(d: DownloadInfo): void; completed(p: string): void }): Promise<void> {
  send = hooks.send
  completed = hooks.completed
  const saved = await file.read()
  // Masaki закрылся посреди загрузки: она прервана, а объекта, который можно отменить, больше нет.
  list = (Array.isArray(saved) ? saved : [])
    .filter(valid)
    .map((d) => ({ ...d, state: d.state === 'progressing' ? 'interrupted' : d.state, canCancel: false, exists: undefined }))
}

export function flushDownloads(): void {
  file.flushSync()
}

function save(): void {
  file.write(
    list.slice(0, KEEP).map(({ exists: _, ...d }) => d),
    1000
  )
}

function put(d: DownloadInfo): void {
  const i = list.findIndex((x) => x.id === d.id)
  if (i < 0) list.unshift(d)
  else list[i] = d
  send(d)
  save()
}

function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name)
  const base = path.basename(name, ext)
  let candidate = path.join(dir, name)
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`)
  return candidate
}

/** Хост страницы, с которой скачали: подпись «откуда» понятнее адреса CDN. */
function hostOf(url: string): string | undefined {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.replace(/^www\./, '') : undefined
  } catch {
    return undefined
  }
}

export function trackDownload(item: DownloadItem, wc: WebContents | undefined): void {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const target = uniquePath(app.getPath('downloads'), item.getFilename())
  item.setSavePath(target)
  items.set(id, item)
  const page = wc && !wc.isDestroyed() ? hostOf(wc.getURL()) : undefined
  let endedAt: number | undefined
  const info = (state = item.getState()): DownloadInfo => ({
    id,
    filename: path.basename(item.getSavePath() || target),
    url: item.getURL(),
    path: item.getSavePath() || target,
    state,
    canCancel: items.has(id),
    received: item.getReceivedBytes(),
    total: item.getTotalBytes(),
    startedAt: item.getStartTime() * 1000,
    endedAt,
    page,
    mime: item.getMimeType() || undefined,
    exists: state === 'completed' ? true : undefined
  })
  put(info())
  item.on('updated', (_ev, state) => put(info(state)))
  item.once('done', (_ev, state) => {
    items.delete(id)
    endedAt = Date.now()
    put(info(state))
    if (state === 'completed') completed(item.getSavePath() || target)
  })
}

/** Вся история, свежие сверху; у завершённых — лежит ли файл на месте сейчас. */
export async function listDownloads(): Promise<DownloadInfo[]> {
  return Promise.all(
    list.map(async (d) => {
      if (d.state !== 'completed') return d
      const exists = await fs.promises.access(d.path).then(
        () => true,
        () => false
      )
      return { ...d, exists }
    })
  )
}

/** Завершённая загрузка из своего списка: только такие файлы можно открыть, показать или перетащить. */
export function isDownloadedFile(p: string): boolean {
  return list.some((d) => d.state === 'completed' && d.path === p)
}

export function cancelDownload(id: string): boolean {
  const item = items.get(id)
  if (!item) return false
  const state = item.getState()
  if (state !== 'progressing' && state !== 'interrupted') return false
  item.cancel()
  return true
}

export function removeDownload(id: string): boolean {
  if (items.has(id)) return false
  const before = list.length
  list = list.filter((d) => d.id !== id)
  thumbs.delete(id)
  if (list.length === before) return false
  save()
  return true
}

/** Очистить список; идущие загрузки остаются. */
export function clearDownloads(): void {
  list = list.filter((d) => items.has(d.id))
  thumbs.clear()
  save()
}

/** Скачать снова (файл удалили, загрузку отменили или она оборвалась): прежняя запись уступает место новой. */
export function retryDownload(id: string, ses: Session): boolean {
  const d = list.find((x) => x.id === id)
  if (!d || items.has(id) || !/^https?:\/\//i.test(d.url)) return false
  removeDownload(id)
  ses.downloadURL(d.url)
  return true
}

/** Миниатюра картинки из папки загрузок (средствами системы) — для строки на странице загрузок. */
export async function downloadThumb(id: string): Promise<string | null> {
  if (thumbs.has(id)) return thumbs.get(id) ?? null
  const d = list.find((x) => x.id === id)
  if (!d || d.state !== 'completed' || !IMAGE.test(d.path) || !fs.existsSync(d.path)) return null
  let url: string | null = null
  try {
    const img = await nativeImage.createThumbnailFromPath(d.path, { width: 96, height: 96 })
    url = img.isEmpty() ? null : img.toDataURL()
  } catch {
    url = null
  }
  thumbs.set(id, url)
  return url
}
