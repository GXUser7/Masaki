// Расширения Chrome: API вкладок, кнопок, меню, сетевых правил (DNR/webRequest),
// userScripts, fontSettings, commands, жизненного цикла и установки из Chrome Web Store / .crx / .zip.
//
// Вкладки Masaki — webview в окне интерфейса: их webContents библиотека видит как вкладки этого окна.
// Создать, выбрать и закрыть вкладку по просьбе расширения может только интерфейс — главный процесс
// отправляет ему команды и ждёт, пока появится webview.

import {
  app,
  BrowserWindow,
  ipcMain,
  nativeImage,
  Notification,
  session,
  shell,
  webContents,
  type ContextMenuParams,
  type MenuItem,
  type Session,
  type WebContents
} from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { inflateRawSync } from 'node:zlib'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { installChromeWebStore, installExtension, uninstallExtension } from 'electron-chrome-web-store'
import type {
  Command,
  DownloadInfo,
  ExtensionInfo,
  ExtInstallPrompt,
  ExtMenuItem,
  HistoryEntry,
  Shortcut
} from '../shared/types'
import { testHeadless } from './testMode'
import * as extNet from './extNet'

const execFileAsync = promisify(execFile)

interface Hooks {
  session: Session
  win: () => BrowserWindow | null
  send: (c: Command) => void
  /** Спросить пользователя (окно в интерфейсе Masaki), ставить ли расширение из магазина. */
  confirmInstall: (p: ExtInstallPrompt) => Promise<boolean>
  /** Отключённые пользователем расширения: их Masaki не загружает. */
  disabled: () => string[]
  /** Список расширений поменялся — интерфейсу пора перечитать его. */
  changed: () => void
  onWebRequestTopologyChanged?: () => void
  historyList?: () => HistoryEntry[]
  clearHistory?: () => void
  favoritesList?: () => Shortcut[]
  setFavorites?: (f: Shortcut[]) => void
  downloadsList?: () => Promise<DownloadInfo[]>
  searchQuery?: (url: string) => void
}

let hooks: Hooks
let crx: ElectronChromeExtensions | null = null
let storeDir = ''
/** Пока Masaki сам сообщает библиотеке о вкладках, её «выбрать вкладку» не должно дёргать интерфейс. */
let internal = false
/** Ждут вкладку, которую попросило создать расширение (chrome.tabs.create). */
const waiting: ((wc: WebContents) => void)[] = []

/** Каждому расширению запоминаем отложенное событие жизненного цикла (install / update / startup). */
const pendingLifecycle = new Map<string, { installed?: { reason: 'install' | 'update'; previousVersion?: string }; startup?: boolean }>()
/** Состояние CSS, добавленных через chrome.tabs.insertCSS (wcId -> cssKey[]). */
const insertedCss = new Map<number, Map<string, string[]>>()
/** Зарегистрированные хоткеи расширений (accelerator -> { extId, command }). */
const commandBindings = new Map<string, { extId: string; command: string }[]>()
/** Разрешения в рамках chrome.action (enable/disable/textColor). */
const actionDisabled = new Set<string>() // extId или extId:tabId
const actionTextColor = new Map<string, string>()

const quiet = <T>(fn: () => T): T => {
  internal = true
  try {
    return fn()
  } finally {
    internal = false
  }
}

const aliveWin = (): BrowserWindow => {
  const w = hooks.win()
  if (!w || w.isDestroyed()) throw new Error('Окно Masaki закрыто')
  return w
}

function extensionPreloadPath(): string {
  const rel = path.join(__dirname, '../preload/extension.js')
  const unpacked = rel.replace(/app\.asar([\\/])/i, 'app.asar.unpacked$1')
  return fs.existsSync(unpacked) ? unpacked : rel
}

/** Новая вкладка по просьбе расширения: интерфейс откроет её, а webContents придёт в trackTab. */
function openTab(url: string, background: boolean): Promise<WebContents> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = waiting.indexOf(done)
      if (i >= 0) waiting.splice(i, 1)
      reject(new Error('Вкладка не открылась'))
    }, 10_000)
    const done = (wc: WebContents): void => {
      clearTimeout(timer)
      resolve(wc)
    }
    waiting.push(done)
    hooks.send({ type: 'open-url', url, background, eager: true })
  })
}

export async function initExtensions(h: Hooks): Promise<void> {
  hooks = h
  storeDir = path.join(app.getPath('userData'), 'Extensions')
  await extNet.initExtNet({
    onBadgeCount: (extId, tabId, text) => {
      const ba = (crx as unknown as { api?: { browserAction?: { getAction: (id: string) => { tabs: Record<string, Record<string, unknown>> }; onUpdate: () => void } } })?.api?.browserAction
      if (!ba) return
      const action = ba.getAction(extId)
      action.tabs[String(tabId)] = { ...(action.tabs[String(tabId)] ?? {}), text }
      ba.onUpdate()
    },
    onWebRequestEvent: (extId, listenerId, event, details, reqId) => {
      sendToExtension(extId, 'ext:wr-event', listenerId, event, details, reqId)
    },
    onTopologyChanged: h.onWebRequestTopologyChanged
  })

  crx = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: h.session,
    async createTab(details) {
      // У новой вкладки Masaki страницы нет (это интерфейс), а расширению нужна настоящая.
      const wc = await openTab(details.url || 'about:blank', details.active === false)
      return [wc, aliveWin()]
    },
    selectTab(wc) {
      if (!internal && !wc.isDestroyed()) hooks.send({ type: 'activate-wc', wcId: wc.id })
    },
    removeTab(wc) {
      if (!wc.isDestroyed()) hooks.send({ type: 'close-wc', wcId: wc.id })
    },
    async createWindow(details) {
      const urls = Array.isArray(details.url) ? details.url : details.url ? [details.url] : []
      // Окно-«попап» (вход, мастер настройки) — отдельным окном, как в Chrome; обычное окно — вкладками.
      if (details.type === 'popup' || details.type === 'panel') {
        const w = new BrowserWindow({
          show: !testHeadless,
          width: details.width ?? 480,
          height: details.height ?? 640,
          x: details.left,
          y: details.top,
          autoHideMenuBar: true,
          backgroundColor: '#ffffff',
          webPreferences: { session: h.session, sandbox: true, contextIsolation: true }
        })
        if (urls[0]) void w.loadURL(urls[0]).catch(() => undefined)
        return w
      }
      for (const u of urls) await openTab(u, false)
      return aliveWin()
    },
    async removeWindow(w) {
      // Главное окно расширение не закрывает — только свои попапы.
      if (w !== hooks.win() && !w.isDestroyed()) w.close()
    }
  })

  // Подменяем встроенный preload библиотеки нашим полным extension.js (без Object.freeze, с sync browser.*).
  for (const oldId of ['crx-mv2-preload', 'crx-mv3-preload']) {
    try {
      h.session.unregisterPreloadScript(oldId)
    } catch {
      // скрипт мог не существовать
    }
  }
  const preloadFile = extensionPreloadPath()
  h.session.registerPreloadScript({ id: 'masaki-ext-frame', type: 'frame', filePath: preloadFile })
  h.session.registerPreloadScript({ id: 'masaki-ext-sw', type: 'service-worker', filePath: preloadFile })

  // Подменяем дефолтный commands.getAll библиотеки на наш, чтобы отдавались настоящие сочетания клавиш.
  const router = (crx as unknown as { ctx?: { router?: { handle: (name: string, fn: (e: { extension: Electron.Extension }) => unknown) => void } } }).ctx?.router
  router?.handle('commands.getAll', ({ extension }) => readCommands(extension))

  // Пропатчиваем getState у BrowserActionAPI, чтобы интерфейс получал и цвет текста бейджа (textColor).
  const baApi = (crx as unknown as { api?: { browserAction?: { getState: () => { activeTabId?: number; actions: Record<string, unknown>[] } } } }).api?.browserAction
  if (baApi && typeof baApi.getState === 'function') {
    const origGetState = baApi.getState.bind(baApi)
    baApi.getState = () => {
      const st = origGetState()
      for (const act of st.actions) {
        const id = String(act.id ?? '')
        const globalColor = actionTextColor.get(id)
        if (globalColor) act.textColor = globalColor
        const tabs = (act.tabs as Record<string, Record<string, unknown>> | undefined) ?? {}
        for (const [tid, tabObj] of Object.entries(tabs)) {
          const tc = actionTextColor.get(`${id}:${tid}`)
          if (tc) tabObj.textColor = tc
        }
      }
      return st
    }
  }

  // Патчим contextMenus библиотеки, чтобы checkbox/radio передавали и переключали checked/wasChecked.
  const cmApi = (crx as unknown as {
    api?: {
      contextMenus?: {
        menus?: Map<string, Map<string, Record<string, unknown>>>
        buildMenuItem?: (opts: { extension: Electron.Extension; props: Record<string, unknown>; webContents: WebContents; params?: ContextMenuParams; showIcon?: boolean }) => Record<string, unknown>
        onClicked?: (extensionId: string, menuItemId: string, wc: WebContents, params?: ContextMenuParams) => void
      }
    }
    ctx?: {
      router?: { sendEvent: (extId: string, ev: string, ...args: unknown[]) => void }
      store?: { tabDetailsCache: Map<number, unknown> }
    }
  })
  if (cmApi.api?.contextMenus) {
    const cm = cmApi.api.contextMenus
    const origBuild = cm.buildMenuItem
    if (origBuild) {
      cm.buildMenuItem = (opts) => {
        const res = origBuild(opts)
        if (opts.props.type === 'checkbox' || opts.props.type === 'radio') res.checked = !!opts.props.checked
        return res
      }
    }
    cm.onClicked = (extensionId, menuItemId, wc, params) => {
      if (wc.isDestroyed()) return
      const tab = cmApi.ctx?.store?.tabDetailsCache.get(wc.id)
      if (!tab) return
      const extMenus = cm.menus?.get(extensionId)
      const props = extMenus?.get(menuItemId)
      const wasChecked = !!props?.checked
      let checked = wasChecked
      if (props?.type === 'checkbox') {
        checked = !wasChecked
        props.checked = checked
      } else if (props?.type === 'radio') {
        if (extMenus) {
          for (const item of extMenus.values()) if (item.type === 'radio') item.checked = false
        }
        checked = true
        props.checked = true
      }
      cmApi.ctx?.router?.sendEvent(
        extensionId,
        'contextMenus.onClicked',
        {
          selectionText: params?.selectionText,
          checked,
          wasChecked,
          menuItemId,
          frameId: 0,
          frameUrl: params?.frameURL,
          editable: params?.isEditable || false,
          mediaType: params?.mediaType,
          pageUrl: params?.pageURL,
          linkUrl: params?.linkURL,
          srcUrl: params?.srcURL
        },
        tab
      )
    }
  }

  // Размер всплывающего окна библиотека узнаёт из preferred-size-changed и до него окно не показывает.
  // Если события нет (под автоматизацией Chromium его не шлёт), меряем страницу окна сами.
  crx.on('browser-action-popup-created', (popup: { browserWindow?: BrowserWindow; whenReady(): Promise<void>; isDestroyed(): boolean }) => {
    const w = popup.browserWindow
    if (!w) return
    let sized = false
    w.webContents.once('preferred-size-changed', () => (sized = true))
    void popup.whenReady().then(() =>
      setTimeout(async () => {
        if (sized || popup.isDestroyed() || w.isDestroyed()) return
        const size = await w.webContents
          .executeJavaScript('({ width: Math.ceil(document.documentElement.scrollWidth), height: Math.ceil(document.documentElement.scrollHeight) })')
          .catch(() => null)
        if (size && !w.isDestroyed()) w.webContents.emit('preferred-size-changed', {}, size)
      }, 500)
    )
  })

  registerExtensionIpc(h.session)

  // Значки кнопок расширений интерфейс (окно в сессии по умолчанию) берёт по адресу crx://extension-icon/….
  ElectronChromeExtensions.handleCRXProtocol(session.defaultSession)
  const ext = h.session.extensions
  ext.on('extension-loaded', (_e, extension) => {
    onExtensionLoaded(h.session, extension)
    h.changed()
  })
  ext.on('extension-unloaded', (_e, extension) => {
    extNet.clearExtensionRuntime(extension.id, false)
    pendingLifecycle.delete(extension.id)
    rebuildCommandBindings(h.session)
    h.changed()
  })

  await installChromeWebStore({
    session: h.session,
    extensionsPath: storeDir,
    autoUpdate: true,
    // Отключённые расширения ниже снимаем; распакованные Masaki загружает сам (настройка addons.extensions).
    loadExtensions: true,
    allowUnpackedExtensions: false,
    minimumManifestVersion: 2,
    async beforeInstall(d) {
      const m = d.manifest as Manifest
      const ok = await h.confirmInstall({
        id: d.id,
        name: d.localizedName || resolveLocalized(null, m?.name, m) || d.id,
        icon: d.icon.isEmpty() ? undefined : d.icon.resize({ width: 64 }).toDataURL(),
        permissions: describePermissions(m)
      })
      return { action: ok ? 'allow' : 'deny' }
    }
  })

  for (const id of h.disabled()) if (ext.getExtension(id)) ext.removeExtension(id)
  for (const loaded of ext.getAllExtensions()) onExtensionLoaded(h.session, loaded)
}

function sendToExtension(extId: string, channel: string, ...args: unknown[]): void {
  const ses = hooks.session
  const prefix = `chrome-extension://${extId}/`
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed() && wc.session === ses && wc.getURL().startsWith(prefix)) {
      try {
        wc.send(channel, ...args)
      } catch {
        // страница могла закрыться
      }
    }
  }
  const sws = ses.serviceWorkers.getAllRunning()
  for (const info of Object.values(sws)) {
    if (info.scope === prefix) {
      const sw = ses.serviceWorkers.getWorkerFromVersionID(info.versionId)
      try {
        sw?.send(channel, ...args)
      } catch {
        // воркер остановлен
      }
    }
  }
}

function onExtensionLoaded(ses: Session, extension: Electron.Extension): void {
  extNet.registerExtensionDnr(extension)
  rebuildCommandBindings(ses)

  // Вычисляем событие жизненного цикла: первая установка, обновление версии или запуск браузера.
  const prev = extNet.getStoredState(extension.id)
  if (!prev.version) {
    pendingLifecycle.set(extension.id, { installed: { reason: 'install' } })
    extNet.updateStoredState(extension.id, { version: extension.version })
  } else if (prev.version !== extension.version) {
    pendingLifecycle.set(extension.id, { installed: { reason: 'update', previousVersion: prev.version } })
    extNet.updateStoredState(extension.id, { version: extension.version })
  } else {
    pendingLifecycle.set(extension.id, { startup: true })
  }

  // Будим Service Worker MV3, чтобы отработали onInstalled/onStartup, DNR и меню даже без открытия попапа.
  const m = extension.manifest as { background?: { service_worker?: string } }
  if (m?.background?.service_worker) {
    const scope = `chrome-extension://${extension.id}/`
    void ses.serviceWorkers.startWorkerForScope(scope).catch(() => undefined)
  }
}

// ---------- Горячие клавиши расширений (chrome.commands) ----------

function readCommands(ext: Electron.Extension): { name: string; description?: string; shortcut?: string }[] {
  const m = ext.manifest as Manifest | undefined
  if (!m?.commands) return []
  const plat = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux'
  const out: { name: string; description?: string; shortcut?: string }[] = []
  for (const [name, details] of Object.entries(m.commands)) {
    const sk = details.suggested_key
    const shortcut = sk?.[plat] || sk?.default || ''
    const desc = resolveLocalized(ext.path, details.description, m)
    out.push({ name, description: desc, shortcut })
  }
  return out
}

function normalizeShortcutKey(raw: string): string {
  if (!raw) return ''
  const parts = raw
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
  let ctrl = false
  let shift = false
  let alt = false
  let key = ''
  for (const p of parts) {
    if (p === 'ctrl' || p === 'command' || p === 'macctrl' || p === 'commandorcontrol') ctrl = true
    else if (p === 'shift') shift = true
    else if (p === 'alt') alt = true
    else key = p
  }
  if (!key) return ''
  const keyCode =
    key.length === 1 && /[a-z]/i.test(key)
      ? 'Key' + key.toUpperCase()
      : key.length === 1 && /[0-9]/.test(key)
        ? 'Digit' + key
        : key === 'comma'
          ? 'Comma'
          : key === 'period'
            ? 'Period'
            : key === 'space'
              ? 'Space'
              : key === 'up'
                ? 'ArrowUp'
                : key === 'down'
                  ? 'ArrowDown'
                  : key === 'left'
                    ? 'ArrowLeft'
                    : key === 'right'
                      ? 'ArrowRight'
                      : key.toUpperCase()
  return `${ctrl ? 'C' : ''}${shift ? 'S' : ''}${alt ? 'A' : ''}:${keyCode}`
}

function rebuildCommandBindings(ses: Session): void {
  commandBindings.clear()
  for (const ext of ses.extensions.getAllExtensions()) {
    for (const c of readCommands(ext)) {
      if (!c.shortcut) continue
      const norm = normalizeShortcutKey(c.shortcut)
      if (!norm) continue
      const list = commandBindings.get(norm) ?? []
      list.push({ extId: ext.id, command: c.name })
      commandBindings.set(norm, list)
    }
  }
}

export function handleCommandShortcut(input: {
  code?: string
  key?: string
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
}): boolean {
  if (!crx || commandBindings.size === 0) return false
  let code = input.code || ''
  if (!code && input.key) {
    if (input.key.length === 1 && /[a-z]/i.test(input.key)) code = 'Key' + input.key.toUpperCase()
    else if (input.key.length === 1 && /[0-9]/.test(input.key)) code = 'Digit' + input.key
    else code = input.key
  }
  if (!code) return false
  const ctrl = input.ctrl || input.meta
  const key = `${ctrl ? 'C' : ''}${input.shift ? 'S' : ''}${input.alt ? 'A' : ''}:${code}`
  const list = commandBindings.get(key)
  if (!list?.length) return false

  const store = (crx as unknown as {
    ctx?: {
      store?: { getActiveTabOfCurrentWindow: () => WebContents | undefined; tabDetailsCache: Map<number, unknown> }
      router?: { sendEvent: (extId: string, ev: string, ...args: unknown[]) => void }
    }
    api?: {
      browserAction?: {
        activateClick: (d: {
          eventType: string
          extensionId: string
          tabId: number
          anchorRect: { x: number; y: number; width: number; height: number }
        }) => void
      }
    }
  }).ctx
  const ba = (crx as unknown as {
    api?: {
      browserAction?: {
        activateClick: (d: {
          eventType: string
          extensionId: string
          tabId: number
          anchorRect: { x: number; y: number; width: number; height: number }
        }) => void
      }
    }
  }).api?.browserAction
  const activeTab = store?.store?.getActiveTabOfCurrentWindow()
  const tabDetails = activeTab ? store?.store?.tabDetailsCache.get(activeTab.id) : undefined
  const w = hooks.win()

  for (const item of list) {
    if (item.command === '_execute_action' || item.command === '_execute_browser_action') {
      if (ba && activeTab && w && !w.isDestroyed()) {
        const [width] = w.getSize()
        ba.activateClick({
          eventType: 'click',
          extensionId: item.extId,
          tabId: activeTab.id,
          anchorRect: { x: Math.max(120, width - 380), y: 40, width: 32, height: 32 }
        })
      }
    } else {
      store?.router?.sendEvent(item.extId, 'commands.onCommand', item.command, tabDetails)
    }
  }
  return true
}

// ---------- userScripts (для Violentmonkey, Tampermonkey, uBOL, AdGuard) ----------

function isInsideDir(targetPath: string, parentDir: string): boolean {
  const rel = path.relative(path.resolve(parentDir), path.resolve(targetPath))
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function matchPatternToRegex(pattern: string): RegExp | null {
  if (pattern === '<all_urls>') return /^(https?|file|ftp):\/\/.*/i
  const m = /^(\*|https?|file|ftp):\/\/(\*|\*\.[^/]+|[^/]+)(\/.*)$/i.exec(pattern)
  if (!m) return null
  const scheme = m[1] === '*' ? 'https?' : m[1]
  const rawHost = m[2]
  let host = rawHost
  if (host === '*') host = '[^/]+'
  else if (host.startsWith('*.')) host = '(?:[^/]+\\.)?' + host.slice(2).replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  else host = host.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const portPart = rawHost === '*' || rawHost.includes(':') ? '' : '(?::\\d+)?'
  const pathPart = m[3].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  try {
    return new RegExp(`^${scheme}://${host}${portPart}${pathPart}$`, 'i')
  } catch {
    return null
  }
}

function globMatches(glob: string, url: string): boolean {
  const re = new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
  return re.test(url)
}

function userScriptMatchesUrl(script: extNet.StoredUserScript, url: string): boolean {
  if (!/^https?:/i.test(url)) return false
  if (script.excludeMatches?.some((p) => matchPatternToRegex(p)?.test(url))) return false
  if (script.excludeGlobs?.some((g) => globMatches(g, url))) return false
  const okMatch = script.matches?.length ? script.matches.some((p) => matchPatternToRegex(p)?.test(url)) : false
  const okGlob = script.includeGlobs?.length ? script.includeGlobs.some((g) => globMatches(g, url)) : true
  return okMatch && okGlob
}

function readScriptSources(extPath: string, sources?: { file?: string; code?: string }[]): string[] {
  if (!sources?.length) return []
  const out: string[] = []
  for (const s of sources) {
    if (typeof s.code === 'string') {
      out.push(s.code)
    } else if (typeof s.file === 'string') {
      try {
        const resolved = path.resolve(extPath, s.file.replace(/^\//, ''))
        if (isInsideDir(resolved, extPath)) out.push(fs.readFileSync(resolved, 'utf8'))
      } catch {
        // файл скрипта отсутствует
      }
    }
  }
  return out
}

function isolatedUserScriptWrapper(code: string): string {
  // На WebFrameMain в Electron 44 нет executeJavaScriptInIsolatedWorld, поэтому изолируем скрипт
  // от глобального мира страницы замыканием (для MAIN world код выполняется напрямую).
  return `;(() => {\n${code}\n})();`
}

async function runUserScriptsForPhase(wc: WebContents, phase: 'document_start' | 'document_end' | 'document_idle'): Promise<void> {
  if (wc.isDestroyed()) return
  const url = wc.getURL()
  if (!/^https?:/i.test(url)) return
  for (const ext of hooks.session.extensions.getAllExtensions()) {
    const scripts = extNet.getStoredState(ext.id).userScripts
    if (!scripts?.length) continue
    for (const script of scripts) {
      const runAt = script.runAt ?? 'document_idle'
      if (runAt !== phase || !userScriptMatchesUrl(script, url)) continue
      for (const css of readScriptSources(ext.path, script.css)) {
        void wc.insertCSS(css, { cssOrigin: 'user' }).catch(() => undefined)
      }
      for (const code of readScriptSources(ext.path, script.js)) {
        const frames = script.allFrames ? wc.mainFrame.framesInSubtree : [wc.mainFrame]
        const wrapped = script.world === 'MAIN' ? code : isolatedUserScriptWrapper(code)
        for (const frame of frames) {
          void frame.executeJavaScript(wrapped, false).catch(() => undefined)
        }
      }
    }
  }
}

// ---------- Системные шрифты (для fontSettings в Dark Reader и др.) ----------

let cachedFonts: { fontId: string; displayName: string }[] | null = null

async function getSystemFontList(): Promise<{ fontId: string; displayName: string }[]> {
  if (cachedFonts) return cachedFonts
  const names = new Set<string>(['Arial', 'Calibri', 'Cambria', 'Consolas', 'Courier New', 'Georgia', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'])
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'], { timeout: 3000 })
      for (const line of stdout.split(/\r?\n/)) {
        const m = /^\s*(.+?)\s+\((?:TrueType|OpenType|All Res)\)\s+REG_SZ/i.exec(line)
        if (m?.[1]) {
          const clean = m[1].replace(/\s+(Regular|Bold|Italic|Light|Medium|Semibold)$/i, '').trim()
          if (clean) names.add(clean)
        }
      }
    } catch {
      // оставляем базовый набор шрифтов Windows
    }
  }
  cachedFonts = [...names].sort((a, b) => a.localeCompare(b)).map((f) => ({ fontId: f, displayName: f }))
  return cachedFonts
}

// ---------- IPC расширений (DNR, webRequest, жизненный цикл, ext:api) ----------

function callerExtension(ses: Session, event: { type?: string; sender?: WebContents; serviceWorker?: { scope?: string } }, extId?: string): Electron.Extension | null {
  if (!extId) {
    try {
      const rawUrl = event.type === 'service-worker' ? event.serviceWorker?.scope : event.sender?.getURL?.()
      if (rawUrl) {
        const u = new URL(rawUrl)
        if (u.protocol === 'chrome-extension:') extId = u.hostname
      }
    } catch {
      return null
    }
  }
  return extId ? ses.extensions.getExtension(extId) ?? null : null
}

function registerExtensionIpc(ses: Session): void {
  const onLifecycleReady = (_e: unknown, extId: unknown) => {
    if (typeof extId !== 'string' || !extId) return null
    const pending = pendingLifecycle.get(extId)
    if (!pending) return null
    pendingLifecycle.delete(extId)
    return pending
  }
  const onDnrSync = (e: { type?: string; sender?: WebContents; serviceWorker?: { scope?: string } }, extId: unknown, payload: unknown) => {
    const ext = callerExtension(ses, e, typeof extId === 'string' ? extId : undefined)
    if (!ext || !payload || typeof payload !== 'object') return false
    extNet.syncDnrFromExtension(ext, payload as Parameters<typeof extNet.syncDnrFromExtension>[1])
    return true
  }
  const onDnrMatched = (e: { type?: string; sender?: WebContents; serviceWorker?: { scope?: string } }, extId: unknown, filter: unknown) => {
    const ext = callerExtension(ses, e, typeof extId === 'string' ? extId : undefined)
    if (!ext) return { rulesMatchedInfo: [] }
    return {
      rulesMatchedInfo: extNet.getMatchedRulesForExtension(
        ext.id,
        filter && typeof filter === 'object' ? (filter as { tabId?: number; minTimeStamp?: number }) : undefined
      )
    }
  }
  const onWrAdd = (e: { type?: string; sender?: WebContents; serviceWorker?: { scope?: string } }, extId: unknown, payload: unknown) => {
    const ext = callerExtension(ses, e, typeof extId === 'string' ? extId : undefined)
    if (!ext || !payload || typeof payload !== 'object') return
    extNet.registerWebRequestListener(ext.id, payload as Parameters<typeof extNet.registerWebRequestListener>[1])
  }
  const onWrRemove = (e: { type?: string; sender?: WebContents; serviceWorker?: { scope?: string } }, extId: unknown, listenerId: unknown) => {
    const ext = callerExtension(ses, e, typeof extId === 'string' ? extId : undefined)
    if (!ext) return
    extNet.unregisterWebRequestListener(ext.id, typeof listenerId === 'string' ? listenerId : undefined)
  }
  const onWrAnswer = (_e: unknown, reqId: unknown, res: unknown) => {
    if (typeof reqId === 'string') extNet.answerWebRequestBlocking(reqId, res)
  }
  const onExtApi = async (e: { type?: string; sender?: WebContents; serviceWorker?: { scope?: string } }, extId: unknown, method: unknown, ...args: unknown[]) => {
    const ext = callerExtension(ses, e, typeof extId === 'string' ? extId : undefined)
    if (!ext || typeof method !== 'string') return undefined
    return dispatchExtApi(ses, ext, method, args)
  }

  // Обработчики для страниц расширений (frame через ipcMain)
  ipcMain.handle('ext:lifecycle-ready', onLifecycleReady)
  ipcMain.handle('ext:dnr-sync', onDnrSync)
  ipcMain.handle('ext:dnr-matched', onDnrMatched)
  ipcMain.on('ext:wr-add', onWrAdd)
  ipcMain.on('ext:wr-remove', onWrRemove)
  ipcMain.on('ext:wr-answer', onWrAnswer)
  ipcMain.handle('ext:api', onExtApi)

  // В Electron 44 IPC из Service Worker (serviceWorker.ipc) НЕ доходит до глобального ipcMain —
  // нужно подключаться к sw.ipc каждого запускающегося воркера chrome-extension://!
  // Слушаем до загрузки любого расширения, включая все уже стартовавшие воркеры на данный момент.
  const hookedWorkers = new WeakSet<object>()
  const hookWorker = (sw: Electron.ServiceWorkerMain | undefined): void => {
    if (!sw?.scope?.startsWith('chrome-extension://') || hookedWorkers.has(sw)) return
    hookedWorkers.add(sw)
    sw.ipc.handle('ext:lifecycle-ready', (e, extId) => onLifecycleReady(e, extId))
    sw.ipc.handle('ext:dnr-sync', (e, extId, payload) => onDnrSync(e, extId, payload))
    sw.ipc.handle('ext:dnr-matched', (e, extId, filter) => onDnrMatched(e, extId, filter))
    sw.ipc.on('ext:wr-add', (e, extId, payload) => onWrAdd(e, extId, payload))
    sw.ipc.on('ext:wr-remove', (e, extId, listenerId) => onWrRemove(e, extId, listenerId))
    sw.ipc.on('ext:wr-answer', (e, reqId, res) => onWrAnswer(e, reqId, res))
    sw.ipc.handle('ext:api', (e, extId, method, ...args) => onExtApi(e, extId, method, ...args))
  }
  for (const info of Object.values(ses.serviceWorkers.getAllRunning())) {
    hookWorker(ses.serviceWorkers.getWorkerFromVersionID(info.versionId))
  }
  ses.serviceWorkers.on('running-status-changed', ({ runningStatus, versionId }) => {
    if (runningStatus === 'starting' || runningStatus === 'running') {
      hookWorker(ses.serviceWorkers.getWorkerFromVersionID(versionId))
    }
  })
}

async function dispatchExtApi(ses: Session, ext: Electron.Extension, method: string, args: unknown[]): Promise<unknown> {
  const store = (crx as unknown as {
    ctx?: {
      store?: {
        getTabById: (id: number) => WebContents | undefined
        getActiveTabOfCurrentWindow: () => WebContents | undefined
        createTab: (d: { url?: string; active?: boolean }) => Promise<WebContents>
      }
      router?: { sendEvent: (extId: string, ev: string, ...a: unknown[]) => void }
    }
    api?: {
      browserAction?: {
        onUpdate: () => void
        ctx?: unknown
      }
      contextMenus?: {
        menus?: Map<string, Map<string, Record<string, unknown>>>
      }
      tabs?: {
        getTabDetails: (wc: WebContents) => unknown
        onUpdated: (id: number) => void
        onActivated: (id: number) => void
      }
    }
  })
  const getTab = (tabId?: unknown): WebContents | undefined =>
    typeof tabId === 'number' ? store.ctx?.store?.getTabById(tabId) : store.ctx?.store?.getActiveTabOfCurrentWindow()

  switch (method) {
    case 'dnr.getEnabledRulesets':
      return extNet.getEnabledRulesetsForExtension(ext.id)
    case 'dnr.getDisabledRuleIds':
      return extNet.getDisabledRuleIdsForExtension(ext.id, String((args[0] as { rulesetId?: string } | undefined)?.rulesetId ?? ''))

    case 'fontSettings.getFontList':
      return getSystemFontList()
    case 'fontSettings.getFont':
      return { fontId: '', levelOfControl: 'controllable_by_this_extension' }
    case 'fontSettings.setFont':
    case 'fontSettings.clearFont':
    case 'fontSettings.setDefaultFontSize':
    case 'fontSettings.setDefaultFixedFontSize':
    case 'fontSettings.setMinimumFontSize':
      return undefined

    case 'tabs.captureVisibleTab': {
      const target = getTab()
      if (!target || target.isDestroyed()) return undefined
      const opts = (typeof args[1] === 'object' ? args[1] : typeof args[0] === 'object' ? args[0] : {}) as {
        format?: 'png' | 'jpeg'
        quality?: number
      }
      const img = await Promise.race([target.capturePage(), new Promise<null>((r) => setTimeout(() => r(null), 3000))])
      if (!img || img.isEmpty()) return undefined
      return opts.format === 'jpeg' ? `data:image/jpeg;base64,${img.toJPEG(opts.quality ?? 92).toString('base64')}` : img.toDataURL()
    }

    case 'tabs.update': {
      const tabId = typeof args[0] === 'number' ? args[0] : undefined
      const props = (typeof args[0] === 'object' ? args[0] : args[1]) as { url?: string; muted?: boolean; active?: boolean } | undefined
      const tab = getTab(tabId)
      if (!tab || tab.isDestroyed()) return undefined
      if (props?.url && !/^(chrome|javascript):/i.test(props.url)) {
        const targetUrl = new URL(props.url, ext.url).href
        // Не роняем промис при прерванном переходе (ERR_ABORTED) или редиректе
        await tab.loadURL(targetUrl).catch(() => undefined)
      }
      if (typeof props?.muted === 'boolean') tab.setAudioMuted(props.muted)
      if (props?.active) {
        hooks.send({ type: 'activate-wc', wcId: tab.id })
        store.api?.tabs?.onActivated(tab.id)
      }
      store.api?.tabs?.onUpdated(tab.id)
      return store.api?.tabs?.getTabDetails(tab)
    }

    case 'tabs.move':
    case 'tabs.highlight':
    case 'tabs.discard':
    case 'tabs.group':
    case 'tabs.ungroup':
      return getTab(args[0]) ? store.api?.tabs?.getTabDetails(getTab(args[0])!) : undefined

    case 'tabs.duplicate': {
      const tab = getTab(args[0])
      if (!tab || tab.isDestroyed()) return undefined
      const created = await store.ctx?.store?.createTab({ url: tab.getURL(), active: true })
      return created ? store.api?.tabs?.getTabDetails(created) : undefined
    }

    case 'tabs.insertCSS': {
      const tabId = typeof args[0] === 'number' ? args[0] : undefined
      const details = (typeof args[0] === 'object' ? args[0] : args[1]) as {
        code?: string
        file?: string
        cssOrigin?: 'author' | 'user'
        allFrames?: boolean
      }
      const tab = getTab(tabId)
      if (!tab || tab.isDestroyed() || !details) return undefined
      let css = details.code
      if (!css && details.file) {
        try {
          const p = path.resolve(ext.path, details.file.replace(/^\//, ''))
          if (isInsideDir(p, ext.path)) css = fs.readFileSync(p, 'utf8')
        } catch {
          return undefined
        }
      }
      if (!css) return undefined
      const key = await tab.insertCSS(css, { cssOrigin: details.cssOrigin === 'user' ? 'user' : 'author' }).catch(() => null)
      if (key) {
        let byExt = insertedCss.get(tab.id)
        if (!byExt) {
          byExt = new Map()
          insertedCss.set(tab.id, byExt)
          tab.once('destroyed', () => insertedCss.delete(tab.id))
        }
        const keys = byExt.get(ext.id) ?? []
        keys.push(key)
        byExt.set(ext.id, keys)
      }
      return undefined
    }

    case 'tabs.removeCSS': {
      const tabId = typeof args[0] === 'number' ? args[0] : undefined
      const tab = getTab(tabId)
      if (!tab || tab.isDestroyed()) return undefined
      const keys = insertedCss.get(tab.id)?.get(ext.id)
      if (keys?.length) {
        for (const k of keys) await tab.removeInsertedCSS(k).catch(() => undefined)
        insertedCss.get(tab.id)?.delete(ext.id)
      }
      return undefined
    }

    case 'tabs.detectLanguage':
      return 'und'

    case 'contextMenus.update': {
      const id = String(args[0] ?? '')
      const props = (args[1] ?? {}) as Record<string, unknown>
      const itemMap = store.api?.contextMenus?.menus?.get(ext.id)
      const existing = itemMap?.get(id)
      if (existing) Object.assign(existing, props)
      return undefined
    }

    case 'action.setBadgeTextColor': {
      const d = (args[0] ?? {}) as { color?: string | number[]; tabId?: number }
      const color = Array.isArray(d.color) ? `rgba(${d.color[0]},${d.color[1]},${d.color[2]},${(d.color[3] ?? 255) / 255})` : d.color
      if (typeof color === 'string') {
        actionTextColor.set(typeof d.tabId === 'number' ? `${ext.id}:${d.tabId}` : ext.id, color)
        store.api?.browserAction?.onUpdate()
      }
      return undefined
    }

    case 'action.getBadgeTextColor': {
      const d = (args[0] ?? {}) as { tabId?: number }
      return actionTextColor.get(typeof d.tabId === 'number' ? `${ext.id}:${d.tabId}` : ext.id) ?? '#ffffff'
    }

    case 'action.enable':
    case 'action.disable': {
      const tabId = typeof args[0] === 'number' ? args[0] : undefined
      const k = typeof tabId === 'number' ? `${ext.id}:${tabId}` : ext.id
      if (method === 'action.disable') actionDisabled.add(k)
      else actionDisabled.delete(k)
      return undefined
    }

    case 'action.isEnabled': {
      const d = (args[0] ?? {}) as { tabId?: number }
      if (actionDisabled.has(ext.id)) return false
      if (typeof d.tabId === 'number' && actionDisabled.has(`${ext.id}:${d.tabId}`)) return false
      return true
    }

    case 'extension.isAllowedIncognitoAccess':
      return false
    case 'extension.isAllowedFileSchemeAccess':
      return true

    case 'notifications.create': {
      const id = typeof args[0] === 'string' ? args[0] : randomUUID()
      const opts = (typeof args[0] === 'object' ? args[0] : args[1]) as {
        title?: string
        message?: string
        iconUrl?: string
        silent?: boolean
      }
      if (!opts?.title && !opts?.message) return id
      let iconPath: string | undefined
      if (opts.iconUrl) {
        const clean = opts.iconUrl.replace(new RegExp(`^chrome-extension://${ext.id}/`, 'i'), '').replace(/^\//, '')
        const candidate = path.resolve(ext.path, clean)
        if (isInsideDir(candidate, ext.path) && fs.existsSync(candidate)) iconPath = candidate
      }
      const n = new Notification({ title: opts.title || ext.name, body: opts.message || '', icon: iconPath, silent: opts.silent })
      n.on('click', () => store.ctx?.router?.sendEvent(ext.id, 'notifications.onClicked', id))
      n.once('close', () => store.ctx?.router?.sendEvent(ext.id, 'notifications.onClosed', id, true))
      n.show()
      return id
    }

    case 'userScripts.register': {
      const scripts = Array.isArray(args[0]) ? (args[0] as extNet.StoredUserScript[]) : []
      const prev = extNet.getStoredState(ext.id).userScripts ?? []
      const map = new Map(prev.map((s) => [s.id, s]))
      for (const s of scripts) if (s?.id) map.set(s.id, s)
      extNet.updateStoredState(ext.id, { userScripts: [...map.values()] })
      return undefined
    }

    case 'userScripts.unregister': {
      const filter = (args[0] ?? {}) as { ids?: string[] }
      const prev = extNet.getStoredState(ext.id).userScripts ?? []
      const next = filter.ids?.length ? prev.filter((s) => !filter.ids!.includes(s.id)) : []
      extNet.updateStoredState(ext.id, { userScripts: next })
      return undefined
    }

    case 'userScripts.update': {
      const updates = Array.isArray(args[0]) ? (args[0] as extNet.StoredUserScript[]) : []
      const prev = extNet.getStoredState(ext.id).userScripts ?? []
      const map = new Map(prev.map((s) => [s.id, s]))
      for (const u of updates) if (u?.id) map.set(u.id, { ...(map.get(u.id) ?? {}), ...u })
      extNet.updateStoredState(ext.id, { userScripts: [...map.values()] })
      return undefined
    }

    case 'userScripts.getScripts': {
      const filter = (args[0] ?? {}) as { ids?: string[] }
      const list = extNet.getStoredState(ext.id).userScripts ?? []
      return filter.ids?.length ? list.filter((s) => filter.ids!.includes(s.id)) : list
    }

    case 'userScripts.configureWorld': {
      const opts = (args[0] ?? {}) as { worldId?: string; csp?: string; messaging?: boolean }
      const prev = extNet.getStoredState(ext.id).userScriptWorld ?? {}
      prev[opts.worldId ?? ''] = { csp: opts.csp, messaging: opts.messaging }
      extNet.updateStoredState(ext.id, { userScriptWorld: prev })
      return undefined
    }

    case 'userScripts.getWorldConfigurations': {
      const map = extNet.getStoredState(ext.id).userScriptWorld ?? {}
      return Object.entries(map).map(([worldId, cfg]) => ({ ...(worldId ? { worldId } : {}), ...cfg }))
    }

    case 'userScripts.resetWorldConfiguration': {
      const worldId = typeof args[0] === 'string' ? args[0] : ''
      const prev = extNet.getStoredState(ext.id).userScriptWorld ?? {}
      delete prev[worldId]
      extNet.updateStoredState(ext.id, { userScriptWorld: prev })
      return undefined
    }

    case 'userScripts.execute': {
      const inj = (args[0] ?? {}) as { target?: { tabId?: number }; world?: 'MAIN' | 'USER_SCRIPT'; js?: { file?: string; code?: string }[] }
      const tab = getTab(inj.target?.tabId)
      if (!tab || tab.isDestroyed()) return []
      const results: { result: unknown }[] = []
      for (const code of readScriptSources(ext.path, inj.js)) {
        const wrapped = inj.world === 'MAIN' ? code : isolatedUserScriptWrapper(code)
        const res = await tab.mainFrame.executeJavaScript(wrapped, false).catch(() => undefined)
        results.push({ result: res })
      }
      return results
    }

    case 'identity.launchWebAuthFlow': {
      const opts = (args[0] ?? {}) as { url?: string; interactive?: boolean }
      if (!opts.url) throw new Error('Требуется url для launchWebAuthFlow')
      const redirectPrefix = `https://${ext.id}.chromiumapp.org`
      return new Promise<string>((resolve, reject) => {
        const authWin = new BrowserWindow({
          show: opts.interactive !== false && !testHeadless,
          width: 520,
          height: 680,
          parent: hooks.win() ?? undefined,
          autoHideMenuBar: true,
          webPreferences: { session: ses, sandbox: true, contextIsolation: true }
        })
        let settled = false
        const done = (err: Error | null, res?: string): void => {
          if (settled) return
          settled = true
          if (!authWin.isDestroyed()) authWin.close()
          if (err) reject(err)
          else resolve(res!)
        }
        const checkUrl = (target: string): boolean => {
          if (target.startsWith(redirectPrefix)) {
            done(null, target)
            return true
          }
          return false
        }
        authWin.webContents.on('will-redirect', (ev, u) => {
          if (checkUrl(u)) ev.preventDefault()
        })
        authWin.webContents.on('will-navigate', (ev, u) => {
          if (checkUrl(u)) ev.preventDefault()
        })
        authWin.on('closed', () => done(new Error('Пользователь закрыл окно авторизации')))
        void authWin.loadURL(opts.url!).catch((err) => done(err instanceof Error ? err : new Error(String(err))))
      })
    }

    case 'sidePanel.setOptions': {
      const opts = (args[0] ?? {}) as { path?: string; enabled?: boolean }
      const prev = extNet.getStoredState(ext.id).sidePanel ?? {}
      extNet.updateStoredState(ext.id, { sidePanel: { ...prev, ...opts } })
      return undefined
    }
    case 'sidePanel.getOptions':
      return extNet.getStoredState(ext.id).sidePanel ?? { enabled: false }
    case 'sidePanel.setPanelBehavior': {
      const opts = (args[0] ?? {}) as { openPanelOnActionClick?: boolean }
      const prev = extNet.getStoredState(ext.id).sidePanel ?? {}
      extNet.updateStoredState(ext.id, { sidePanel: { ...prev, ...opts } })
      return undefined
    }
    case 'sidePanel.getPanelBehavior':
      return { openPanelOnActionClick: !!extNet.getStoredState(ext.id).sidePanel?.openPanelOnActionClick }
    case 'sidePanel.open': {
      const rel = extNet.getStoredState(ext.id).sidePanel?.path ?? (ext.manifest as { side_panel?: { default_path?: string } })?.side_panel?.default_path
      if (rel) hooks.send({ type: 'open-url', url: `chrome-extension://${ext.id}/${rel.replace(/^\//, '')}`, eager: true })
      return undefined
    }

    case 'history.search': {
      const q = ((args[0] ?? {}) as { text?: string; maxResults?: number }).text?.toLowerCase() ?? ''
      const max = ((args[0] ?? {}) as { maxResults?: number }).maxResults ?? 100
      const list = hooks.historyList?.() ?? []
      return list
        .filter((h) => !q || h.url.toLowerCase().includes(q) || h.title.toLowerCase().includes(q))
        .slice(-max)
        .reverse()
        .map((h, idx) => ({ id: String(idx), url: h.url, title: h.title, lastVisitTime: h.time, visitCount: 1 }))
    }
    case 'history.deleteAll':
      hooks.clearHistory?.()
      return undefined
    case 'history.getVisits':
      return []
    case 'history.addUrl':
    case 'history.deleteUrl':
    case 'history.deleteRange':
      return undefined

    case 'bookmarks.get': {
      const id = String(args[0] ?? '')
      const favs = hooks.favoritesList?.() ?? []
      const idx = /^fav-(\d+)$/.exec(id)?.[1]
      if (idx !== undefined && favs[Number(idx)]) {
        const f = favs[Number(idx)]
        return [{ id, parentId: '1', index: Number(idx), title: f.title, url: f.url }]
      }
      return []
    }
    case 'bookmarks.getRecent': {
      const count = typeof args[0] === 'number' ? args[0] : 20
      const favs = hooks.favoritesList?.() ?? []
      return favs.slice(-count).reverse().map((f, i) => ({ id: `fav-${i}`, parentId: '1', title: f.title, url: f.url }))
    }
    case 'bookmarks.getTree':
    case 'bookmarks.getChildren': {
      const favs = hooks.favoritesList?.() ?? []
      const children = favs.map((f, i) => ({ id: `fav-${i}`, parentId: '1', index: i, title: f.title, url: f.url }))
      return [{ id: '0', title: '', children: [{ id: '1', parentId: '0', index: 0, title: 'Избранное', children }] }]
    }
    case 'bookmarks.search': {
      const arg = args[0]
      const q = (typeof arg === 'string' ? arg : (arg as { query?: string })?.query ?? '').toLowerCase()
      return (hooks.favoritesList?.() ?? [])
        .filter((f) => !q || f.title.toLowerCase().includes(q) || f.url.toLowerCase().includes(q))
        .map((f, i) => ({ id: `fav-${i}`, title: f.title, url: f.url }))
    }
    case 'bookmarks.create': {
      const d = (args[0] ?? {}) as { title?: string; url?: string }
      if (d.url && hooks.favoritesList && hooks.setFavorites) {
        const list = hooks.favoritesList()
        hooks.setFavorites([...list, { title: d.title || d.url, url: d.url }])
        return { id: `fav-${list.length}`, title: d.title || d.url, url: d.url }
      }
      return undefined
    }
    case 'bookmarks.update':
    case 'bookmarks.remove':
      return undefined

    case 'topSites.get':
      return (hooks.favoritesList?.() ?? []).slice(0, 12).map((f) => ({ url: f.url, title: f.title }))

    case 'downloads.search': {
      const list = (await hooks.downloadsList?.()) ?? []
      return list.map((d, i) => ({
        id: i + 1,
        url: d.url,
        filename: d.path,
        state: d.state === 'completed' ? 'complete' : d.state === 'progressing' ? 'in_progress' : 'interrupted',
        bytesReceived: d.received,
        totalBytes: d.total
      }))
    }
    case 'downloads.download': {
      const d = (args[0] ?? {}) as { url?: string }
      const target = hooks.win()?.webContents ?? webContents.getAllWebContents().find((c) => !c.isDestroyed())
      if (d.url && target) target.downloadURL(d.url)
      return 1
    }
    case 'downloads.showDefaultFolder':
      void shell.openPath(app.getPath('downloads'))
      return undefined

    case 'browsingData.removeCache':
      await ses.clearCache()
      return undefined
    case 'browsingData.removeCookies':
      await ses.clearStorageData({ storages: ['cookies'] })
      return undefined
    case 'browsingData.removeLocalStorage':
      await ses.clearStorageData({ storages: ['localstorage'] })
      return undefined
    case 'browsingData.remove':
      await ses.clearStorageData()
      return undefined

    case 'search.query': {
      const q = ((args[0] ?? {}) as { text?: string }).text ?? ''
      if (q) hooks.searchQuery?.('https://www.google.com/search?q=' + encodeURIComponent(q))
      return undefined
    }
  }
  return undefined
}

/** Каждая вкладка (webview) — вкладка и для расширений: chrome.tabs, кнопки, контент-скрипты, userScripts. */
export function trackTab(wc: WebContents): void {
  if (!crx) return
  const w = hooks.win()
  if (!w || w.isDestroyed()) return
  quiet(() => crx!.addTab(wc, w))
  wc.on('did-start-navigation', () => void runUserScriptsForPhase(wc, 'document_start'))
  wc.on('dom-ready', () => void runUserScriptsForPhase(wc, 'document_end'))
  wc.on('did-finish-load', () => void runUserScriptsForPhase(wc, 'document_idle'))
  wc.once('destroyed', () => extNet.resetTabDnrState(wc.id))
  const next = waiting.shift()
  if (next) next(wc)
}

/** Интерфейс переключил вкладку — расширения узнают об этом (chrome.tabs.onActivated, кнопки). */
export function selectTab(wcId: number): void {
  const wc = webContents.fromId(wcId)
  if (!crx || !wc || wc.isDestroyed() || wc.getType() !== 'webview') return
  quiet(() => crx!.selectTab(wc))
}

// ---------- Установка расширений из локальных файлов (.crx / .zip) ----------

/** Распаковка ZIP из буфера на встроенном node:zlib (без внешних зависимостей и path traversal). */
function extractZipEntries(buf: Buffer): { name: string; data: Buffer }[] {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('Архив повреждён: не найден заголовок ZIP.')
  const entriesCount = buf.readUInt16LE(eocd + 10)
  let cdOffset = buf.readUInt32LE(eocd + 16)
  const out: { name: string; data: Buffer }[] = []
  for (let i = 0; i < entriesCount; i++) {
    if (cdOffset + 46 > buf.length || buf.readUInt32LE(cdOffset) !== 0x02014b50) {
      throw new Error('Повреждена таблица файлов ZIP.')
    }
    const method = buf.readUInt16LE(cdOffset + 10)
    const compSize = buf.readUInt32LE(cdOffset + 20)
    const nameLen = buf.readUInt16LE(cdOffset + 28)
    const extraLen = buf.readUInt16LE(cdOffset + 30)
    const commentLen = buf.readUInt16LE(cdOffset + 32)
    const localOffset = buf.readUInt32LE(cdOffset + 42)
    const name = buf.subarray(cdOffset + 46, cdOffset + 46 + nameLen).toString('utf8')
    cdOffset += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('Повреждена локальная запись ZIP.')
    }
    const locNameLen = buf.readUInt16LE(localOffset + 26)
    const locExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + locNameLen + locExtraLen
    const raw = buf.subarray(dataStart, dataStart + compSize)
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null
    if (!data) throw new Error(`Неподдерживаемый метод сжатия ZIP: ${method}`)
    out.push({ name, data })
  }
  return out
}

/** Распаковать .crx (CRX2/CRX3) или .zip в папку Extensions/<id>/<version>_0 и загрузить в сессию. */
export async function installPackageFile(filePath: string): Promise<{ ok: boolean; ext?: ExtensionInfo; error?: string }> {
  try {
    const buf = await fs.promises.readFile(filePath)
    let zipBuf = buf
    if (buf.subarray(0, 4).toString('ascii') === 'Cr24') {
      const version = buf.readUInt32LE(4)
      let headerOffset = 0
      if (version === 2 && buf.length >= 16) {
        const pubLen = buf.readUInt32LE(8)
        const sigLen = buf.readUInt32LE(12)
        headerOffset = 16 + pubLen + sigLen
      } else if (version === 3 && buf.length >= 12) {
        const hdrLen = buf.readUInt32LE(8)
        headerOffset = 12 + hdrLen
      }
      if (!headerOffset || headerOffset >= buf.length) return { ok: false, error: 'Некорректный заголовок CRX-файла.' }
      zipBuf = buf.subarray(headerOffset)
    }
    const entries = extractZipEntries(zipBuf)
    const manifestEntry = entries.find((e) => e.name === 'manifest.json')
    if (!manifestEntry) return { ok: false, error: 'В архиве не найден manifest.json.' }
    const manifest = JSON.parse(manifestEntry.data.toString('utf8')) as Manifest & { key?: string }
    const id = manifest.key
      ? crxIdFromPublicKey(Buffer.from(manifest.key, 'base64'))
      : createHash('sha256')
          .update(path.basename(filePath))
          .digest('hex')
          .slice(0, 32)
          .replace(/[0-9a-f]/g, (c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16)))
    const verDir = `${(manifest.version || '1.0').replace(/[^\w.-]/g, '_')}_0`
    const targetDir = path.join(storeDir, id, verDir)
    const rootDir = path.resolve(targetDir)
    for (const entry of entries) {
      const dest = path.resolve(rootDir, entry.name)
      if (!isInsideDir(dest, rootDir)) {
        return { ok: false, error: 'Небезопасный путь внутри архива.' }
      }
    }
    await fs.promises.rm(path.join(storeDir, id), { recursive: true, force: true })
    await fs.promises.mkdir(targetDir, { recursive: true })
    for (const entry of entries) {
      const dest = path.resolve(rootDir, entry.name)
      await fs.promises.mkdir(path.dirname(dest), { recursive: true })
      await fs.promises.writeFile(dest, entry.data)
    }
    const loaded = await hooks.session.extensions.loadExtension(targetDir, { allowFileAccess: false })
    return { ok: true, ext: infoOf(loaded) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function installStoreById(extId: string): Promise<ExtensionInfo> {
  const loaded = await installExtension(extId, { session: hooks.session, extensionsPath: storeDir })
  return infoOf(loaded, true)
}

function crxIdFromPublicKey(der: Buffer): string {
  const hash = createHash('sha256').update(der).digest()
  let out = ''
  for (let i = 0; i < 16; i++) {
    out += String.fromCharCode('a'.charCodeAt(0) + (hash[i] >> 4))
    out += String.fromCharCode('a'.charCodeAt(0) + (hash[i] & 0xf))
  }
  return out
}

// ---------- Пункты расширений в контекстном меню страницы ----------
// Меню рисует интерфейс Masaki, поэтому пункты уходят туда описанием, а щелчок возвращается сюда.

let menuItems: MenuItem[] = []

export function contextMenuItems(wc: WebContents, p: ContextMenuParams): ExtMenuItem[] {
  if (!crx) return []
  try {
    menuItems = []
    return crx.getContextMenuItems(wc, p).map(describe)
  } catch {
    return []
  }
}

function describe(m: MenuItem): ExtMenuItem {
  const index = menuItems.push(m) - 1
  return {
    index,
    label: m.label.replace(/&(.)/g, '$1'),
    type: m.type === 'checkbox' || m.type === 'radio' || m.type === 'separator' ? m.type : 'normal',
    checked: m.checked,
    enabled: m.enabled,
    children: m.submenu ? m.submenu.items.map(describe) : undefined
  }
}

export function clickMenuItem(index: number): void {
  const m = menuItems[index]
  const w = hooks.win()
  // Обработчик библиотеки аргументов не смотрит: он сам знает вкладку и параметры меню.
  if (m && w) (m.click as () => void)()
}

// ---------- Список, отключение, удаление ----------

/** Нужные Masaki поля manifest.json. */
interface Manifest {
  name?: string
  version?: string
  description?: string
  default_locale?: string
  icons?: Record<string, string>
  options_page?: string
  options_ui?: { page?: string }
  permissions?: string[]
  host_permissions?: string[]
  content_scripts?: { matches?: string[] }[]
  commands?: Record<string, { description?: string; suggested_key?: Record<string, string> }>
}

function readManifest(dir: string): Manifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest
  } catch {
    return null
  }
}

function resolveLocalized(dir: string | null, raw: string | undefined, m: Manifest | null): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined
  const msg = /^__MSG_(.+)__$/.exec(raw)
  if (!msg) return raw
  if (!dir) return undefined
  const locales = [...new Set(['ru', 'en', m?.default_locale || 'en'])]
  for (const loc of locales) {
    try {
      const dict = JSON.parse(fs.readFileSync(path.join(dir, '_locales', loc, 'messages.json'), 'utf8')) as Record<string, { message?: string }>
      const entry = dict[msg[1]] ?? dict[msg[1].toLowerCase()]
      if (entry?.message) return entry.message
    } catch {
      // локаль отсутствует — пробуем следующую
    }
  }
  return undefined
}

/** Значок расширения картинкой data: (самый крупный до 128 px). */
function iconOf(dir: string, m: Manifest | null): string | undefined {
  const icons = m?.icons ?? {}
  const sizes = Object.keys(icons)
    .map(Number)
    .filter((n) => n <= 128)
    .sort((a, b) => b - a)
  const file = sizes.length ? icons[String(sizes[0])] : undefined
  if (!file) return undefined
  const img = nativeImage.createFromPath(path.join(dir, file))
  return img.isEmpty() ? undefined : img.resize({ width: 48 }).toDataURL()
}

const isStore = (dir: string): boolean => !!storeDir && path.resolve(dir).startsWith(path.resolve(storeDir) + path.sep)

export function infoOf(e: Electron.Extension, enabled = true): ExtensionInfo {
  const m = ((e.manifest as Manifest | undefined) ?? readManifest(e.path)) as Manifest | null
  const page = m?.options_ui?.page || m?.options_page
  const cmds = readCommands(e).filter((c) => c.shortcut)
  return {
    id: e.id,
    name: e.name,
    version: e.version,
    path: e.path,
    store: isStore(e.path),
    enabled,
    description: resolveLocalized(e.path, m?.description, m),
    icon: iconOf(e.path, m),
    options: page ? `chrome-extension://${e.id}/${page.replace(/^\//, '')}` : undefined,
    commands: cmds.length ? cmds : undefined
  }
}

/** Отключённое расширение не загружено: о нём знаем только запись в настройках и папку. */
export function infoOfDisabled(d: { id: string; name: string; path: string }): ExtensionInfo {
  const m = readManifest(d.path)
  return {
    id: d.id,
    name: d.name,
    version: m?.version ?? '',
    path: d.path,
    store: isStore(d.path),
    enabled: false,
    description: resolveLocalized(d.path, m?.description, m),
    icon: iconOf(d.path, m)
  }
}

export async function removeStoreExtension(id: string): Promise<void> {
  await uninstallExtension(id, { session: hooks.session, extensionsPath: storeDir })
}

export function storeExtensionPath(id: string): string | null {
  try {
    const dir = path.join(storeDir, id)
    const versions = fs.readdirSync(dir).filter((v) => fs.existsSync(path.join(dir, v, 'manifest.json')))
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    return versions[0] ? path.join(dir, versions[0]) : null
  } catch {
    return null
  }
}

// ---------- Что расширение сможет делать — человеческими словами ----------

const PERMISSION_TEXT: Record<string, string> = {
  tabs: 'Видеть адреса и названия открытых вкладок',
  history: 'Читать и изменять историю',
  bookmarks: 'Читать и изменять закладки',
  downloads: 'Управлять загрузками',
  cookies: 'Читать и изменять cookie сайтов',
  clipboardRead: 'Читать буфер обмена',
  clipboardWrite: 'Записывать в буфер обмена',
  notifications: 'Показывать уведомления',
  geolocation: 'Узнавать, где вы находитесь',
  management: 'Управлять другими расширениями',
  nativeMessaging: 'Общаться с программами на компьютере',
  proxy: 'Менять настройки прокси',
  privacy: 'Менять настройки конфиденциальности',
  webNavigation: 'Видеть, какие страницы вы открываете',
  declarativeNetRequest: 'Блокировать рекламу и менять сетевые запросы',
  declarativeNetRequestWithHostAccess: 'Блокировать рекламу и менять запросы сайтов',
  webRequest: 'Видеть и менять сетевые запросы страниц',
  scripting: 'Встраивать стили и скрипты на страницы',
  userScripts: 'Запускать пользовательские скрипты (userscripts)',
  fontSettings: 'Читать настройки шрифтов браузера'
}

function describePermissions(m: Manifest | undefined): string[] {
  if (!m) return []
  const perms = (m.permissions ?? []).filter((p): p is string => typeof p === 'string')
  const hosts = [...(m.host_permissions ?? []), ...perms.filter((p) => p.includes('://') || p === '<all_urls>')]
  for (const cs of m.content_scripts ?? []) hosts.push(...(cs.matches ?? []))
  const out: string[] = []
  const all = hosts.some((h) => h === '<all_urls>' || /^\*:\/\/\*\/|^https?:\/\/\*\//.test(h))
  if (all) out.push('Читать и изменять ваши данные на всех сайтах')
  else {
    const sites = [...new Set(hosts.map((h) => h.replace(/^\*?:?\/?\/?(\*\.)?/, '').replace(/\/.*$/, '')).filter(Boolean))]
    if (sites.length) out.push('Читать и изменять ваши данные на сайтах: ' + sites.slice(0, 4).join(', ') + (sites.length > 4 ? ` и ещё ${sites.length - 4}` : ''))
  }
  for (const p of perms) if (PERMISSION_TEXT[p]) out.push(PERMISSION_TEXT[p])
  return [...new Set(out)]
}
