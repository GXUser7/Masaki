import { ipcMain, webContents, type BrowserWindow, type NavigationEntry, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { tabHasDownload } from './downloads'

interface Snapshot {
  entries: NavigationEntry[]
  index: number
  scroll: [number, number]
}
const saved = new Map<string, Snapshot>()
const RESUME = 'about:blank#masaki-resume='
let attachingKey: string | undefined
const restoring = new WeakMap<WebContents, string>()

/** Electron разрешает restore только до первой загрузки, даже about:blank считается загрузкой. */
export function prepareTabRestore(params: Record<string, string>): void {
  attachingKey = undefined
  if (!params.src?.startsWith(RESUME)) return
  attachingKey = params.src.slice(RESUME.length)
  params.src = ''
}

/** Создание гостя синхронно следует за will-attach-webview; загрузка начнётся только после attach. */
export function noteTabCreation(contents: WebContents): void {
  if (attachingKey) restoring.set(contents, attachingKey)
  attachingKey = undefined
}

export function restoreAttachedTab(contents: WebContents): void {
  const key = restoring.get(contents)
  if (!key) return
  restoring.delete(contents)
  const snapshot = saved.get(key)
  saved.delete(key)
  if (!snapshot) { void contents.loadURL('about:blank').catch(() => undefined); return }
  void contents.navigationHistory.restore({ entries: snapshot.entries, index: snapshot.index }).then(async () => {
    if (!contents.isDestroyed()) await contents.executeJavaScript(`scrollTo(${snapshot.scroll[0]}, ${snapshot.scroll[1]})`)
  }).catch(() => {
    if (!contents.isDestroyed()) void contents.loadURL(snapshot.entries[snapshot.index].url).catch(() => undefined)
  })
}

/** Состояние выгруженных страниц не пишется на диск и не отправляется в синхронизацию. */
export function initTabMemory(window: () => BrowserWindow | null): void {
  const protectedFrames = new Map<number, Set<string>>()
  const frameKey = (frame: Electron.WebFrameMain): string => `${frame.processId}:${frame.routingId}`
  const isProtected = (contents: WebContents): boolean =>
    contents.mainFrame.framesInSubtree.some((frame) => protectedFrames.get(contents.id)?.has(frameKey(frame)))
  ipcMain.on('tab-memory:protect', (event, value: unknown) => {
    const contents = event.sender
    if (contents.getType() !== 'webview' || contents.hostWebContents !== window()?.webContents || !event.senderFrame) return
    let frames = protectedFrames.get(contents.id)
    if (!frames) {
      frames = new Set()
      protectedFrames.set(contents.id, frames)
      contents.once('destroyed', () => protectedFrames.delete(contents.id))
    }
    const current = new Set(contents.mainFrame.framesInSubtree.map(frameKey))
    for (const key of frames) if (!current.has(key)) frames.delete(key)
    if (value === true) frames.add(frameKey(event.senderFrame))
    else frames.delete(frameKey(event.senderFrame))
  })
  const guest = (event: Electron.IpcMainInvokeEvent, id: unknown): WebContents | null => {
    if (event.sender !== window()?.webContents || typeof id !== 'number') return null
    const contents = webContents.fromId(id)
    return contents && !contents.isDestroyed() && contents.getType() === 'webview' &&
      contents.hostWebContents === event.sender ? contents : null
  }
  ipcMain.handle('tab-memory:save', async (event, id: unknown) => {
    const contents = guest(event, id)
    // isBeingCaptured() у встроенного webview бывает true из-за самого отображения в окне.
    // Камера/звонки защищены preload, PiP проверяется отдельно ниже.
    if (!contents || contents.isLoading() || contents.isCurrentlyAudible() || tabHasDownload(contents.id) || isProtected(contents)) return null
    const url = contents.getURL()
    // Служебные страницы автоматически не перезагружаем.
    if (!/^https?:\/\//i.test(url)) return null
    try {
      // Проверяем все фреймы: заполненная форма внутри iframe тоже должна остаться в памяти.
      const states = await Promise.all(contents.mainFrame.framesInSubtree.map((frame) => frame.executeJavaScript(`(() => ({
        blocked: !!document.pictureInPictureElement || [...document.querySelectorAll('input, textarea, select')].some(el =>
          el instanceof HTMLSelectElement ? [...el.options].some(o => o.selected !== o.defaultSelected) :
          el instanceof HTMLInputElement && /^(checkbox|radio)$/.test(el.type) ? el.checked !== el.defaultChecked :
          el.value !== el.defaultValue),
        scroll: [scrollX, scrollY]
      }))()`) as Promise<{ blocked: boolean; scroll: [number, number] }>))
      if (contents.isDestroyed() || contents.getURL() !== url || contents.isLoading() ||
          contents.isCurrentlyAudible() || tabHasDownload(contents.id) || isProtected(contents) || states.some((s) => s.blocked)) return null
      const entries = contents.navigationHistory.getAllEntries()
      if (!entries.length || entries.some((entry) => !/^https?:\/\//i.test(entry.url))) return null
      const key = randomUUID()
      saved.set(key, { entries, index: contents.navigationHistory.getActiveIndex(), scroll: states[0].scroll })
      return key
    } catch {
      // Смена документа или недоступный фрейм: пропускаем вкладку до следующей проверки.
      return null
    }
  })
  ipcMain.on('tab-memory:forget', (event, key: unknown) => {
    if (event.sender === window()?.webContents && typeof key === 'string') saved.delete(key)
  })
}
