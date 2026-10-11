// Типы, общие для главного процесса, preload и интерфейса.

export type Scheme = 'system' | 'light' | 'dark'
/** violet | mint | peach — ручные; wallpaper — из обоев; custom — свой цвет; остальные — готовые по базовому цвету. */
export type PaletteId = string
export type GlassLevel = 's' | 'm' | 'l'
export type BackgroundMode = 'shapes' | 'wallpaper' | 'custom'

export type ClockStyle =
  | 'flex'
  | 'bubble'
  | 'metro'
  | 'analog'
  | 'serif'
  | 'condensed'
  | 'overlap'
  | 'numerals'
  | 'summary'

export type ClockColor = 'auto' | 'primary' | 'tertiary' | 'neutral'

export interface ClockSettings {
  style: ClockStyle
  color: ClockColor
  size: 'dynamic' | 'small'
  /** Только для «Стандартных»: скруглённые или острые цифры. */
  rounded: boolean
  /** Только для «Стандартных»: толщина 0..100, широкие тонкие ↔ узкие жирные, как ползунок на Pixel. */
  thickness: number
}

export interface Shortcut {
  title: string
  url: string
  /** Форма плитки из библиотеки M3 Expressive (имя из shapes.ts). */
  shape?: string
  /** Цвет фона плитки, '#rrggbb'. Нет поля — «Авто»: цвет берётся из значка сайта. */
  color?: string
}

/** Запрос сайта на доступ (геопозиция, камера, уведомления…), который показывает интерфейс. */
export interface PermissionPrompt {
  id: string
  origin: string
  kind: 'location' | 'camera' | 'mic' | 'media' | 'notifications' | 'clipboard' | 'other'
  text: string
}

export interface SitePermission {
  origin: string
  permission: string
  label: string
  allow: boolean
}

export interface GoogleAccount {
  name: string
  email: string
  photo: string
  /** Номер аккаунта для authuser=N. */
  index: number
}

/** То, что нужно интерфейсу, чтобы нарисовать своё контекстное меню страницы. */
export interface PageMenuParams {
  wcId: number
  x: number
  y: number
  linkURL: string
  linkText: string
  srcURL: string
  mediaType: string
  isEditable: boolean
  selectionText: string
  misspelledWord: string
  dictionarySuggestions: string[]
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canUndo: boolean; canRedo: boolean }
  mediaFlags: {
    isPaused: boolean
    isMuted: boolean
    isLooping: boolean
    isControlsVisible: boolean
    canToggleControls: boolean
    canShowPictureInPicture: boolean
    hasAudio: boolean
  }
  pageURL: string
  canGoBack: boolean
  canGoForward: boolean
  /** Пункты расширений (chrome.contextMenus). */
  extItems?: ExtMenuItem[]
}

export type PageAction =
  | { type: 'edit'; cmd: 'cut' | 'copy' | 'paste' | 'selectAll' | 'undo' | 'redo' }
  | { type: 'replace'; word: string }
  | { type: 'add-word'; word: string }
  | { type: 'copy-image'; x: number; y: number }
  | { type: 'download'; url: string }
  | { type: 'save-page' }
  | { type: 'print' }
  | { type: 'inspect'; x: number; y: number }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'reload' }
  | { type: 'media'; op: 'pip' | 'loop' | 'controls' | 'mute' | 'play'; x: number; y: number }
  | { type: 'copy-frame'; x: number; y: number }
  | { type: 'paste-plain' }
  | { type: 'pdf' }

export interface AddonSettings {
  /** Прозрачные сайты, как моды Zen: фон страницы прозрачный, видно матовое стекло. */
  glass: {
    enabled: boolean
    /** soft — только фон страницы; strong — ещё и крупные контейнеры сайта. */
    strength: 'soft' | 'strong'
    /** Насколько прозрачен собственный цвет сайта, 20..90 %. */
    opacity: number
    /** «Как у панели»: под сайтом то же стекло, что у боковой панели, вместо своего цвета сайта. */
    match: boolean
    /** Сайты, где прозрачность выключена. */
    exclude: string[]
  }
  adblock: { enabled: boolean }
  /** Пути к распакованным расширениям Chrome. */
  extensions: string[]
  /** Закреплённые кнопки расширений (id) — видны в адресной капсуле. Своё у каждого компьютера. */
  pinnedExtensions: string[]
  /** Отключённые расширения: не загружаются, но остаются установленными. */
  disabledExtensions: { id: string; name: string; path: string }[]
}

export interface ExtensionInfo {
  id: string
  name: string
  version: string
  path: string
  /** Установлено из Chrome Web Store (обновляется само); иначе — распакованное из папки. */
  store: boolean
  enabled: boolean
  description?: string
  /** Значок картинкой data:. */
  icon?: string
  /** Страница параметров расширения (chrome-extension://…). */
  options?: string
}

/** Запрос «добавить расширение?» — из Chrome Web Store, перед установкой. */
export interface ExtInstallPrompt {
  id: string
  name: string
  icon?: string
  /** Что расширение сможет делать — человеческими словами. */
  permissions: string[]
}

/** Пункт расширения в контекстном меню страницы (chrome.contextMenus); щелчок — по index. */
export interface ExtMenuItem {
  index: number
  label: string
  type: 'normal' | 'checkbox' | 'radio' | 'separator'
  checked: boolean
  enabled: boolean
  children?: ExtMenuItem[]
}

/** Свойства кнопки расширения (chrome.action): общие и свои для отдельных вкладок. */
export interface ExtActionInfo {
  title?: string
  popup?: string
  /** Текст значка-бейджа и его цвет. */
  text?: string
  color?: string
  /** Меняется, когда расширение сменило картинку кнопки. */
  iconModified?: number
}

export interface ExtAction extends ExtActionInfo {
  id: string
  tabs: Record<string, ExtActionInfo>
}

export interface ExtActionsState {
  /** id webContents активной вкладки. */
  activeTabId?: number
  actions: ExtAction[]
}

export interface Settings {
  scheme: Scheme
  palette: PaletteId
  /** Базовый цвет для палитры «Свой цвет». */
  customColor: string
  glass: GlassLevel
  background: BackgroundMode
  sidebarCollapsed: boolean
  /** Кнопки окна спрятаны в язычок. */
  windowButtonsTucked: boolean
  aiDefault: boolean
  clock: ClockSettings
  shortcuts: Shortcut[]
  favorites: Shortcut[]
  addons: AddonSettings
  /** Через сколько часов неактивные вкладки уходят в архив; 0 — никогда. */
  archiveAfter: number
}

export const defaultSettings: Settings = {
  scheme: 'dark',
  palette: 'mint',
  customColor: '#7E57C2',
  glass: 'l',
  background: 'shapes',
  sidebarCollapsed: false,
  windowButtonsTucked: false,
  aiDefault: false,
  archiveAfter: 0,
  clock: { style: 'flex', color: 'auto', size: 'dynamic', rounded: true, thickness: 45 },
  shortcuts: [
    { title: 'YouTube', url: 'https://www.youtube.com/' },
    { title: 'GitHub', url: 'https://github.com/' },
    { title: 'Gmail', url: 'https://mail.google.com/' },
    { title: 'Карты', url: 'https://www.google.com/maps' },
    { title: 'Википедия', url: 'https://ru.wikipedia.org/' }
  ],
  addons: {
    glass: { enabled: false, strength: 'strong', opacity: 55, match: true, exclude: [] },
    adblock: { enabled: false },
    extensions: [],
    pinnedExtensions: [],
    disabledExtensions: []
  },
  favorites: [
    { title: 'Google', url: 'https://www.google.com/' },
    { title: 'YouTube', url: 'https://www.youtube.com/' },
    { title: 'GitHub', url: 'https://github.com/' },
    { title: 'Переводчик', url: 'https://translate.google.com/' }
  ]
}

export interface SavedTab {
  url: string
  title: string
  favicon?: string
  /** Группа вкладок (id из SavedSession.groups). */
  group?: string
}

/** Группа вкладок в боковой панели: имя, цвет, свёрнута ли. */
export interface TabGroup {
  id: string
  name: string
  color: string
  collapsed: boolean
}

/** Вкладка, убранная в архив за неактивность: ищется в палитре. */
export interface ArchivedTab {
  url: string
  title: string
  favicon?: string
  time: number
}

export interface SavedSession {
  tabs: SavedTab[]
  active: number
  groups?: TabGroup[]
  archive?: ArchivedTab[]
}

export interface HistoryEntry {
  url: string
  title: string
  time: number
}

/** Профиль Chrome, из которого можно перенести данные. */
export interface ChromeProfile {
  dir: string
  name: string
  bookmarks: number
  shortcuts: number
  history: boolean
}

export interface ChromeImportResult {
  bookmarks: Shortcut[]
  shortcuts: Shortcut[]
  /** Сколько страниц истории добавилось. */
  history: number
  error?: string
}

export interface DownloadInfo {
  id: string
  filename: string
  url: string
  path: string
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  received: number
  total: number
  startedAt: number
}

// ---------- Синхронизация через Google Диск ----------

/** Что синхронизировать. Названия групп совпадают с полями в prefs.json на Диске. */
export interface SyncOptions {
  /** Избранное и ярлыки новой вкладки. */
  bookmarks: boolean
  /** Оформление, часы, AI Mode, аддоны. */
  settings: boolean
  history: boolean
  /** Открытые вкладки: этот компьютер показывает свои и видит вкладки других устройств. */
  tabs: boolean
  /** Пароли — только зашифрованными ключом пользователя (Google их прочитать не может). */
  passwords: boolean
}

export interface SyncAccount {
  email: string
  name: string
  photo: string
}

/** Другое устройство с Masaki в том же аккаунте и его открытые вкладки. */
export interface SyncDevice {
  id: string
  name: string
  platform: string
  updated: number
  tabs: SavedTab[]
}

export interface SyncState {
  /** Свой ключ Google (OAuth-клиент): название проекта или хвост client_id; null — своего ключа нет. */
  client: string | null
  /** В сборку вшит ключ Masaki: свой ключ не нужен, вход — одной кнопкой. */
  builtinKey: boolean
  account: SyncAccount | null
  /** off — не вошли; waiting — ждём подтверждения входа во вкладке Google; signin — Google отозвал вход. */
  status: 'off' | 'waiting' | 'idle' | 'syncing' | 'error' | 'signin'
  lastSync: number
  error: string
  options: SyncOptions
  deviceName: string
  devices: SyncDevice[]
  /**
   * Пароли: off — выключены; checking — смотрим, есть ли они уже на Диске; needs-new — придумать ключ
   * шифрования; needs-key — ввести ключ, заданный на другом устройстве; ready — синхронизируются.
   */
  vault: 'off' | 'checking' | 'needs-new' | 'needs-key' | 'ready'
  vaultError: string
}

// ---------- Пароли ----------

/** Сохранённый пароль без самого пароля: интерфейс получает его только по запросу «показать». */
export interface PasswordItem {
  id: string
  origin: string
  host: string
  username: string
  note: string
  updated: number
  used: number
}

/** Предложение сохранить пароль после входа на сайт (сам пароль остаётся в главном процессе). */
export interface PasswordOffer {
  id: string
  host: string
  username: string
  /** true — для этого логина пароль уже был, предлагаем обновить. */
  update: boolean
}

/** Скачанный файл экспорта паролей (Google Password Manager, Chrome), который можно перенести. */
export interface PasswordCsv {
  id: string
  filename: string
  count: number
}

export interface PasswordImportResult {
  added: number
  updated: number
  skipped: number
  error?: string
}

/** Строка списка автозаполнения: сохранённый пароль или ключ доступа (passkey). */
export interface AutofillItem {
  id: string
  username: string
  host: string
  passkey?: boolean
}

/** Поле входа на странице получило фокус: где показать список аккаунтов для автозаполнения. */
export interface AutofillRequest {
  rect: { x: number; y: number; w: number; h: number }
  /** devicePixelRatio страницы: вместе с масштабом окна даёт масштаб вкладки. */
  dpr: number
  items: AutofillItem[]
  role: 'username' | 'password'
}

// ---------- Ключи доступа (passkey) ----------

/** Сохранённый ключ доступа без самого ключа. */
export interface PasskeyItem {
  id: string
  rpId: string
  userName: string
  displayName: string
  created: number
  used: number
}

/** Запрос сайта, который подтверждает пользователь в окне Masaki поверх вкладки. */
export interface PasskeyPrompt {
  id: string
  /** webContents вкладки, которая спрашивает. */
  wcId: number
  /** create — создать; get — войти; exists — ключ уже есть; none — ключей для сайта нет. */
  kind: 'create' | 'get' | 'exists' | 'none'
  rpId: string
  user?: { name: string; displayName: string }
  accounts: { id: string; userName: string; displayName: string }[]
  /** Ключи уходят в шифрованный сейф на Google Диске. */
  synced: boolean
}

/** Команды, которые главный процесс шлёт интерфейсу (хоткеи, контекстное меню, мышь). */
export type Command =
  | { type: 'new-tab' }
  | { type: 'close-tab' }
  | { type: 'reopen-tab' }
  | { type: 'next-tab' }
  | { type: 'prev-tab' }
  | { type: 'tab-index'; index: number }
  | { type: 'palette'; withUrl: boolean }
  | { type: 'toggle-sidebar' }
  /** wcId — вкладка, где нажали боковую кнопку мыши (при двух вкладках рядом она не обязательно активная). */
  | { type: 'back'; wcId?: number }
  | { type: 'forward'; wcId?: number }
  | { type: 'reload'; hard?: boolean }
  | { type: 'find' }
  /** wcId — вкладка под курсором при Ctrl+колесе, иначе активная. */
  | { type: 'zoom'; delta: 1 | -1 | 0; wcId?: number }
  | { type: 'devtools' }
  | { type: 'settings' }
  | { type: 'addons' }
  | { type: 'save-page' }
  | { type: 'view-source' }
  | { type: 'print' }
  | { type: 'escape' }
  | { type: 'open-url'; url: string; background?: boolean }
  | { type: 'search'; text: string; ai?: boolean }
  /** Закрыть вкладки, адрес которых начинается так (служебная страница входа в синхронизацию). */
  | { type: 'close-tabs'; prefix: string }
  /** Вкладку открыли ради скачивания файла, страницы в ней так и не появилось — закрыть, как Chrome. */
  | { type: 'close-empty-tab'; wcId: number }
  /** Поиск по вкладкам (Ctrl+Shift+A) — палитра в режиме вкладок. */
  | { type: 'tab-search' }
  /** Закрыть вкладку входа (YouCloud) и вернуться во вкладку then, если она ещё открыта. */
  | { type: 'close-wc'; wcId: number; then?: number }
  /** Сделать активной вкладку с этим webContents (просьба расширения, chrome.tabs.update). */
  | { type: 'activate-wc'; wcId: number }
  /** Остановить загрузку страницы (клавиша «Стоп» на клавиатуре). */
  | { type: 'stop' }
  /** Звёздочка: добавить страницу в избранное или убрать (Ctrl+D). */
  | { type: 'favorite' }
  /** История — палитра без запроса, как кнопка «История» в панели (Ctrl+H). */
  | { type: 'history' }
  /** Загрузки (Ctrl+J): всплывающее окно открывается и закрывается тем же сочетанием. */
  | { type: 'downloads' }
  /** Меню Masaki (Alt+F, Alt+E, F10). */
  | { type: 'menu' }
  /** Переставить активную вкладку на одно место влево или вправо (Ctrl+Shift+PageUp/PageDown). */
  | { type: 'move-tab'; delta: -1 | 1 }
  /** Следующее или предыдущее совпадение поиска на странице; поиск закрыт — открыть его (F3, Ctrl+G). */
  | { type: 'find-next'; back?: boolean }

export interface WindowState {
  maximized: boolean
  fullscreen: boolean
}

export interface MasakiApi {
  platform: string
  versions: { electron: string; chrome: string; node: string }
  win: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    /** Поставить окно в долю рабочей области экрана (свои раскладки вместо Snap Layouts). */
    snap(r: { x: number; y: number; w: number; h: number }): void
    setFullScreen(on: boolean): void
    onState(cb: (s: WindowState) => void): () => void
  }
  onCommand(cb: (c: Command) => void): () => void
  /** Боковая кнопка мыши над самим интерфейсом (над страницей её ловит preload/guest.ts): назад или вперёд в активной вкладке. */
  navMouse(dir: 'back' | 'forward'): void
  settings: {
    get(): Promise<Settings>
    set(s: Settings): void
    /** Настройки поменялись не из интерфейса (пришли синхронизацией). */
    onChanged(cb: (s: Settings) => void): () => void
  }
  session: {
    load(): Promise<SavedSession | null>
    save(s: SavedSession): void
  }
  history: {
    list(): Promise<HistoryEntry[]>
    add(e: HistoryEntry): void
    clear(): void
    onChanged(cb: (h: HistoryEntry[]) => void): () => void
  }
  downloads: {
    onUpdate(cb: (d: DownloadInfo) => void): () => void
    open(path: string): void
    showInFolder(path: string): void
    /** Начать перетаскивание скачанного файла из списка загрузок в проводник или сайт. */
    drag(path: string): void
  }
  /** Данные сайтов: очистить для одного адреса или кэш целиком (команды палитры). */
  site: {
    clearData(origin: string): Promise<void>
    clearCache(): Promise<void>
  }
  adblock: {
    /** Включить или выключить блокировку; при первом включении скачиваются фильтры. */
    set(enabled: boolean): Promise<{ ok: boolean; error?: string }>
  }
  extensions: {
    list(): Promise<ExtensionInfo[]>
    /** Выбрать папку распакованного расширения и загрузить его. */
    add(): Promise<{ ok: boolean; ext?: ExtensionInfo; error?: string } | null>
    /** Удалить: из магазина — вместе с файлами, распакованное — только из Masaki. */
    remove(id: string): Promise<void>
    setEnabled(id: string, on: boolean): Promise<void>
    /** Список расширений поменялся (установили из магазина, обновилось, удалили). */
    onChanged(cb: () => void): () => void
    /** Магазин спрашивает, ставить ли расширение; ответ — answerInstall. */
    onInstallPrompt(cb: (p: ExtInstallPrompt) => void): () => void
    answerInstall(id: string, allow: boolean): void
    /** Активная вкладка поменялась (id её webContents) — для chrome.tabs и состояния кнопок. */
    activeTab(wcId: number): void
    /** Кнопки расширений (chrome.action) и их обновления. */
    actions(): Promise<ExtActionsState>
    onActionsChanged(cb: () => void): () => void
    /** Нажатие на кнопку расширения: всплывающее окно у anchor или chrome.action.onClicked. */
    activate(id: string, tabId: number, anchor: { x: number; y: number; width: number; height: number }, alignment: string): void
    /** Щелчок по пункту расширения в контекстном меню страницы. */
    menuClick(index: number): void
  }
  /** Снимок страницы вкладки для превью при наведении (data URL, ширина 480). */
  captureTab(wcId: number): Promise<string | null>
  /** Значок сайта (data URL), как на плитках новой вкладки Chrome. */
  favicon(url: string): Promise<string | null>
  /** Запомнить значок, который сайт сам показал во вкладке: он точнее значка из сервиса Google. */
  learnFavicon(pageUrl: string, iconUrl: string): void
  onFaviconUpdated(cb: (host: string) => void): () => void
  google: {
    accounts(): Promise<GoogleAccount[]>
  }
  sync: {
    state(): Promise<SyncState>
    onState(cb: (s: SyncState) => void): () => void
    /** Выбрать JSON-файл OAuth-клиента, скачанный из Google Cloud. */
    pickClient(): Promise<{ ok: boolean; error?: string } | null>
    setClient(id: string, secret: string): Promise<{ ok: boolean; error?: string }>
    removeClient(): void
    /**
     * Вход: страница Google открывается вкладкой Masaki (external — в системном браузере).
     * hint — почта аккаунта, в который уже вошли: Google не спрашивает, какой выбрать.
     */
    signIn(external?: boolean, hint?: string): Promise<{ ok: boolean; error?: string }>
    cancelSignIn(): void
    signOut(): Promise<void>
    syncNow(): Promise<void>
    setOptions(o: Partial<SyncOptions>): void
    setDeviceName(name: string): void
    forgetDevice(id: string): Promise<void>
    /** Удалить с Диска всё, что туда положил Masaki. */
    wipe(): Promise<{ ok: boolean; error?: string }>
    /** Ключ шифрования паролей: новый (если на Диске паролей ещё нет) или уже заданный на другом устройстве. */
    setVaultKey(passphrase: string): Promise<{ ok: boolean; error?: string }>
    /** Забыли ключ: удалить пароли с Диска и задать новый ключ (на компьютерах пароли останутся). */
    resetVault(): Promise<{ ok: boolean; error?: string }>
  }
  passwords: {
    list(): Promise<PasswordItem[]>
    /** Сам пароль — только для показа в менеджере паролей. */
    reveal(id: string): Promise<string | null>
    /** Скопировать пароль в буфер обмена (через минуту он оттуда уберётся). */
    copy(id: string): Promise<boolean>
    save(p: { id?: string; url: string; username: string; password?: string; note?: string }): Promise<{ ok: boolean; error?: string }>
    remove(id: string): Promise<void>
    importFile(): Promise<PasswordImportResult | null>
    /** Перенести скачанный файл экспорта и удалить его с диска. */
    importDownloaded(id: string): Promise<PasswordImportResult>
    dismissCsv(id: string): void
    onCsv(cb: (c: PasswordCsv) => void): () => void
    onOffer(cb: (o: PasswordOffer) => void): () => void
    answer(id: string, action: 'save' | 'never' | 'dismiss'): void
    /** Вписать логин и пароль в страницу вкладки (wcId — webContents вкладки). */
    fill(wcId: number, id: string): void
    never(): Promise<string[]>
    forgetNever(origin: string): void
    onChanged(cb: () => void): () => void
  }
  passkeys: {
    list(): Promise<PasskeyItem[]>
    remove(id: string): Promise<void>
    onChanged(cb: () => void): () => void
    onPrompt(cb: (p: PasskeyPrompt) => void): () => void
    onPromptClose(cb: (id: string) => void): () => void
    /** ok — создать / войти выбранным аккаунтом (account — id записи); other — ключ безопасности. */
    answer(id: string, action: 'ok' | 'cancel' | 'other', account?: string): void
    /** Ключ выбран в списке автозаполнения у поля входа (wcId — webContents вкладки). */
    useConditional(wcId: number, id: string): void
  }
  chrome: {
    profiles(): Promise<ChromeProfile[]>
    import(dir: string, what: { bookmarks: boolean; shortcuts: boolean; history: boolean }): Promise<ChromeImportResult>
  }
  onPageMenu(cb: (p: PageMenuParams) => void): () => void
  permissions: {
    onPrompt(cb: (p: PermissionPrompt) => void): () => void
    onDismiss(cb: (id: string) => void): () => void
    answer(id: string, allow: boolean, remember: boolean): void
    list(): Promise<SitePermission[]>
    forget(origin: string, permission: string): void
  }
  pageAction(wcId: number, a: PageAction): void
  uiEdit(cmd: 'cut' | 'copy' | 'paste' | 'selectAll' | 'undo' | 'redo'): void
  copyText(text: string): void
  /** Положение курсора относительно окна — нужно там, где страница во вкладке «съедает» уход мыши. */
  cursor(): Promise<{ x: number; y: number }>
  suggest(q: string): Promise<string[]>
  wallpaper(): Promise<string | null>
  /** Своя картинка фона: выбрать файл (копия ляжет в профиль) и прочитать сохранённую. */
  pickWallpaper(): Promise<string | null>
  customWallpaper(): Promise<string | null>
  /** Обложка того, что играет во вкладке, — data: (для цвета мини-плеера). */
  mediaArt(url: string): Promise<string | null>
}
