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
  screen,
  session,
  shell,
  webContents,
  type ContextMenuParams,
  type WebContents
} from 'electron'
import fs from 'fs'
import path from 'path'
import { ElectronBlocker } from '@ghostery/adblocker-electron'
import { JsonFile } from './store'
import { chromeBookmarks, chromeHistory, chromeProfiles, chromeShortcuts } from './chromeImport'
import * as sync from './sync'
import * as passwords from './passwords'
import * as passkeys from './passkeys'
import { initYouCloud, isYouCloudExtension, overrideHeaders, watchWebview, YOUCLOUD_HEADER_URLS } from './youcloud'
import { commandFor } from '../shared/shortcuts'
import {
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
// И отдельная папка загрузок: тест паролей скачивает подставной CSV.
if (process.env.MASAKI_DOWNLOADS) app.setPath('downloads', process.env.MASAKI_DOWNLOADS)

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
      extensions: a?.extensions ?? []
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
    canGoForward: nav.canGoForward()
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
  return { id: e.id, name: e.name, version: e.version, path: e.path }
}

async function loadSavedExtensions(): Promise<void> {
  const ext = session.fromPartition(PARTITION).extensions
  for (const p of settings.addons.extensions) {
    // YouCloud встроен в Masaki: его расширение здесь не работает и мешало бы мосту.
    if (isYouCloudExtension(p)) continue
    try {
      await ext.loadExtension(p, { allowFileAccess: true })
    } catch (e) {
      console.error('Не удалось загрузить расширение', p, e)
    }
  }
}

// ---------- Сессия вкладок: права, загрузки ----------

/** Файлы, скачанные в этом запуске: только их можно перетаскивать из списка загрузок. */
const downloadedFiles = new Set<string>()
const alwaysAllowed = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock'])
const permissionsFile = new JsonFile<Record<string, boolean>>('permissions.json')
let decisions: Record<string, boolean> = {}
const pendingPermissions = new Map<string, (allow: boolean, remember: boolean) => void>()

function originOf(url: string): string {
  try {
    return new URL(url).host || 'Этот файл'
  } catch {
    return url
  }
}

const permissionLabels: Record<string, string> = {
  geolocation: 'Местоположение',
  media: 'Камера и микрофон',
  notifications: 'Уведомления',
  'clipboard-read': 'Буфер обмена',
  midi: 'MIDI-устройства',
  midiSysex: 'MIDI-устройства',
  'idle-detection': 'Данные об активности',
  'storage-access': 'Хранилище других сайтов',
  'top-level-storage-access': 'Хранилище других сайтов'
}

function describePermission(permission: string, details: { mediaTypes?: string[] }): Omit<PermissionPrompt, 'id' | 'origin'> | null {
  switch (permission) {
    case 'geolocation':
      return { kind: 'location', text: 'хочет знать, где вы находитесь' }
    case 'media': {
      const types = details.mediaTypes ?? []
      if (types.includes('video') && types.includes('audio')) return { kind: 'media', text: 'хочет использовать камеру и микрофон' }
      if (types.includes('video')) return { kind: 'camera', text: 'хочет использовать камеру' }
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

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (alwaysAllowed.has(permission)) return true
    const known = decisions[originOf(requestingOrigin) + '|' + permission]
    return known === true
  })

  // Вопрос задаёт интерфейс Masaki (стеклянная плашка), а не системное окно Windows.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (alwaysAllowed.has(permission)) return callback(true)
    const prompt = describePermission(permission, details as { mediaTypes?: string[] })
    if (!prompt || !win) return callback(false)
    const origin = originOf(details.requestingUrl)
    const key = origin + '|' + permission
    if (key in decisions) return callback(decisions[key])
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    pendingPermissions.set(id, (allow, remember) => {
      if (remember) {
        decisions[key] = allow
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
    win.webContents.send('permission', { id, origin, ...prompt })
  })

  ses.on('will-download', (_e, item, wc) => {
    // Ссылка открылась новой вкладкой, а там файл: страница не загрузилась, вкладка осталась пустой.
    if (wc && !wc.isDestroyed() && wc.getType() === 'webview' && (!wc.getURL() || wc.getURL() === 'about:blank')) {
      send({ type: 'close-empty-tab', wcId: wc.id })
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const target = uniquePath(app.getPath('downloads'), item.getFilename())
    item.setSavePath(target)
    downloadedFiles.add(target)
    const info = (): DownloadInfo => ({
      id,
      filename: path.basename(item.getSavePath() || target),
      url: item.getURL(),
      path: item.getSavePath() || target,
      state: item.getState(),
      received: item.getReceivedBytes(),
      total: item.getTotalBytes(),
      startedAt: item.getStartTime() * 1000
    })
    win?.webContents.send('download', info())
    item.on('updated', () => win?.webContents.send('download', info()))
    item.once('done', (_ev, state) => {
      win?.webContents.send('download', info())
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
    frame: false,
    show: false,
    title: 'Masaki',
    icon: app.isPackaged ? undefined : path.join(__dirname, '../../build/icon.png'),
    backgroundColor: dark ? '#0D1513' : '#E3F1EE',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      webviewTag: true,
      sandbox: true,
      spellcheck: true
    }
  })

  win.once('ready-to-show', () => {
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
  // Боковые кнопки мыши «назад/вперёд».
  win.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward') send({ type: 'back' })
    if (cmd === 'browser-forward') send({ type: 'forward' })
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

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return
  attachShortcuts(contents, true)
  watchWebview(contents)
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
        overrideBrowserWindowOptions: { width: 520, height: 700, autoHideMenuBar: true, backgroundColor: '#ffffff' }
      }
    }
    send({ type: 'open-url', url, background: disposition === 'background-tab' })
    return { action: 'deny' }
  })
})

// ---------- Настройки ----------

/** Новые настройки из интерфейса или с Диска (fromSync — тогда интерфейсу нужно о них узнать). */
function applySettings(s: Settings, fromSync = false): void {
  const adblockWas = settings.addons.adblock.enabled
  settings = mergeSettings(s)
  if (settings.addons.adblock.enabled !== adblockWas) void applyAdblock(settings.addons.adblock.enabled)
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

  ipcMain.on('dl:open', (_e, p: string) => void shell.openPath(p))
  ipcMain.on('dl:show', (_e, p: string) => shell.showItemInFolder(p))
  // Перетащить скачанный файл в проводник или на сайт — только файлы из своего списка загрузок.
  ipcMain.on('dl:drag', async (e, p: string) => {
    if (!downloadedFiles.has(p) || !fs.existsSync(p)) return
    const icon = await app.getFileIcon(p, { size: 'normal' })
    e.sender.startDrag({ file: p, icon })
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
  ipcMain.on('favicon:learn', async (_e, pageUrl: string, iconUrl: string) => {
    const host = iconHost(pageUrl)
    if (!host || !/^(https?|data):/i.test(iconUrl)) return
    const data = iconUrl.startsWith('data:') ? iconUrl : await fetchAsDataUrl(iconUrl)
    if (data) rememberFavicon(host, data)
  })

  ipcMain.handle('google:accounts', () => googleAccounts())
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
  ipcMain.handle('sync:sign-in', (_e, external: boolean) => sync.signIn(!!external))
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
  ipcMain.handle('ext:list', () => session.fromPartition(PARTITION).extensions.getAllExtensions().map(extInfo))
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
  ipcMain.handle('ext:remove', (_e, id: string) => session.fromPartition(PARTITION).extensions.removeExtension(id))

  ipcMain.on('permission:answer', (_e, id: string, allow: boolean, remember: boolean) => {
    const done = pendingPermissions.get(id)
    pendingPermissions.delete(id)
    done?.(allow, remember)
  })
  ipcMain.handle('permission:list', () =>
    Object.entries(decisions).map(([key, allow]) => {
      const [origin, permission] = key.split('|')
      return { origin, permission, label: permissionLabels[permission] ?? permission, allow }
    })
  )
  ipcMain.on('permission:forget', (_e, origin: string, permission: string) => {
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

async function googleAccounts(): Promise<GoogleAccount[]> {
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
    return []
  }
}

// ---------- Запуск ----------

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
    const url = argv.find((a) => /^https?:\/\//i.test(a))
    if (url) send({ type: 'open-url', url })
  })

  app.whenReady().then(async () => {
    settings = mergeSettings(await settingsFile.read())
    history = (await historyFile.read()) ?? []
    favicons = (await faviconFile.read()) ?? {}
    decisions = (await permissionsFile.read()) ?? {}
    lastTabs = (await sessionFile.read())?.tabs ?? []
    nativeTheme.themeSource = settings.scheme
    Menu.setApplicationMenu(null)
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
    void loadSavedExtensions()
    if (settings.addons.adblock.enabled) void applyAdblock(true)
    createWindow(await windowFile.read())
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
