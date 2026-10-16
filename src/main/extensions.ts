// Расширения Chrome: API вкладок, кнопок и меню (electron-chrome-extensions, GPL-3 — как и Masaki)
// и установка из Chrome Web Store (electron-chrome-web-store). Electron сам умеет только загрузить
// расширение; про вкладки, кнопки на панели и всплывающие окна он ничего не знает.
//
// Вкладки Masaki — webview в окне интерфейса: их webContents библиотека видит как вкладки этого окна.
// Создать, выбрать и закрыть вкладку по просьбе расширения может только интерфейс — главный процесс
// отправляет ему команды и ждёт, пока появится webview.

import { app, BrowserWindow, nativeImage, session, webContents, type ContextMenuParams, type MenuItem, type Session, type WebContents } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { installChromeWebStore, uninstallExtension } from 'electron-chrome-web-store'
import type { Command, ExtensionInfo, ExtInstallPrompt, ExtMenuItem } from '../shared/types'
import { testHeadless } from './testMode'

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
}

let hooks: Hooks
let crx: ElectronChromeExtensions | null = null
let storeDir = ''
/** Пока Masaki сам сообщает библиотеке о вкладках, её «выбрать вкладку» не должно дёргать интерфейс. */
let internal = false
/** Ждут вкладку, которую попросило создать расширение (chrome.tabs.create). */
const waiting: ((wc: WebContents) => void)[] = []

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
    hooks.send({ type: 'open-url', url, background })
  })
}

export async function initExtensions(h: Hooks): Promise<void> {
  hooks = h
  storeDir = path.join(app.getPath('userData'), 'Extensions')
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
        if (urls[0]) void w.loadURL(urls[0])
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
  // Значки кнопок расширений интерфейс (окно в сессии по умолчанию) берёт по адресу crx://extension-icon/….
  ElectronChromeExtensions.handleCRXProtocol(session.defaultSession)
  const ext = h.session.extensions
  ext.on('extension-loaded', () => h.changed())
  ext.on('extension-unloaded', () => h.changed())
  await installChromeWebStore({
    session: h.session,
    extensionsPath: storeDir,
    autoUpdate: true,
    // Отключённые расширения ниже снимаем; распакованные Masaki загружает сам (настройка addons.extensions).
    loadExtensions: true,
    allowUnpackedExtensions: false,
    async beforeInstall(d) {
      const ok = await h.confirmInstall({
        id: d.id,
        name: d.localizedName || (d.manifest as Manifest)?.name || d.id,
        icon: d.icon.isEmpty() ? undefined : d.icon.resize({ width: 64 }).toDataURL(),
        permissions: describePermissions(d.manifest as Manifest)
      })
      return { action: ok ? 'allow' : 'deny' }
    }
  })
  for (const id of h.disabled()) if (ext.getExtension(id)) ext.removeExtension(id)
}

/** Каждая вкладка (webview) — вкладка и для расширений: chrome.tabs, кнопки, контент-скрипты. */
export function trackTab(wc: WebContents): void {
  if (!crx) return
  const w = hooks.win()
  if (!w || w.isDestroyed()) return
  quiet(() => crx!.addTab(wc, w))
  const next = waiting.shift()
  if (next) next(wc)
}

/** Интерфейс переключил вкладку — расширения узнают об этом (chrome.tabs.onActivated, кнопки). */
export function selectTab(wcId: number): void {
  const wc = webContents.fromId(wcId)
  if (!crx || !wc || wc.isDestroyed() || wc.getType() !== 'webview') return
  quiet(() => crx!.selectTab(wc))
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
  icons?: Record<string, string>
  options_page?: string
  options_ui?: { page?: string }
  permissions?: string[]
  host_permissions?: string[]
  content_scripts?: { matches?: string[] }[]
}

function readManifest(dir: string): Manifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest
  } catch {
    return null
  }
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
  return {
    id: e.id,
    name: e.name,
    version: e.version,
    path: e.path,
    store: isStore(e.path),
    enabled,
    description: typeof m?.description === 'string' && !m.description.startsWith('__MSG_') ? m.description : undefined,
    icon: iconOf(e.path, m),
    options: page ? `chrome-extension://${e.id}/${page.replace(/^\//, '')}` : undefined
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
  declarativeNetRequest: 'Блокировать и менять содержимое страниц',
  webRequest: 'Видеть сетевые запросы страниц'
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
