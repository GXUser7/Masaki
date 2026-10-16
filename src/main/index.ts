import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  nativeImage,
  net,
  protocol,
  screen,
  session,
  shell,
  webContents,
  type ContextMenuParams,
  type WebContents
} from 'electron'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { ElectronBlocker } from '@ghostery/adblocker-electron'
import { JsonFile } from './store'
import { keepTestWindowHidden, testFakeMedia, testHeadless } from './testMode'
import { chromeBookmarks, chromeHistory, chromeProfiles, chromeShortcuts } from './chromeImport'
import * as sync from './sync'
import * as passwords from './passwords'
import * as passkeys from './passkeys'
import { initYouCloud, isYouCloudExtension, overrideHeaders, watchWebview, YOUCLOUD_HEADER_URLS } from './youcloud'
import * as extensions from './extensions'
import { defaultBrowserState, makeDefault, refreshRegistration } from './defaultBrowser'
import { parseTrack, setDiscordEnabled, setDiscordTrack } from './discord'
import * as profiles from './profiles'
import * as updater from './updater'
import { pathToFileURL } from 'url'
import { commandFor } from '../shared/shortcuts'
import { siteCookieDomain } from '../shared/site'
import {
  AI_PORT,
  defaultSettings,
  type ChromeImportResult,
  type Command,
  type DownloadInfo,
  type ExtensionInfo,
  type GoogleAccount,
  type HistoryEntry,
  type PageAction,
  type PageMenuParams,
  type PermissionPrompt,
  type SavedSession,
  type SavedTab,
  type Settings,
  type SyncOptions
} from '../shared/types'

// Имя сессии осталось от старого названия (Frost): в ней куки и входы пользователя, не менять.
const PARTITION = 'persist:frost'
const HISTORY_LIMIT = 5000

const settingsFile = new JsonFile<Settings>('settings.json')
const sessionFile = new JsonFile<SavedSession>('session.json')
const historyFile = new JsonFile<HistoryEntry[]>('history.json')
const faviconFile = new JsonFile<Record<string, string>>('favicons.json')
let favicons: Record<string, string> = {}
const windowFile = new JsonFile<{ bounds: Electron.Rectangle; maximized: boolean }>('window.json')

let win: BrowserWindow | null = null
if (testHeadless) app.on('browser-window-created', (_event, window) => keepTestWindowHidden(window))
let history: HistoryEntry[] = []
let settings: Settings = defaultSettings
/** Последние сохранённые вкладки — их видят другие устройства в синхронизации. */
let lastTabs: SavedTab[] = []

// Сайты видят обычный Chrome: без «Electron/…» и имени приложения в user agent.
function chromeUserAgent(): string {
  const major = process.versions.chrome.split('.')[0]
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}
app.userAgentFallback = chromeUserAgent()

// Google не пускает во «встроенные» браузеры на Chromium. Как и другие браузеры на Electron,
// на странице входа представляемся Firefox ESR — его Google поддерживает. Остальные сайты видят Chrome.
const GOOGLE_LOGIN = /^https:\/\/accounts\.google\.com\//i
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0'

// Браузер раньше назывался Frost. Переносим его профиль (настройки, вкладки, входы на сайты)
// в папку Masaki один раз, до того как Chromium откроет профиль.
function migrateFromFrost(): void {
  const appData = app.getPath('appData')
  const from = path.join(appData, 'Frost')
  const to = path.join(appData, 'Masaki')
  if (!fs.existsSync(path.join(from, 'settings.json')) || fs.existsSync(path.join(to, 'settings.json'))) return
  try {
    if (fs.existsSync(to)) fs.rmdirSync(to) // пустая папка, если Electron успел её создать
    fs.renameSync(from, to)
  } catch {
    // Старый Frost ещё открыт и держит файлы — поработаем в его папке, перенесём в другой раз.
    app.setPath('userData', from)
    return
  }
  for (const name of ['session.json', 'history.json']) {
    const file = path.join(to, name)
    try {
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('"frost://', '"masaki://'))
    } catch {
      // файла нет — нечего переносить
    }
  }
}

// Отдельный профиль для автотестов, чтобы не трогать настоящий.
if (process.env.MASAKI_PROFILE) app.setPath('userData', process.env.MASAKI_PROFILE)
else migrateFromFrost()
// Профиль, как в Chrome: --profile=<id> — своя папка данных внутри основной (и своё окно-процесс).
profiles.initProfile(app.getPath('userData'), process.argv)
// И отдельная папка загрузок: тест паролей скачивает подставной CSV.
if (process.env.MASAKI_DOWNLOADS) app.setPath('downloads', process.env.MASAKI_DOWNLOADS)

// «Управление для ИИ»: порт отладки Chromium, через который агент (Claude Code с chrome-devtools-mcp) видит
// вкладки и управляет ими. Ключ Chromium задаётся только до запуска, поэтому настройку читаем прямо из
// файла, а переключатель в интерфейсе действует с перезапуска. Порт слушает только 127.0.0.1, а без
// --remote-allow-origins к нему не подключиться со страницы сайта — только программой на этом компьютере.
const aiPort = ((): number => {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')) as Partial<Settings>
    return saved.aiControl === true ? AI_PORT : 0
  } catch {
    return 0
  }
})()
if (aiPort) app.commandLine.appendSwitch('remote-debugging-port', String(aiPort))
if (testFakeMedia) app.commandLine.appendSwitch('use-fake-device-for-media-stream')

/** Открыл ли порт именно этот Masaki: его мог занять другой браузер с отладкой. */
async function aiControlState(): Promise<{ port: number; listening: boolean }> {
  if (!aiPort) return { port: 0, listening: false }
  try {
    const res = await fetch(`http://127.0.0.1:${aiPort}/json/version`, { signal: AbortSignal.timeout(1500) })
    const info = (await res.json()) as { Browser?: string }
    return { port: aiPort, listening: info.Browser === `Chrome/${process.versions.chrome}` }
  } catch {
    return { port: aiPort, listening: false }
  }
}

/**
 * Адрес из командной строки: так Windows передаёт ссылку или файл, когда Masaki — браузер по умолчанию
 * («Masaki.exe "%1"»). Ключи Chromium и путь к проекту в разработке сюда не попадают.
 */
function urlFromArgv(argv: string[]): string | null {
  for (const a of argv.slice(1)) {
    if (/^(https?|file):\/\//i.test(a)) return a
    if (/\.(s?html?|xht(ml)?|pdf|svg|webp)$/i.test(a) && path.isAbsolute(a) && fs.existsSync(a)) return pathToFileURL(a).href
  }
  return null
}
let launchUrl = urlFromArgv(process.argv)

// Журнал запуска во временной папке: где профиль и читаются ли его файлы. Пишется до проверки
// «второй копии», поэтому виден даже у запуска, который сразу передал управление открытому окну.
function startupLog(): void {
  try {
    const dir = app.getPath('userData')
    const lines = [
      new Date().toISOString(),
      'userData: ' + dir,
      'exe: ' + process.execPath,
      'cwd: ' + process.cwd(),
      'argv: ' + process.argv.slice(1).join(' '),
      'MASAKI_PROFILE: ' + (process.env.MASAKI_PROFILE ?? '—')
    ]
    for (const name of ['settings.json', 'session.json', 'window.json']) {
      try {
        const text = fs.readFileSync(path.join(dir, name), 'utf8')
        JSON.parse(text)
        lines.push(`${name}: ok, ${text.length} байт`)
      } catch (err) {
        lines.push(`${name}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`)
      }
    }
    fs.writeFileSync(path.join(app.getPath('temp'), 'masaki-start.log'), lines.join('\n') + '\n')
  } catch {
    // журнал не обязателен
  }
}
startupLog()

function send(c: Command): void {
  win?.webContents.send('command', c)
}

function mergeSettings(saved: Partial<Settings> | null): Settings {
  const a = saved?.addons
  return {
    ...defaultSettings,
    ...(saved ?? {}),
    clock: { ...defaultSettings.clock, ...(saved?.clock ?? {}) },
    addons: {
      glass: { ...defaultSettings.addons.glass, ...(a?.glass ?? {}) },
      adblock: { ...defaultSettings.addons.adblock, ...(a?.adblock ?? {}) },
      discord: { ...defaultSettings.addons.discord, ...(a?.discord ?? {}) },
      extensions: a?.extensions ?? [],
      pinnedExtensions: a?.pinnedExtensions ?? [],
      disabledExtensions: a?.disabledExtensions ?? []
    }
  }
}

// ---------- Горячие клавиши ----------

function attachShortcuts(contents: WebContents, isGuest: boolean): void {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.code === 'F11' && !input.control && !input.alt) {
      event.preventDefault()
      if (win) win.setFullScreen(!win.isFullScreen())
      return
    }
    // Escape нужен и самой странице, поэтому из вкладки его не перехватываем, а только сообщаем.
    if (isGuest && input.code === 'Escape') {
      send({ type: 'escape' })
      return
    }
    const c = commandFor({ code: input.code, ctrl: input.control, shift: input.shift, alt: input.alt, meta: input.meta })
    if (c) {
      event.preventDefault()
      send(c)
    }
  })
}

// ---------- Назад и вперёд: боковые кнопки мыши и клавиши браузера ----------

/**
 * Боковая кнопка мыши приходит от страницы (preload/guest.ts → 'nav:mouse'), клавиша «Назад» на клавиатуре —
 * через WM_APPCOMMAND ('app-command'). На части мышек и драйверов может прийти и то, и другое: тогда второе
 * (из другого источника, в ту же сторону, в пределах полусекунды) отбрасываем, чтобы не уйти сразу на две страницы.
 * Два нажатия мыши подряд — это два перехода, их не склеиваем.
 */
let lastNav: { src: 'mouse' | 'app'; dir: 'back' | 'forward'; at: number } | null = null
const NAV_DEDUPE_MS = 500

/** wcId — вкладка, в которой нажали (две вкладки рядом); без него команда идёт в активную. */
function navigateHistory(src: 'mouse' | 'app', dir: 'back' | 'forward', wcId?: number): void {
  const now = Date.now()
  if (lastNav && lastNav.src !== src && lastNav.dir === dir && now - lastNav.at < NAV_DEDUPE_MS) return
  lastNav = { src, dir, at: now }
  send(wcId == null ? { type: dir } : { type: dir, wcId })
}

// ---------- Контекстное меню страницы ----------
// Меню рисует интерфейс (стеклянное, в стиле Masaki), здесь только параметры и действия.

function sendPageMenu(contents: WebContents, p: ContextMenuParams): void {
  const nav = contents.navigationHistory
  const params: PageMenuParams = {
    wcId: contents.id,
    x: p.x,
    y: p.y,
    linkURL: p.linkURL,
    linkText: p.linkText,
    srcURL: p.srcURL,
    mediaType: p.mediaType,
    isEditable: p.isEditable,
    selectionText: p.selectionText,
    misspelledWord: p.misspelledWord,
    dictionarySuggestions: p.dictionarySuggestions,
    editFlags: {
      canCut: p.editFlags.canCut,
      canCopy: p.editFlags.canCopy,
      canPaste: p.editFlags.canPaste,
      canUndo: p.editFlags.canUndo,
      canRedo: p.editFlags.canRedo
    },
    pageURL: p.pageURL,
    mediaFlags: {
      isPaused: p.mediaFlags.isPaused,
      isMuted: p.mediaFlags.isMuted,
      isLooping: p.mediaFlags.isLooping,
      isControlsVisible: p.mediaFlags.isControlsVisible,
      canToggleControls: p.mediaFlags.canToggleControls,
      canShowPictureInPicture: p.mediaFlags.canShowPictureInPicture,
      hasAudio: p.mediaFlags.hasAudio
    },
    canGoBack: nav.canGoBack(),
    canGoForward: nav.canGoForward(),
    extItems: extensions.contextMenuItems(contents, p)
  }
  win?.webContents.send('page-menu', params)
}

async function savePage(contents: WebContents): Promise<void> {
  if (!win) return
  const title = (contents.getTitle() || 'страница').replace(/[\\/:*?"<>|]+/g, ' ').trim()
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('downloads'), title + '.html'),
    filters: [{ name: 'Веб-страница целиком', extensions: ['html'] }]
  })
  if (!canceled && filePath) await contents.savePage(filePath, 'HTMLComplete')
}

function runPageAction(contents: WebContents, a: PageAction): void {
  switch (a.type) {
    case 'edit':
      contents[a.cmd]()
      break
    case 'replace':
      contents.replaceMisspelling(a.word)
      break
    case 'add-word':
      contents.session.addWordToSpellCheckerDictionary(a.word)
      break
    case 'copy-image':
      contents.copyImageAt(a.x, a.y)
      break
    case 'download':
      contents.downloadURL(a.url)
      break
    case 'save-page':
      void savePage(contents)
      break
    case 'print':
      contents.print()
      break
    case 'inspect':
      contents.inspectElement(a.x, a.y)
      break
    case 'back':
      contents.navigationHistory.goBack()
      break
    case 'forward':
      contents.navigationHistory.goForward()
      break
    case 'reload':
      contents.reload()
      break
    case 'media':
      // userGesture=true: без него сайт не разрешит «картинку в картинке».
      void contents.executeJavaScript(mediaScript(a.op, a.x / contents.getZoomFactor(), a.y / contents.getZoomFactor()), true)
      break
    case 'copy-frame':
      void copyVideoFrame(contents, a.x / contents.getZoomFactor(), a.y / contents.getZoomFactor())
      break
    case 'paste-plain':
      contents.pasteAndMatchStyle()
      break
    case 'pdf':
      void saveAsPdf(contents)
      break
  }
}

/** Скрипт для видео/аудио под курсором: ищем медиа-элемент сквозь накрывающие его слои. */
function findMediaJs(x: number, y: number): string {
  return `(document.elementsFromPoint(${x}, ${y}).find((e) => e instanceof HTMLMediaElement) || null)`
}

function mediaScript(op: string, x: number, y: number): string {
  const m = findMediaJs(x, y)
  const body: Record<string, string> = {
    pip: `if (document.pictureInPictureElement === m) document.exitPictureInPicture(); else if (m instanceof HTMLVideoElement) { m.disablePictureInPicture = false; m.requestPictureInPicture() }`,
    loop: 'm.loop = !m.loop',
    controls: 'm.controls = !m.controls',
    mute: 'm.muted = !m.muted',
    play: 'if (m.paused) m.play(); else m.pause()'
  }
  return `(() => { const m = ${m}; if (!m) return; ${body[op] ?? ''} })()`
}

/** Кадр видео в буфер обмена: сначала чисто через canvas, если сайт не даёт — снимком области. */
async function copyVideoFrame(contents: WebContents, x: number, y: number): Promise<void> {
  const res = (await contents.executeJavaScript(
    `(() => { const v = ${findMediaJs(x, y)}; if (!(v instanceof HTMLVideoElement)) return null;
      try { const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
        c.getContext('2d').drawImage(v, 0, 0); return { data: c.toDataURL('image/png') } }
      catch (e) { const r = v.getBoundingClientRect(); return { rect: { x: r.left, y: r.top, w: r.width, h: r.height } } } })()`,
    true
  )) as { data?: string; rect?: { x: number; y: number; w: number; h: number } } | null
  if (!res) return
  if (res.data && res.data.length > 32) {
    await writeImage(nativeImage.createFromDataURL(res.data))
    return
  }
  if (res.rect) {
    const z = contents.getZoomFactor()
    const img = await contents.capturePage({
      x: Math.round(res.rect.x * z),
      y: Math.round(res.rect.y * z),
      width: Math.round(res.rect.w * z),
      height: Math.round(res.rect.h * z)
    })
    await writeImage(img)
  }
}

/** В Electron 44 буфер обмена асинхронный, как в вебе: картинка кладётся через ClipboardItem. */
async function writeImage(img: Electron.NativeImage): Promise<void> {
  const png = img.toPNG()
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
}

async function saveAsPdf(contents: WebContents): Promise<void> {
  if (!win) return
  const title = (contents.getTitle() || 'страница').replace(/[\\/:*?"<>|]+/g, ' ').trim()
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('downloads'), title + '.pdf'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (canceled || !filePath) return
  const pdf = await contents.printToPDF({ printBackground: true })
  await fs.promises.writeFile(filePath, pdf)
}

// ---------- Аддоны: блокировщик рекламы и расширения Chrome ----------

let blocker: ElectronBlocker | null = null
let adblockQueue: Promise<unknown> = Promise.resolve()

/** Включения и выключения идут строго по очереди: иначе блокировщик дважды регистрирует свои обработчики. */
function applyAdblock(on: boolean): Promise<{ ok: boolean; error?: string }> {
  const run = adblockQueue.then(() => applyAdblockNow(on))
  adblockQueue = run.catch(() => undefined)
  return run
}

async function applyAdblockNow(on: boolean): Promise<{ ok: boolean; error?: string }> {
  const ses = session.fromPartition(PARTITION)
  try {
    if (on) {
      if (!blocker) {
        // Фильтры Ghostery (реклама и трекеры) кэшируются в профиле, чтобы не качать их при каждом запуске.
        const cache = path.join(app.getPath('userData'), 'adblock-engine.bin')
        blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
          path: cache,
          read: fs.promises.readFile,
          write: fs.promises.writeFile
        })
      }
      if (!blocker.isBlockingEnabled(ses)) blocker.enableBlockingInSession(ses)
    } else if (blocker?.isBlockingEnabled(ses)) {
      blocker.disableBlockingInSession(ses)
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

function extInfo(e: Electron.Extension): ExtensionInfo {
  return extensions.infoOf(e)
}

/** Установленные расширения: загруженные и отключённые пользователем. */
function extList(): ExtensionInfo[] {
  const loaded = session.fromPartition(PARTITION).extensions.getAllExtensions().map(extInfo)
  const ids = new Set(loaded.map((e) => e.id))
  const off = settings.addons.disabledExtensions.filter((d) => !ids.has(d.id)).map(extensions.infoOfDisabled)
  return [...loaded, ...off].sort((a, b) => a.name.localeCompare(b.name))
}

/** Поменять настройки расширений из главного процесса — интерфейс узнает о них, как о пришедших с Диска. */
function setAddons(patch: Partial<Settings['addons']>): void {
  applySettings({ ...settings, addons: { ...settings.addons, ...patch } }, true)
}

/** Ответы на «добавить расширение?» из магазина. */
const installPrompts = new Map<string, (allow: boolean) => void>()
let extChangedTimer: NodeJS.Timeout | undefined
function extChanged(): void {
  clearTimeout(extChangedTimer)
  extChangedTimer = setTimeout(() => win?.webContents.send('ext:changed'), 150)
}

function startExtensions(): Promise<void> {
  return extensions.initExtensions({
    session: session.fromPartition(PARTITION),
    win: () => win,
    send,
    disabled: () => settings.addons.disabledExtensions.map((d) => d.id),
    changed: extChanged,
    confirmInstall: (p) =>
      new Promise((resolve) => {
        if (!win) return resolve(false)
        installPrompts.get(p.id)?.(false)
        installPrompts.set(p.id, resolve)
        if (win.isMinimized()) win.restore()
        win.webContents.send('ext:install-prompt', p)
      })
  })
}

async function loadSavedExtensions(): Promise<void> {
  const ext = session.fromPartition(PARTITION).extensions
  const off = new Set(settings.addons.disabledExtensions.map((d) => d.path))
  for (const p of settings.addons.extensions) {
    // YouCloud встроен в Masaki: его расширение здесь не работает и мешало бы мосту.
    if (isYouCloudExtension(p) || off.has(p)) continue
    try {
      await ext.loadExtension(p, { allowFileAccess: true })
    } catch (e) {
      console.error('Не удалось загрузить расширение', p, e)
    }
  }
}

// ---------- Сессия вкладок: права, загрузки ----------

/** Завершённые загрузки этого запуска: не открываем недокачанные и отменённые файлы. */
const downloadedFiles = new Set<string>()
/** interrupted бывает и до done: пока объект жив, загрузку ещё можно отменить. */
const activeDownloads = new Map<string, Electron.DownloadItem>()
const alwaysAllowed = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock'])
const permissionsFile = new JsonFile<Record<string, boolean>>('permissions.json')
/** Решения «origin|право». Камера и микрофон — разные права: разрешённый микрофон не открывает камеру. */
let decisions: Record<string, boolean> = {}
const pendingPermissions = new Map<string, (allow: boolean, remember: boolean) => void>()

/** Полный origin: http и https одного хоста, как и разные порты, — разные сайты. */
function originOf(url: string): string {
  try {
    const u = new URL(url)
    // У file: origin непрозрачный — все локальные файлы делят одно решение, как и раньше.
    if (u.protocol === 'file:') return 'file://'
    return u.origin === 'null' ? url : u.origin
  } catch {
    return url
  }
}

/** Как показать origin человеку: https — просто хост, остальное — со схемой, как в Chrome. */
function originLabel(origin: string): string {
  if (origin === 'file://') return 'Этот файл'
  return origin.startsWith('https://') ? origin.slice('https://'.length) : origin
}

/** Какие права нужны запросу media. Без типов не угадываем: нужны оба. */
function mediaPermissions(types: readonly string[]): string[] {
  const needs = [...(types.includes('video') ? ['camera'] : []), ...(types.includes('audio') ? ['microphone'] : [])]
  return needs.length ? needs : ['camera', 'microphone']
}

/** Старые решения (по 0.5.1) хранились по хосту без схемы, а камера с микрофоном — одним правом media. */
function migratePermissions(saved: Record<string, unknown>): Record<string, boolean> {
  const result: Record<string, boolean> = {}
  let changed = false
  for (const [key, allow] of Object.entries(saved)) {
    const cut = key.lastIndexOf('|')
    const origin = key.slice(0, cut)
    const permission = key.slice(cut + 1)
    if (cut <= 0 || typeof allow !== 'boolean') {
      changed = true
    } else if (origin.includes('://')) {
      result[key] = allow
    } else {
      changed = true
      // Неизвестно, что разрешали — камеру или микрофон: пусть сайт спросит снова.
      if (permission !== 'media') result[legacyOrigin(origin) + '|' + permission] = allow
    }
  }
  if (changed) permissionsFile.write(result, 0)
  return result
}

/** Такие права Chromium даёт только защищённым страницам: вне localhost решение принималось для https. */
function legacyOrigin(host: string): string {
  if (host === 'Этот файл') return 'file://'
  const name = host.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1')
  const local = name === 'localhost' || name.endsWith('.localhost') || name.startsWith('127.') || name === '::1'
  return (local ? 'http://' : 'https://') + host
}

const permissionLabels: Record<string, string> = {
  geolocation: 'Местоположение',
  camera: 'Камера',
  microphone: 'Микрофон',
  notifications: 'Уведомления',
  'clipboard-read': 'Буфер обмена',
  midi: 'MIDI-устройства',
  midiSysex: 'MIDI-устройства',
  'idle-detection': 'Данные об активности',
  'storage-access': 'Хранилище других сайтов',
  'top-level-storage-access': 'Хранилище других сайтов'
}

/** asked — права, о которых спрашиваем (у media — только ещё не решённые camera/microphone). */
function describePermission(permission: string, asked: string[]): Omit<PermissionPrompt, 'id' | 'origin'> | null {
  switch (permission) {
    case 'geolocation':
      return { kind: 'location', text: 'хочет знать, где вы находитесь' }
    case 'media': {
      const camera = asked.includes('camera')
      if (camera && asked.includes('microphone')) return { kind: 'media', text: 'хочет использовать камеру и микрофон' }
      if (camera) return { kind: 'camera', text: 'хочет использовать камеру' }
      return { kind: 'mic', text: 'хочет использовать микрофон' }
    }
    case 'notifications':
      return { kind: 'notifications', text: 'хочет показывать уведомления' }
    case 'clipboard-read':
      return { kind: 'clipboard', text: 'хочет читать буфер обмена' }
    default:
      return permissionLabels[permission] ? { kind: 'other', text: `запрашивает доступ: ${permissionLabels[permission].toLowerCase()}` } : null
  }
}

function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name)
  const base = path.basename(name, ext)
  let candidate = path.join(dir, name)
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`)
  return candidate
}

function setupBrowsingSession(): void {
  const ses = session.fromPartition(PARTITION)
  ses.setUserAgent(chromeUserAgent())
  // Слушатель у сессии один на всё: вход в Google и заголовки запросов моста YouCloud.
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://accounts.google.com/*', ...YOUCLOUD_HEADER_URLS] }, (details, callback) => {
    const headers = details.requestHeaders
    if (!GOOGLE_LOGIN.test(details.url)) {
      callback({ requestHeaders: overrideHeaders(details.url, headers) ?? headers })
      return
    }
    headers['User-Agent'] = FIREFOX_UA
    for (const name of Object.keys(headers)) if (/^sec-ch-ua/i.test(name)) delete headers[name]
    // Список аккаунтов Google отдаёт только запросу «со страницы google.com».
    if (details.url.includes('/ListAccounts')) headers['Origin'] = 'https://www.google.com'
    callback({ requestHeaders: headers })
  })
  try {
    ses.setSpellCheckerLanguages(['ru', 'en-US'])
  } catch {
    // На некоторых системах список языков задаёт сама ОС.
  }

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    if (alwaysAllowed.has(permission)) return true
    const origin = originOf(requestingOrigin)
    const type = details.mediaType
    const asked = permission === 'media' ? mediaPermissions(type && type !== 'unknown' ? [type] : []) : [permission]
    return asked.every((p) => decisions[origin + '|' + p] === true)
  })

  // Вопрос задаёт интерфейс Masaki (стеклянная плашка), а не системное окно Windows.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (alwaysAllowed.has(permission)) return callback(true)
    if (!win) return callback(false)
    const origin = originOf(details.requestingUrl)
    const needs = permission === 'media' ? mediaPermissions((details as Electron.MediaAccessPermissionRequest).mediaTypes ?? []) : [permission]
    const known = needs.map((p) => decisions[origin + '|' + p] as boolean | undefined)
    // Половину запроса Chromium выдать не умеет: запрещённая камера отклоняет и «камеру с микрофоном».
    if (known.includes(false)) return callback(false)
    const asked = needs.filter((_p, i) => known[i] === undefined)
    if (!asked.length) return callback(true)
    const prompt = describePermission(permission, asked)
    if (!prompt) return callback(false)
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    pendingPermissions.set(id, (allow, remember) => {
      if (remember) {
        for (const p of asked) decisions[origin + '|' + p] = allow
        permissionsFile.write(decisions, 300)
      }
      callback(allow)
    })
    // Вкладку закрыли или увели со страницы — вопрос больше не актуален.
    const drop = (): void => {
      if (!pendingPermissions.has(id)) return
      pendingPermissions.delete(id)
      callback(false)
      win?.webContents.send('permission-dismiss', id)
    }
    wc.once('destroyed', drop)
    wc.once('did-start-navigation', drop)
    win.webContents.send('permission', { id, origin: originLabel(origin), ...prompt })
  })

  ses.on('will-download', (_e, item, wc) => {
    // Ссылка открылась новой вкладкой, а там файл: страница не загрузилась, вкладка осталась пустой.
    if (wc && !wc.isDestroyed() && wc.getType() === 'webview' && (!wc.getURL() || wc.getURL() === 'about:blank')) {
      send({ type: 'close-empty-tab', wcId: wc.id })
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const target = uniquePath(app.getPath('downloads'), item.getFilename())
    item.setSavePath(target)
    activeDownloads.set(id, item)
    const info = (state = item.getState()): DownloadInfo => ({
      id,
      filename: path.basename(item.getSavePath() || target),
      url: item.getURL(),
      path: item.getSavePath() || target,
      state,
      canCancel: activeDownloads.has(id),
      received: item.getReceivedBytes(),
      total: item.getTotalBytes(),
      startedAt: item.getStartTime() * 1000
    })
    win?.webContents.send('download', info())
    item.on('updated', (_ev, state) => win?.webContents.send('download', info(state)))
    item.once('done', (_ev, state) => {
      activeDownloads.delete(id)
      if (state === 'completed') downloadedFiles.add(item.getSavePath() || target)
      win?.webContents.send('download', info(state))
      // Экспорт паролей (passwords.google.com, Chrome) — предложить перенести в Masaki и удалить файл.
      if (state === 'completed' && passwords.isPasswordExport(item.getSavePath())) passwords.csvDownloaded(item.getSavePath())
    })
  })
}

// ---------- Окно ----------

function windowState(): { maximized: boolean; fullscreen: boolean } {
  return { maximized: !!win?.isMaximized(), fullscreen: !!win?.isFullScreen() }
}

function createWindow(saved: { bounds: Electron.Rectangle; maximized: boolean } | null): void {
  // Восстанавливаем размер и положение, если прошлый экран всё ещё подключён.
  const onScreen =
    saved && screen.getAllDisplays().some((d) => {
      const a = d.workArea
      const b = saved.bounds
      return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y
    })
  const dark = settings.scheme === 'dark' || (settings.scheme === 'system' && nativeTheme.shouldUseDarkColors)
  win = new BrowserWindow({
    width: onScreen ? saved.bounds.width : 1360,
    height: onScreen ? saved.bounds.height : 860,
    ...(onScreen ? { x: saved.bounds.x, y: saved.bounds.y } : {}),
    minWidth: 760,
    minHeight: 520,
    // На Mac — родные «светофоры» в шапке боковой панели (их место там держит .mac .side-top),
    // на Windows — окно без рамки и свои кнопки окна.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 24, y: 31 } } : { frame: false }),
    show: false,
    skipTaskbar: testHeadless,
    title: 'Masaki',
    icon: app.isPackaged ? undefined : path.join(__dirname, '../../build/icon.png'),
    backgroundColor: dark ? '#0D1513' : '#E3F1EE',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      webviewTag: true,
      backgroundThrottling: !testHeadless,
      offscreen: testHeadless,
      sandbox: true,
      spellcheck: true
    }
  })

  macTrafficLights()
  win.once('ready-to-show', () => {
    if (testHeadless) return
    if (onScreen && saved.maximized) win?.maximize()
    // Автотесты не забирают фокус: иначе то, что пользователь печатает, уходит в тестовое окно.
    if (process.env.MASAKI_TEST_INACTIVE) win?.showInactive()
    else win?.show()
  })
  win.on('close', () => {
    if (win) windowFile.write({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }, 0)
  })
  if (process.env.MASAKI_SELFTEST_URL) runSelfTest()
  for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore'] as const) {
    win.on(ev as 'maximize', () => win?.webContents.send('win-state', windowState()))
  }
  // Специальные клавиши клавиатуры (WM_APPCOMMAND). Боковые кнопки мыши сюда обычно не доходят: Chromium
  // разбирает WM_XBUTTON* сам и отдаёт странице как mouseup с button 3/4 — их ловит preload/guest.ts ('nav:mouse').
  win.on('app-command', (_e, cmd) => {
    switch (cmd) {
      case 'browser-backward':
        navigateHistory('app', 'back')
        break
      case 'browser-forward':
        navigateHistory('app', 'forward')
        break
      case 'browser-refresh':
        send({ type: 'reload' })
        break
      case 'browser-stop':
        send({ type: 'stop' })
        break
      case 'browser-search':
        send({ type: 'palette', withUrl: false })
        break
      case 'browser-home':
      case 'new':
        // Домашняя страница Masaki — новая вкладка.
        send({ type: 'new-tab' })
        break
      case 'browser-favorites':
        send({ type: 'favorite' })
        break
      case 'find':
        send({ type: 'find' })
        break
      case 'close':
        send({ type: 'close-tab' })
        break
      case 'print':
        send({ type: 'print' })
        break
      case 'save':
        send({ type: 'save-page' })
        break
    }
  })
  win.on('closed', () => {
    win = null
  })
  win.on('focus', () => sync.onFocus())

  const ui = win.webContents
  attachShortcuts(ui, false)
  // Сам интерфейс никуда не уходит: ссылки и перетащенные файлы открываются вкладками.
  ui.on('will-navigate', (e, url) => {
    e.preventDefault()
    send({ type: 'open-url', url })
  })
  ui.setWindowOpenHandler(({ url }) => {
    send({ type: 'open-url', url })
    return { action: 'deny' }
  })
  ui.on('will-attach-webview', (_e, prefs, params) => {
    prefs.preload = path.join(__dirname, '../preload/guest.js')
    prefs.nodeIntegration = false
    prefs.contextIsolation = true
    prefs.sandbox = true
    if (testHeadless) prefs.backgroundThrottling = false
    params.partition = PARTITION
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

// Самопроверка без Playwright (у автоматизации свой отпечаток, и Google показывает капчу):
// открыть адрес, подождать и сохранить снимок окна. Включается только переменными окружения.
function runSelfTest(): void {
  const url = process.env.MASAKI_SELFTEST_URL ?? ''
  const shot = process.env.MASAKI_SELFTEST_SHOT ?? path.join(app.getPath('temp'), 'masaki-selftest.png')
  const wait = Number(process.env.MASAKI_SELFTEST_WAIT ?? 8000)
  win?.webContents.once('did-finish-load', () => {
    setTimeout(() => send({ type: 'open-url', url }), 1500)
    // Необязательное действие до снимка (например, нажать кнопку на странице) — MASAKI_SELFTEST_PRE.
    const pre = process.env.MASAKI_SELFTEST_PRE
    if (pre) {
      setTimeout(async () => {
        const guest = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && !c.isDestroyed())
        if (guest) console.log('SELFTEST-PRE', JSON.stringify(await guest.executeJavaScript(pre, true).catch((err) => String(err))))
      }, 1500 + wait * 0.6)
    }
    setTimeout(async () => {
      const img = await win?.capturePage()
      if (img) fs.writeFileSync(shot, img.toPNG())
      // Необязательная проверка: выполнить выражение во вкладке и вывести результат.
      const code = process.env.MASAKI_SELFTEST_EVAL
      const guest = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && !c.isDestroyed())
      if (code && guest) console.log('SELFTEST', JSON.stringify(await guest.executeJavaScript(code).catch((err) => String(err))))
      app.quit()
    }, 1500 + wait)
  })
}

// ---------- AI Mode с картинкой ----------
// Адресом картинку в AI Mode не передать. Путь как у «Найти через Google Lens» в Chrome: картинка уходит
// POST'ом в Lens прямо во вкладке (её куки, её прокси), Google отвечает переходом на результаты Lens
// (`/search?vsrid=…&udm=26`), а у них есть вкладка AI Mode — тот же адрес с `udm=50` и вопросом в `q`.
// Этот переход перехватываем и сразу открываем AI Mode. Капчу Google, если будет, проходят во вкладке.
const LENS_UPLOAD = 'https://lens.google.com/v3/upload'
/** Вкладки, ждущие ответа Lens, — с вопросом для AI Mode. */
const lensAsks = new Map<number, { query: string; until: number }>()

function aiModeFromLens(url: string, query: string): string | null {
  try {
    const u = new URL(url)
    if (!/(^|\.)google\.[a-z.]+$/.test(u.hostname) || u.pathname !== '/search' || !u.searchParams.get('vsrid')) return null
    u.searchParams.set('udm', '50')
    u.searchParams.set('q', query)
    if (!u.searchParams.has('aep')) u.searchParams.set('aep', '1')
    return u.toString()
  } catch {
    return null
  }
}

/** multipart/form-data с одним полем encoded_image, как у формы Lens. Большие снимки — не больше 1600 px. */
function lensBody(image: string): { body: Buffer; boundary: string } | null {
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(image)
  if (!m) return null
  let type = m[1]
  let bytes: Buffer = Buffer.from(m[2], 'base64')
  if (!bytes.length || bytes.length > 25 * 1024 * 1024) return null
  const img = nativeImage.createFromBuffer(bytes)
  if (!img.isEmpty()) {
    const { width, height } = img.getSize()
    const scale = 1600 / Math.max(width, height)
    if (scale < 1) {
      bytes = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' }).toJPEG(90)
      type = 'image/jpeg'
    }
  }
  const boundary = '----MasakiLens' + randomUUID().replace(/-/g, '')
  const ext = type.split('/')[1].replace('jpeg', 'jpg')
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="encoded_image"; filename="image.${ext}"\r\nContent-Type: ${type}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ])
  return { body, boundary }
}

/** Отправить картинку в Lens во вкладке; ответ Lens вкладка сама переведёт в AI Mode. */
function askLens(contents: WebContents, query: string, image: string): boolean {
  const form = lensBody(image)
  if (!form) return false
  lensAsks.set(contents.id, { query, until: Date.now() + 60_000 })
  const url = `${LENS_UPLOAD}?hl=${encodeURIComponent(app.getLocale() || 'ru')}&re=df&st=${Date.now()}&ep=gisbubb`
  // Обещание отклонится, когда переход на результаты заменим AI Mode, — это не ошибка.
  void contents
    .loadURL(url, { postData: [{ type: 'rawData', bytes: form.body }], extraHeaders: `Content-Type: multipart/form-data; boundary=${form.boundary}` })
    .catch(() => undefined)
  return true
}

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return
  attachShortcuts(contents, true)
  watchWebview(contents)
  extensions.trackTab(contents)
  // Ответ Lens на картинку для AI Mode: результаты Lens сразу заменяем на AI Mode с вопросом.
  const toAiMode = (e: Electron.Event, url: string): void => {
    const ask = lensAsks.get(contents.id)
    if (!ask) return
    if (Date.now() > ask.until) return void lensAsks.delete(contents.id)
    const ai = aiModeFromLens(url, ask.query)
    if (!ai) return
    e.preventDefault()
    lensAsks.delete(contents.id)
    void contents.loadURL(ai).catch(() => undefined)
  }
  contents.on('will-redirect', toAiMode)
  contents.on('will-navigate', toAiMode)
  contents.once('destroyed', () => lensAsks.delete(contents.id))
  // Ctrl+колесо над страницей: Electron масштаб сам не меняет, а только сообщает направление.
  // Применяет интерфейс (как Ctrl+=, с запоминанием в tab.zoom) в той вкладке, над которой крутили.
  contents.on('zoom-changed', (_ev, dir) => send({ type: 'zoom', delta: dir === 'in' ? 1 : -1, wcId: contents.id }))
  contents.on('context-menu', (_ev, p) => sendPageMenu(contents, p))
  // navigator.userAgent на странице входа Google должен совпадать с заголовком.
  contents.on('did-start-navigation', (e) => {
    if (!e.isMainFrame || e.isSameDocument) return
    const want = GOOGLE_LOGIN.test(e.url) ? FIREFOX_UA : chromeUserAgent()
    if (contents.getUserAgent() !== want) contents.setUserAgent(want)
  })
  contents.setWindowOpenHandler(({ url, disposition, features }) => {
    // Настоящие всплывающие окна (вход через Google, оплата) остаются окнами,
    // чтобы у них работал window.opener. Всё остальное открывается вкладкой.
    if (disposition === 'new-window' && features) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { width: 520, height: 700, show: !testHeadless, autoHideMenuBar: true, backgroundColor: '#ffffff' }
      }
    }
    send({ type: 'open-url', url, background: disposition === 'background-tab' })
    return { action: 'deny' }
  })
})

// ---------- Настройки ----------

/** Новые настройки из интерфейса или с Диска (fromSync — тогда интерфейсу нужно о них узнать). */
/** Mac: «светофоры» живут в шапке боковой панели; свёрнута панель — их нет, кнопки окна в капсуле. */
function macTrafficLights(): void {
  if (process.platform === 'darwin') win?.setWindowButtonVisibility(!settings.sidebarCollapsed)
}

function applySettings(s: Settings, fromSync = false): void {
  const adblockWas = settings.addons.adblock.enabled
  settings = mergeSettings(s)
  macTrafficLights()
  if (settings.addons.adblock.enabled !== adblockWas) void applyAdblock(settings.addons.adblock.enabled)
  setDiscordEnabled(settings.addons.discord.enabled)
  nativeTheme.themeSource = settings.scheme
  settingsFile.write(settings)
  if (fromSync) win?.webContents.send('settings-changed', settings)
}

function startSync(): Promise<void> {
  return sync.initSync({
    settings: () => settings,
    applySettings: (s) => applySettings(s, true),
    history: () => history,
    applyHistory: (h) => {
      history = h
      historyFile.write(history, 500)
      win?.webContents.send('history-changed', history)
    },
    tabs: () => lastTabs,
    openUrl: (url) => send({ type: 'open-url', url }),
    closeTabs: (prefix) => send({ type: 'close-tabs', prefix }),
    showSettings: () => {
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.focus()
      send({ type: 'settings' })
    },
    hasCustomWallpaper: () => {
      try {
        return fs.readdirSync(app.getPath('userData')).some((f) => f.startsWith('custom-wallpaper.'))
      } catch {
        return false
      }
    },
    state: (st) => win?.webContents.send('sync-state', st),
    historyLimit: HISTORY_LIMIT,
    passwordsExport: () => [...passwords.syncExport(), ...passkeys.syncExport()],
    passwordsApply: (items) => {
      passwords.syncApply(items.filter((i) => !passkeys.isPlainPasskey(i)) as passwords.PlainLogin[])
      passkeys.syncApply(items.filter(passkeys.isPlainPasskey))
    }
  })
}

// ---------- Пароли ----------

/** Сообщения от скрипта страниц принимаем только из вкладок; сайт — по самому фрейму, а не со слов страницы. */
function fromTab(e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): string | undefined {
  if (e.sender.getType() !== 'webview' || !e.senderFrame || e.senderFrame.parent) return undefined
  return e.senderFrame.origin
}

function registerPasswordIpc(): void {
  ipcMain.handle('pw:logins', (e) => passwords.matchesFor(fromTab(e)))
  ipcMain.on('pw:submit', (e, d: { username: string; password: string }) => {
    const origin = fromTab(e)
    if (origin && d && typeof d.password === 'string') passwords.onSubmit(e.sender, origin, { username: String(d.username ?? ''), password: d.password })
  })
  ipcMain.on('pw:username', (e, username: string) => {
    const origin = fromTab(e)
    if (origin && typeof username === 'string') passwords.onUsernameStep(e.sender, origin, username)
  })

  ipcMain.handle('passwords:list', () => passwords.list())
  ipcMain.handle('passwords:reveal', (_e, id: string) => passwords.reveal(String(id)))
  ipcMain.handle('passwords:copy', (_e, id: string) => passwords.copy(String(id)))
  ipcMain.handle('passwords:save', (_e, p: { id?: string; url: string; username: string; password?: string; note?: string }) =>
    passwords.save({ id: p.id, url: String(p.url ?? ''), username: String(p.username ?? ''), password: p.password, note: p.note })
  )
  ipcMain.handle('passwords:remove', (_e, id: string) => passwords.remove(String(id)))
  ipcMain.handle('passwords:import-file', async () => {
    if (!win) return null
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Файл экспорта паролей (CSV из Google Password Manager, Chrome, Firefox, Bitwarden)',
      properties: ['openFile'],
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (canceled || !filePaths[0]) return null
    return passwords.importCsv(filePaths[0], true)
  })
  ipcMain.handle('passwords:import-downloaded', (_e, id: string) => passwords.importDownloaded(String(id)))
  ipcMain.on('passwords:dismiss-csv', (_e, id: string) => passwords.dismissCsv(String(id)))
  ipcMain.on('passwords:answer', (_e, id: string, action: 'save' | 'never' | 'dismiss') => passwords.answer(String(id), action))
  ipcMain.on('passwords:fill', (_e, wcId: number, id: string) => {
    const wc = webContents.fromId(Number(wcId))
    if (wc && wc.getType() === 'webview') passwords.fill(wc, String(id))
  })
  ipcMain.handle('passwords:never', () => passwords.neverList())
  ipcMain.on('passwords:forget-never', (_e, origin: string) => passwords.forgetNever(String(origin)))

  // Ключи доступа: запросы WebAuthn из вкладок (сайт — по фрейму) и ответы пользователя из интерфейса.
  for (const op of ['create', 'get', 'abort'] as const) {
    ipcMain.handle('pk:' + op, (e, json: string) => passkeys.request(e.sender, fromTab(e), op, String(json)))
  }
  ipcMain.handle('pk:conditional', (e) => (fromTab(e) ? passkeys.conditionalItems(e.sender) : []))
  const fromUi = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean => !!win && e.sender === win.webContents
  ipcMain.handle('passkeys:list', (e) => (fromUi(e) ? passkeys.list() : []))
  ipcMain.handle('passkeys:remove', (e, id: string) => {
    if (fromUi(e)) passkeys.remove(String(id))
  })
  ipcMain.on('passkeys:answer', (e, id: string, action: 'ok' | 'cancel' | 'other', account?: string) => {
    if (fromUi(e) && ['ok', 'cancel', 'other'].includes(action)) passkeys.answer(String(id), action, account === undefined ? undefined : String(account))
  })
  ipcMain.on('passkeys:use', (e, wcId: number, id: string) => {
    const wc = webContents.fromId(Number(wcId))
    if (fromUi(e) && wc && wc.getType() === 'webview') passkeys.useConditional(wc, String(id))
  })
}

// ---------- IPC ----------

function registerIpc(): void {
  ipcMain.on('win:minimize', () => win?.minimize())
  ipcMain.on('win:toggle-max', () => {
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('win:close', () => win?.close())
  ipcMain.on('win:fullscreen', (_e, on: boolean) => win?.setFullScreen(on))
  // Боковая кнопка мыши: от страницы вкладки (назад/вперёд именно в ней — важно при двух вкладках рядом)
  // или от самого интерфейса (тогда в активной). Страница шлёт только из главного фрейма.
  ipcMain.on('nav:mouse', (e, dir: unknown) => {
    if (dir !== 'back' && dir !== 'forward') return
    if (e.sender.getType() === 'webview') {
      if (e.senderFrame && !e.senderFrame.parent) navigateHistory('mouse', dir, e.sender.id)
    } else if (win && e.sender === win.webContents) navigateHistory('mouse', dir)
  })
  // Свои раскладки окна: Windows показывает Snap Layouts только у системных кнопок.
  ipcMain.on('win:snap', (_e, r: { x: number; y: number; w: number; h: number }) => {
    if (!win || win.isFullScreen()) return
    const clamp = (v: unknown): number => Math.min(1, Math.max(0, Number(v) || 0))
    const a = screen.getDisplayMatching(win.getBounds()).workArea
    if (win.isMaximized()) win.unmaximize()
    win.setBounds({
      x: Math.round(a.x + clamp(r.x) * a.width),
      y: Math.round(a.y + clamp(r.y) * a.height),
      width: Math.max(560, Math.round(clamp(r.w) * a.width)),
      height: Math.max(420, Math.round(clamp(r.h) * a.height))
    })
  })
  ipcMain.handle('win:state', () => windowState())

  ipcMain.handle('system:launch-url', () => {
    const url = launchUrl
    launchUrl = null
    return url
  })
  ipcMain.on('system:relaunch', () => {
    // Без ссылки, с которой Masaki когда-то запустили: иначе после перезапуска она открылась бы снова.
    app.relaunch({ args: process.argv.slice(1).filter((a) => urlFromArgv(['', a]) === null) })
    app.quit()
  })
  ipcMain.handle('update:state', () => updater.updateState())
  ipcMain.on('update:check', () => void updater.check())
  ipcMain.on('update:install', () => {
    if (updater.install()) return
    // Сам поставить не может (сборка без установщика, Mac): страница выпуска — там установщик и что нового.
    const u = updater.updateState()
    send({ type: 'open-url', url: u.version ? `${updater.RELEASES}/tag/v${u.version}` : updater.RELEASES })
  })
  ipcMain.handle('system:ai-control', () => aiControlState())
  ipcMain.handle('system:default-browser', () => defaultBrowserState())
  ipcMain.handle('system:make-default', () => makeDefault())

  ipcMain.handle('settings:get', () => settings)
  ipcMain.on('settings:set', (_e, s: Settings) => {
    applySettings(s)
    sync.onSettingsChanged()
  })

  ipcMain.handle('session:load', () => sessionFile.read())
  ipcMain.on('session:save', (_e, s: SavedSession) => {
    sessionFile.write(s, 800)
    lastTabs = s.tabs
    sync.onTabsChanged()
  })

  ipcMain.handle('history:list', () => history)
  ipcMain.on('history:add', (_e, entry: HistoryEntry) => {
    if (!/^https?:/i.test(entry.url)) return
    const last = history[history.length - 1]
    if (last && last.url === entry.url) {
      last.title = entry.title || last.title
      last.time = entry.time
    } else {
      history.push(entry)
      if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT)
    }
    historyFile.write(history, 1500)
    sync.onHistoryChanged()
  })
  ipcMain.on('history:clear', () => {
    history = []
    historyFile.write(history, 0)
    sync.onHistoryCleared()
  })

  const downloadUi = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean =>
    !!win && e.sender === win.webContents && e.senderFrame === win.webContents.mainFrame
  const completedDownload = (e: Electron.IpcMainEvent, p: unknown): p is string =>
    downloadUi(e) && typeof p === 'string' && downloadedFiles.has(p) && fs.existsSync(p)
  ipcMain.handle('dl:cancel', (e, id: unknown) => {
    if (!downloadUi(e) || typeof id !== 'string') return false
    const item = activeDownloads.get(id)
    if (!item) return false
    const state = item.getState()
    if (state !== 'progressing' && state !== 'interrupted') return false
    item.cancel()
    return true
  })
  ipcMain.on('dl:open', (e, p: unknown) => {
    if (completedDownload(e, p)) void shell.openPath(p)
  })
  ipcMain.on('dl:show', (e, p: unknown) => {
    if (completedDownload(e, p)) shell.showItemInFolder(p)
  })
  // Перетащить скачанный файл в проводник или на сайт — только файлы из своего списка загрузок.
  ipcMain.on('dl:drag', async (e, p: unknown) => {
    if (!completedDownload(e, p)) return
    const icon = await app.getFileIcon(p, { size: 'normal' })
    e.sender.startDrag({ file: p, icon })
  })
  ipcMain.handle('site:clear-cookies', async (e, wcId: unknown, expectedOrigin: unknown) => {
    if (!downloadUi(e) || typeof wcId !== 'number' || !Number.isSafeInteger(wcId)) {
      return { ok: false, error: 'Очистка доступна только из меню Masaki.' }
    }
    const contents = webContents.fromId(wcId)
    const tabSession = session.fromPartition(PARTITION)
    if (!contents || contents.isDestroyed() || contents.getType() !== 'webview' ||
        contents.hostWebContents !== win?.webContents || contents.session !== tabSession) {
      return { ok: false, error: 'Вкладка уже закрыта или недоступна.' }
    }
    const address = contents.getURL()
    const site = siteCookieDomain(address)
    if (!site) return { ok: false, error: 'Откройте обычный сайт для очистки кук.' }
    const origin = new URL(address).origin
    if (expectedOrigin !== origin || contents.mainFrame.origin !== origin) {
      return { ok: false, error: 'Страница изменилась. Откройте меню заново и повторите.' }
    }
    let navigated = false
    const onNavigation = (_event: Electron.Event, _url: string, isInPlace: boolean, isMainFrame: boolean): void => {
      if (isMainFrame && !isInPlace) navigated = true
    }
    contents.on('did-start-navigation', onNavigation)
    try {
      // Фильтр Chromium учитывает родительские домены, пути, HttpOnly и разделённые куки.
      // Только cookies: localStorage, IndexedDB, кэш и данные сторонних сайтов сохраняются.
      await tabSession.clearData({ dataTypes: ['cookies'], origins: [origin], originMatchingMode: 'origin-in-all-contexts' })
      await tabSession.cookies.flushStore()
      // За время очистки пользователь мог перейти на другой сайт: его перезагружать не нужно.
      const reloaded = !navigated && !contents.isDestroyed() && contents.mainFrame.origin === origin
      if (reloaded) contents.reload()
      return { ok: true, site, reloaded }
    } catch {
      return { ok: false, error: 'Не удалось очистить куки. Попробуйте ещё раз.' }
    } finally {
      if (!contents.isDestroyed()) contents.removeListener('did-start-navigation', onNavigation)
    }
  })
  // AI Mode с картинкой из палитры: только окно интерфейса, только вкладка этого окна.
  ipcMain.handle('ai:image', (e, wcId: unknown, query: unknown, image: unknown) => {
    if (!downloadUi(e) || typeof wcId !== 'number' || typeof query !== 'string' || typeof image !== 'string') return false
    const contents = webContents.fromId(wcId)
    if (!contents || contents.isDestroyed() || contents.getType() !== 'webview' || contents.hostWebContents !== win?.webContents) return false
    return askLens(contents, query.trim().slice(0, 2000), image)
  })
  ipcMain.handle('site:clear-data', (_e, origin: string) => {
    if (!/^https?:\/\/[^/]+$/.test(String(origin))) return
    return session.fromPartition(PARTITION).clearStorageData({ origin })
  })
  ipcMain.handle('site:clear-cache', () => session.fromPartition(PARTITION).clearCache())

  ipcMain.on('page:action', (_e, wcId: number, a: PageAction) => {
    const contents = webContents.fromId(wcId)
    if (contents && !contents.isDestroyed()) runPageAction(contents, a)
  })
  ipcMain.on('ui:edit', (_e, cmd: 'cut' | 'copy' | 'paste' | 'selectAll' | 'undo' | 'redo') => win?.webContents[cmd]())
  ipcMain.on('clipboard:write', (_e, text: string) => clipboard.writeText(text))

  ipcMain.handle('tab:capture', async (_e, wcId: number) => {
    const wc = webContents.fromId(Number(wcId))
    if (!wc || wc.isDestroyed() || wc.getType() !== 'webview') return null
    try {
      const img = await wc.capturePage()
      return img.isEmpty() ? null : img.resize({ width: 480 }).toDataURL()
    } catch {
      return null
    }
  })
  ipcMain.handle('favicon', async (_e, url: string) => {
    const host = iconHost(url)
    if (!host) return null
    if (favicons[host]) return favicons[host]
    const data = await fetchAsDataUrl(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`)
    if (data) rememberFavicon(host, data)
    return data
  })
  // Значок вкладки копией data: — интерфейсу нужно разобрать его пиксели (светлый глиф на белом кружке).
  // Только окну интерфейса и только http(s); ответы держим в памяти, адреса значков повторяются.
  const iconData = new Map<string, Promise<string | null>>()
  ipcMain.handle('favicon:data', (e, iconUrl: unknown) => {
    if (e.sender !== win?.webContents || typeof iconUrl !== 'string' || !/^https?:/i.test(iconUrl)) return null
    let data = iconData.get(iconUrl)
    if (!data) {
      if (iconData.size >= 300) iconData.clear()
      data = fetchAsDataUrl(iconUrl, 100_000)
      iconData.set(iconUrl, data)
    }
    return data
  })
  ipcMain.on('favicon:learn', async (_e, pageUrl: string, iconUrl: string) => {
    const host = iconHost(pageUrl)
    if (!host || !/^(https?|data):/i.test(iconUrl)) return
    const data = iconUrl.startsWith('data:') ? iconUrl : await fetchAsDataUrl(iconUrl)
    if (data) rememberFavicon(host, data)
  })

  ipcMain.handle('google:accounts', async () => {
    const list = await fetchGoogleAccounts()
    // Ответ Google (а не сбой сети) — аккаунт профиля для его аватара и имени в списке профилей.
    if (list) profiles.noteAccount(list[0])
    return list ?? []
  })
  ipcMain.on('discord:track', (_e, t: unknown) => setDiscordTrack(parseTrack(t)))
  ipcMain.handle('profiles:list', () => profiles.listProfiles())
  ipcMain.on('profiles:open', (_e, id: unknown) => {
    if (typeof id !== 'string') return
    if (id === profiles.currentProfile()) win?.focus()
    else profiles.openProfile(id)
  })
  ipcMain.handle('profiles:create', () => profiles.createProfile())
  ipcMain.on('profiles:rename', (_e, id: unknown, name: unknown) => {
    if (typeof id === 'string' && typeof name === 'string') profiles.renameProfile(id, name)
  })
  ipcMain.handle('profiles:remove', (_e, id: unknown) => (typeof id === 'string' ? profiles.removeProfile(id) : { ok: false }))
  // Обложка того, что играет: картинкой data: — интерфейс берёт из неё цвет мини-плеера.
  ipcMain.handle('media:art', (_e, url: string) => (/^https?:\/\//i.test(String(url)) ? fetchAsDataUrl(String(url), 1_500_000) : null))

  ipcMain.handle('sync:state', () => sync.getState())
  ipcMain.handle('sync:pick-client', async () => {
    if (!win) return null
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Ключ Google для синхронизации (JSON из Google Cloud)',
      properties: ['openFile'],
      filters: [{ name: 'Ключ OAuth', extensions: ['json'] }]
    })
    if (canceled || !filePaths[0]) return null
    return sync.setClientFromFile(filePaths[0])
  })
  ipcMain.handle('sync:set-client', (_e, id: string, secret: string) => sync.setClient(String(id), String(secret)))
  ipcMain.on('sync:remove-client', () => sync.removeClient())
  ipcMain.handle('sync:sign-in', (_e, external: boolean, hint: unknown) => sync.signIn(!!external, typeof hint === 'string' ? hint.slice(0, 320) : ''))
  ipcMain.on('sync:cancel', () => sync.cancelSignIn())
  ipcMain.handle('sync:sign-out', () => sync.signOut())
  ipcMain.handle('sync:now', () => sync.syncNow())
  ipcMain.on('sync:options', (_e, o: Partial<SyncOptions>) => sync.setOptions(o))
  ipcMain.on('sync:device-name', (_e, name: string) => sync.setDeviceName(String(name)))
  ipcMain.handle('sync:forget-device', (_e, id: string) => sync.forgetDevice(String(id)))
  ipcMain.handle('sync:wipe', () => sync.wipe())
  ipcMain.handle('sync:vault-key', (_e, passphrase: string) => sync.setVaultKey(String(passphrase)))
  ipcMain.handle('sync:vault-reset', () => sync.resetVault())
  ipcMain.handle('chrome:profiles', () => chromeProfiles())
  ipcMain.handle('chrome:import', (_e, dir: string, what: { bookmarks: boolean; shortcuts: boolean; history: boolean }): ChromeImportResult => {
    const result: ChromeImportResult = {
      bookmarks: what.bookmarks ? chromeBookmarks(dir) : [],
      shortcuts: what.shortcuts ? chromeShortcuts(dir) : [],
      history: 0
    }
    if (what.history) {
      try {
        // История Chrome встаёт по времени рядом со своей; лимит общий, лишнее — самое старое.
        const known = new Set(history.map((h) => h.url + '|' + h.time))
        const add = chromeHistory(dir, HISTORY_LIMIT).filter((h) => !known.has(h.url + '|' + h.time))
        history = [...history, ...add].sort((a, b) => a.time - b.time).slice(-HISTORY_LIMIT)
        result.history = add.length
        historyFile.write(history, 0)
        sync.onHistoryChanged()
      } catch (err) {
        result.error = err instanceof Error ? err.message : String(err)
      }
    }
    return result
  })

  ipcMain.handle('adblock:set', (_e, on: boolean) => applyAdblock(on))
  ipcMain.handle('ext:list', () => extList())
  ipcMain.handle('ext:add', async () => {
    if (!win) return null
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Папка распакованного расширения (с manifest.json)',
      properties: ['openDirectory']
    })
    if (canceled || !filePaths[0]) return null
    if (isYouCloudExtension(filePaths[0])) return { ok: false, error: 'YouCloud уже встроен в Masaki — это расширение ставить не нужно.' }
    try {
      const e = await session.fromPartition(PARTITION).extensions.loadExtension(filePaths[0], { allowFileAccess: true })
      return { ok: true, ext: extInfo(e) }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })
  ipcMain.handle('ext:remove', async (_e, id: string) => {
    const ext = session.fromPartition(PARTITION).extensions
    const off = settings.addons.disabledExtensions.find((d) => d.id === id)
    const dir = ext.getExtension(id)?.path ?? off?.path ?? extensions.storeExtensionPath(id)
    if (dir && extensions.infoOfDisabled({ id, name: '', path: dir }).store) await extensions.removeStoreExtension(id)
    else if (ext.getExtension(id)) ext.removeExtension(id)
    setAddons({
      extensions: settings.addons.extensions.filter((p) => p !== dir),
      pinnedExtensions: settings.addons.pinnedExtensions.filter((x) => x !== id),
      disabledExtensions: settings.addons.disabledExtensions.filter((d) => d.id !== id)
    })
    extChanged()
  })
  // Отключить — выгрузить и запомнить, где лежит; включить — загрузить оттуда же. Удалять не нужно.
  ipcMain.handle('ext:enable', async (_e, id: string, on: boolean) => {
    const ext = session.fromPartition(PARTITION).extensions
    if (!on) {
      const e = ext.getExtension(id)
      if (!e) return
      ext.removeExtension(id)
      setAddons({ disabledExtensions: [...settings.addons.disabledExtensions.filter((d) => d.id !== id), { id, name: e.name, path: e.path }] })
    } else {
      const d = settings.addons.disabledExtensions.find((x) => x.id === id)
      if (!d) return
      setAddons({ disabledExtensions: settings.addons.disabledExtensions.filter((x) => x.id !== id) })
      await ext.loadExtension(d.path, { allowFileAccess: !extensions.infoOfDisabled(d).store }).catch((err) => console.error('Не удалось включить расширение', err))
    }
    extChanged()
  })
  ipcMain.on('ext:install-answer', (_e, id: string, allow: boolean) => {
    installPrompts.get(id)?.(!!allow)
    installPrompts.delete(id)
  })
  ipcMain.on('ext:active-tab', (_e, wcId: number) => extensions.selectTab(Number(wcId)))
  ipcMain.on('ext:menu-click', (_e, index: number) => extensions.clickMenuItem(Number(index)))

  ipcMain.on('permission:answer', (_e, id: string, allow: boolean, remember: boolean) => {
    const done = pendingPermissions.get(id)
    pendingPermissions.delete(id)
    done?.(allow, remember)
  })
  ipcMain.handle('permission:list', () =>
    Object.entries(decisions).map(([key, allow]) => {
      const cut = key.lastIndexOf('|')
      const origin = key.slice(0, cut)
      const permission = key.slice(cut + 1)
      return { origin, site: originLabel(origin), permission, label: permissionLabels[permission] ?? permission, allow }
    })
  )
  ipcMain.on('permission:forget', (_e, origin: unknown, permission: unknown) => {
    if (typeof origin !== 'string' || typeof permission !== 'string') return
    delete decisions[origin + '|' + permission]
    permissionsFile.write(decisions, 0)
  })

  ipcMain.handle('cursor', () => {
    const p = screen.getCursorScreenPoint()
    const b = win?.getContentBounds() ?? { x: 0, y: 0 }
    return { x: p.x - b.x, y: p.y - b.y }
  })

  ipcMain.handle('suggest', async (_e, q: string) => {
    try {
      const url =
        'https://suggestqueries.google.com/complete/search?client=chrome&hl=ru&ie=utf-8&oe=utf-8&q=' +
        encodeURIComponent(q)
      const res = await net.fetch(url)
      const data = (await res.json()) as [string, string[]]
      return Array.isArray(data[1]) ? data[1].slice(0, 5) : []
    } catch {
      return []
    }
  })

  ipcMain.handle('wallpaper:pick', async () => {
    if (!win) return null
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Картинка для фона Masaki',
      properties: ['openFile'],
      filters: [{ name: 'Картинки', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif'] }]
    })
    if (canceled || !filePaths[0]) return null
    const src = filePaths[0]
    if ((await fs.promises.stat(src)).size > 40 * 1024 * 1024) return null
    // Копия в профиле: фон не пропадёт, если исходный файл переместят или удалят.
    const dir = app.getPath('userData')
    for (const f of await fs.promises.readdir(dir)) {
      if (f.startsWith('custom-wallpaper.')) await fs.promises.rm(path.join(dir, f), { force: true })
    }
    const dest = path.join(dir, 'custom-wallpaper' + path.extname(src).toLowerCase())
    await fs.promises.copyFile(src, dest)
    return readImageAsDataUrl(dest)
  })
  ipcMain.handle('wallpaper:custom', async () => {
    const dir = app.getPath('userData')
    const f = (await fs.promises.readdir(dir)).find((x) => x.startsWith('custom-wallpaper.'))
    return f ? readImageAsDataUrl(path.join(dir, f)) : null
  })

  ipcMain.handle('wallpaper', async () => {
    // Обои системы Masaki умеет брать только у Windows; на Mac в настройках этого пункта нет.
    if (process.platform !== 'win32') return null
    const file = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper')
    try {
      const buf = await fs.promises.readFile(file)
      return 'data:image/jpeg;base64,' + buf.toString('base64')
    } catch {
      return null
    }
  })
}

const imageTypes: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
}

async function readImageAsDataUrl(file: string): Promise<string | null> {
  try {
    const buf = await fs.promises.readFile(file)
    return `data:${imageTypes[path.extname(file).toLowerCase()] ?? 'image/jpeg'};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

// ---------- Значки сайтов ----------

function iconHost(url: string): string | null {
  try {
    const u = new URL(url)
    // Карты живут на google.com/maps, но значок у них свой.
    if (/(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname.startsWith('/maps')) return 'maps.google.com'
    return u.hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

async function fetchAsDataUrl(url: string, maxBytes = 200_000): Promise<string | null> {
  try {
    const res = await session.fromPartition(PARTITION).fetch(url)
    if (!res.ok) return null
    const type = (res.headers.get('content-type') ?? 'image/png').split(';')[0]
    if (!type.startsWith('image/')) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxBytes) return null
    return `data:${type};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

function rememberFavicon(host: string, data: string): void {
  if (favicons[host] === data) return
  favicons[host] = data
  faviconFile.write(favicons, 2000)
  win?.webContents.send('favicon-updated', host)
}

// ---------- Аккаунты Google ----------
// Тот же адрес, которым Chrome узнаёт, кто вошёл: ответ зависит только от cookie сессии вкладок.

/** Аккаунты Google, в которые вошли во вкладках; null — Google не ответил (сеть), а не «никого нет». */
async function fetchGoogleAccounts(): Promise<GoogleAccount[] | null> {
  try {
    const res = await session
      .fromPartition(PARTITION)
      .fetch('https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard', {
        method: 'POST',
        body: '',
        credentials: 'include'
      })
    const text = (await res.text()).replace(/^\)\]\}'\s*/, '')
    const data = JSON.parse(text) as [string, unknown[][]]
    const list = Array.isArray(data[1]) ? data[1] : []
    return list
      .filter((a) => Array.isArray(a) && typeof a[3] === 'string')
      .map((a, i) => ({
        name: String(a[2] ?? ''),
        email: String(a[3]),
        photo: typeof a[4] === 'string' ? a[4] : '',
        index: typeof a[7] === 'number' ? a[7] : i
      }))
  } catch {
    return null
  }
}

// ---------- Запуск ----------

// Значки кнопок расширений интерфейс берёт по адресу crx://extension-icon/… (обслуживает electron-chrome-extensions).
protocol.registerSchemesAsPrivileged([{ scheme: 'crx', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
    const url = urlFromArgv(argv)
    if (url) send({ type: 'open-url', url })
  })

  app.whenReady().then(async () => {
    settings = mergeSettings(await settingsFile.read())
    setDiscordEnabled(settings.addons.discord.enabled)
    history = (await historyFile.read()) ?? []
    favicons = (await faviconFile.read()) ?? {}
    decisions = migratePermissions((await permissionsFile.read()) ?? {})
    lastTabs = (await sessionFile.read())?.tabs ?? []
    nativeTheme.themeSource = settings.scheme
    // Mac без меню «Правка» не копирует и не вставляет в полях (Cmd+C/V идут через него). Меню
    // «Файл» не ставим: его Cmd+W закрыл бы окно, а у Masaki это «закрыть вкладку».
    Menu.setApplicationMenu(
      process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null
    )
    setupBrowsingSession()
    registerIpc()
    registerPasswordIpc()
    await passwords.initPasswords({
      ui: (channel, payload) => win?.webContents.send(channel, payload),
      changed: () => sync.onPasswordsChanged()
    })
    await passkeys.initPasskeys({
      ui: (channel, payload) => win?.webContents.send(channel, payload),
      changed: () => sync.onPasswordsChanged(),
      backedUp: () => sync.getState().vault === 'ready'
    })
    await startSync()
    initYouCloud(PARTITION, {
      openUrl: (url) => send({ type: 'open-url', url }),
      closeTab: (wcId, then) => send({ type: 'close-wc', wcId, then })
    })
    // До окна: вкладки должны сразу попадать к расширениям, а установленные из магазина — быть загружены.
    await startExtensions().catch((e) => console.error('Расширения не запустились', e))
    void loadSavedExtensions()
    if (settings.addons.adblock.enabled) void applyAdblock(true)
    createWindow(await windowFile.read())
    void refreshRegistration()
    updater.initUpdater((st) => win?.webContents.send('update-state', st))
  })

  app.on('before-quit', () => {
    settingsFile.flushSync()
    sessionFile.flushSync()
    historyFile.flushSync()
    windowFile.flushSync()
    faviconFile.flushSync()
    permissionsFile.flushSync()
    sync.flushSync()
    passwords.flushPasswords()
    passkeys.flushPasskeys()
  })

  app.on('window-all-closed', () => app.quit())
}
