// Приложения-сайты (PWA) и веб-обработчики протоколов.
// «Установить как приложение» открывает сайт в собственном окне без интерфейса Masaki — с куками
// и входами общей сессии вкладок (сессионные preload'ы работают и тут, включая ключи доступа).
// Список приложений лежит в apps.json профиля; ярлык на рабочем столе создаёт PowerShell (.lnk
// со значком Masaki — у значков сайтов формат PNG, который ярлыки не берут).
// Обработчики протоколов: сайт просит navigator.registerProtocolHandler('web+…', '…?%s') —
// запоминаем, и ссылки на эту схему открываются на сайте-обработчике.

import { app, ipcMain, type BrowserWindow, type WebContents } from 'electron'
import { execFile } from 'child_process'
import crypto from 'crypto'
import path from 'path'
import { JsonFile } from './store'
import type { AppInfo, WebHandler } from '../shared/types'

interface AppRec {
  id: string
  url: string
  name: string
  /** Значок сайта, data: — для списка в настройках. */
  icon?: string
  t: number
}

interface Hooks {
  createWindow(url: string, name: string): BrowserWindow
  /** Открыть адрес вкладкой в главном окне (ссылки и новые окна из приложения). */
  openTab(url: string): void
  /** Запрос из окна интерфейса Masaki (не из приложения и не из страницы). */
  isUi(sender: WebContents): boolean
}

const appsFile = new JsonFile<{ v: 1; apps: AppRec[] }>('apps.json')
const handlersFile = new JsonFile<{ v: 1; handlers: WebHandler[] }>('protocol-handlers.json')
let apps: AppRec[] = []
let handlers: WebHandler[] = []
let hooks: Hooks
let exePath = ''

const load = async (): Promise<void> => {
  const a = await appsFile.read()
  if (a && Array.isArray(a.apps)) apps = a.apps
  const h = await handlersFile.read()
  if (h && Array.isArray(h.handlers)) handlers = h.handlers
}

const saveApps = (): void => {
  appsFile.write({ v: 1, apps }, 0)
}

const saveHandlers = (): void => {
  handlersFile.write({ v: 1, handlers }, 0)
}

const cleanName = (name: string): string => name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)

/** Окно приложения: сайт в собственной рамке, куки и входы — общей сессии вкладок. */
export function openAppWindow(rec: { url: string; name?: string }): BrowserWindow {
  const name = cleanName(rec.name ?? '') || new URL(rec.url).hostname
  const win = hooks.createWindow(rec.url, name)
  return win
}

/** --app=<адрес> из argv (ярлык приложения или второй запуск): окно приложения вместо/рядом с главным. */
export function appFromArgv(argv: string[]): string | null {
  for (const a of argv.slice(1)) {
    const m = /^--app=(.+)$/i.exec(a)
    if (m && /^https?:\/\//i.test(m[1])) return m[1]
  }
  return null
}

/** Открыть приложение по адресу из списка (по url) или новым окном, если его ещё нет в списке. */
export function launchApp(url: string, name?: string): void {
  const rec = apps.find((a) => a.url === url)
  openAppWindow({ url, name: rec?.name ?? name })
}

// ---------- Обработчики протоколов ----------

const SCHEME = /^web\+[a-z\d][a-z\d.+-]*$/i

/** Сайт просит стать обработчиком схемы (navigator.registerProtocolHandler). */
function registerHandler(origin: string, scheme: string, template: string, title: string): { ok: boolean; error?: string } {
  if (!SCHEME.test(scheme)) return { ok: false, error: 'Схема должна начинаться с web+' }
  try {
    const u = new URL(template, origin)
    if (u.origin !== origin) return { ok: false, error: 'Обработчик должен быть на сайте, который его регистрирует' }
    // %s может стоять в пути, запросе или хэше — проверяем весь адрес.
    if (!u.href.includes('%s')) return { ok: false, error: 'В адресе обработчика нет %s' }
    const clean = u.href
    if (!handlers.some((h) => h.scheme.toLowerCase() === scheme.toLowerCase() && h.origin === origin)) {
      handlers.push({ scheme: scheme.toLowerCase(), url: clean, origin, name: cleanName(title) || undefined, t: Date.now() })
      saveHandlers()
    }
    return { ok: true }
  } catch {
    return { ok: false, error: 'Неверный адрес обработчика' }
  }
}

/** Ссылку на зарегистрированную схему открывает сайт-обработчик (%s — адрес целиком). */
export function webHandlerFor(url: string): string | null {
  const m = /^([a-z][a-z\d.+-]+):/i.exec(url)
  if (!m) return null
  const h = handlers.find((x) => x.scheme.toLowerCase() === m[1].toLowerCase())
  if (!h) return null
  return h.url.replace('%s', encodeURIComponent(url))
}

export function listApps(): AppInfo[] {
  return apps.map((a) => ({ id: a.id, url: a.url, name: a.name, icon: a.icon }))
}

/** Ярлык на рабочем столе: PowerShell создаёт .lnk (bash/Node напрямую их не пишут). */
function createShortcut(rec: AppRec): Promise<{ ok: boolean; error?: string }> {
  const desktop = app.getPath('desktop')
  const safe = cleanName(rec.name) || new URL(rec.url).hostname
  const link = path.join(desktop, `${safe} (Masaki).lnk`)
  const script = `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${link.replace(/'/g, "''")}'); $s.TargetPath='${exePath.replace(/'/g, "''")}'; $s.Arguments='--app=${rec.url.replace(/'/g, "''")}'; $s.IconLocation='${exePath.replace(/'/g, "''")}'; $s.Save()`
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15_000, windowsHide: true }, (err) => {
      resolve(err ? { ok: false, error: 'PowerShell не создал ярлык: ' + err.message } : { ok: true })
    })
  })
}

export async function initApps(_partitionName: string, h: Hooks): Promise<void> {
  hooks = h
  exePath = process.execPath
  await load()
  const fromUi = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean => h.isUi(e.sender)

  ipcMain.handle('apps:list', (e) => (fromUi(e) ? listApps() : []))
  ipcMain.handle('apps:install', (e, url: unknown, name: unknown, icon: unknown) => {
    if (!fromUi(e) || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { ok: false, error: 'Нужен адрес сайта' }
    const rec: AppRec = {
      id: 'app' + crypto.randomBytes(6).toString('base64url'),
      url,
      name: cleanName(typeof name === 'string' && name ? name : new URL(url).hostname),
      icon: typeof icon === 'string' && icon.startsWith('data:image/') ? icon.slice(0, 500_000) : undefined,
      t: Date.now()
    }
    if (!apps.some((a) => a.url === url)) {
      apps.push(rec)
      saveApps()
    }
    launchApp(url, rec.name)
    return { ok: true }
  })
  ipcMain.on('apps:remove', (e, id: unknown) => {
    if (!fromUi(e) || typeof id !== 'string') return
    apps = apps.filter((a) => a.id !== id)
    saveApps()
  })
  ipcMain.handle('apps:shortcut', (e, id: unknown) => {
    if (!fromUi(e) || typeof id !== 'string') return { ok: false, error: 'Нет ярлыка' }
    const rec = apps.find((a) => a.id === id)
    return rec ? createShortcut(rec) : { ok: false, error: 'Приложение не найдено' }
  })

  ipcMain.handle('ph:list', (e) => (fromUi(e) ? handlers : []))
  ipcMain.on('ph:remove', (e, scheme: unknown, origin: unknown) => {
    if (!fromUi(e) || typeof scheme !== 'string' || typeof origin !== 'string') return
    handlers = handlers.filter((h) => !(h.scheme === scheme && h.origin === origin))
    saveHandlers()
  })
  // Регистрация от страницы: origin берём у фрейма, не со слов страницы. Безопасно и без окна —
  // просто запись в списке; управляют ею в настройках.
  ipcMain.handle('ph:register', (e, d: unknown) => {
    const frame = e.senderFrame
    const origin = frame?.origin ?? ''
    if (!origin || !/^https?:/.test(origin)) return { ok: false, error: 'Только https-сайты' }
    const x = (d ?? {}) as { scheme?: unknown; url?: unknown; title?: unknown }
    if (typeof x.scheme !== 'string' || typeof x.url !== 'string') return { ok: false, error: 'Нужны scheme и url' }
    return registerHandler(origin, x.scheme, x.url, typeof x.title === 'string' ? x.title : '')
  })
}

/** Не держим приложение открытым, когда все окна закрыты — это обычное поведение. */
export function flushApps(): void {
  appsFile.flushSync()
  handlersFile.flushSync()
}
