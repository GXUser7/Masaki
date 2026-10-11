import { create } from 'zustand'
import type {
  ArchivedTab,
  AutofillRequest,
  DownloadInfo,
  GoogleAccount,
  HistoryEntry,
  PasskeyPrompt,
  PasswordCsv,
  PasswordOffer,
  PermissionPrompt,
  ProfileInfo,
  SavedSession,
  Settings,
  SyncState,
  TabGroup
} from '../../shared/types'
import type { MenuEntry } from './components/Menu'
import { defaultSettings } from '../../shared/types'
import { ADDONS_URL, hostOf, NEWTAB_URL, PASSWORDS_URL, resolveInput, SETTINGS_URL } from './lib/url'

export type TabKind = 'newtab' | 'web' | 'settings' | 'addons' | 'passwords'

/** Внутренние страницы Masaki: React-компоненты вместо webview. */
export const internalPages: Record<'settings' | 'addons' | 'passwords', { url: string; title: string }> = {
  settings: { url: SETTINGS_URL, title: 'Настройки' },
  addons: { url: ADDONS_URL, title: 'Аддоны' },
  passwords: { url: PASSWORDS_URL, title: 'Пароли' }
}
const internalKind = (url: string): keyof typeof internalPages | null =>
  (Object.keys(internalPages) as (keyof typeof internalPages)[]).find((k) => url.startsWith(internalPages[k].url)) ?? null

export interface Tab {
  id: string
  kind: TabKind
  /** Текущий адрес вкладки. */
  url: string
  /** Адрес, с которым webview создаётся; дальше навигация идёт через loadURL. */
  initialUrl: string
  title: string
  favicon?: string
  loading: boolean
  canBack: boolean
  canFwd: boolean
  audible: boolean
  muted: boolean
  zoom: number
  error?: { code: number; desc: string; url: string }
  /** Аддон «Прозрачные сайты»: исходный цвет фона сайта «r,g,b», если прозрачность включена. */
  glassBg?: string
  /** Группа вкладок (id из Store.groups). */
  group?: string
  /** Когда вкладку в последний раз оставили (для превью «в фоне N мин» и архива). */
  lastActive?: number
  /** Звук поставлен на паузу из мини-плеера — плеер остаётся, чтобы можно было продолжить. */
  pausedByUs?: boolean
  /** Что играет, по Media Session сайта (preload/media-page.ts): для мини-плеера с обложкой. */
  media?: TabMedia
}

export interface TabMedia {
  title: string
  artist: string
  album: string
  /** Обложка: https: или data:image — остальное отброшено. */
  artwork: string
  /** Кнопки, которые сайт умеет сам: nexttrack, previoustrack, seekto… */
  actions: string[]
  playing: boolean
  /** Где трек на момент at (мс), с какой скоростью идёт; null — длина неизвестна. */
  position: { duration: number; position: number; rate: number; at: number } | null
}

/** Цвета групп вкладок: светлые тона, читаются и в тёмной, и в светлой теме. */
export const groupColors = ['#7FB3F0', '#7FD1A8', '#E9C46A', '#F28B82', '#C3A6F5', '#F5A3C7', '#7DD3E0', '#F6B26B']

/** Поле, из которого раскрывается палитра; на время её показа оно прячется. */
export type PaletteAnchor = 'ntp' | 'dock' | 'side'

export interface PaletteState {
  open: boolean
  anchor: PaletteAnchor
  text: string
  /** Выделить текст при открытии (когда подставлен адрес страницы). */
  select: boolean
  /** Куда открывать результат: в текущую вкладку или в новую. */
  target: 'current' | 'new'
  /** tabs — поиск по открытым вкладкам и архиву (Ctrl+Shift+A). */
  mode: 'all' | 'tabs'
}

export interface FindState {
  open: boolean
  text: string
  active: number
  matches: number
  /** Увеличивается на каждый Ctrl+F, чтобы поле поиска заново получило фокус. */
  focusTick: number
}

// ---------- Реестр webview: сами элементы живут в DOM, здесь только ссылки ----------

const webviews = new Map<string, Electron.WebviewTag>()
const ready = new Set<string>()

export function registerWebview(id: string, el: Electron.WebviewTag): void {
  webviews.set(id, el)
}
export function unregisterWebview(id: string): void {
  webviews.delete(id)
  ready.delete(id)
}
export function markReady(id: string): void {
  ready.add(id)
}
/** Вкладка по webContents её webview (главный процесс знает только его). */
export function tabIdOfWebContents(wcId: number): string | null {
  for (const [id, el] of webviews) {
    try {
      if (el.getWebContentsId() === wcId) return id
    } catch {
      // webview ещё не подключён
    }
  }
  return null
}

/** Снимок страницы вкладки для превью при наведении. */
export function captureThumb(id: string): void {
  const el = ready.has(id) ? webviews.get(id) : null
  if (!el) return
  void window.masaki
    .captureTab(el.getWebContentsId())
    .then((data) => {
      if (data) useStore.setState((st) => (st.tabs.some((t) => t.id === id) ? { thumbs: { ...st.thumbs, [id]: data } } : {}))
    })
    .catch(() => undefined)
}

/** Возвращает webview, только если он уже готов принимать команды (после dom-ready). */
export function wv(id: string): Electron.WebviewTag | null {
  return ready.has(id) ? (webviews.get(id) ?? null) : null
}

// ---------- Состояние ----------

let seq = 0
let stageBefore: DOMRect | null = null
/** Положение страницы до сворачивания/разворачивания панели (забирается один раз). */
export function takeStageBefore(): DOMRect | null {
  const r = stageBefore
  stageBefore = null
  return r
}
const newId = (): string => 't' + ++seq

function blankTab(kind: TabKind = 'newtab', url = NEWTAB_URL): Tab {
  return {
    id: newId(),
    kind,
    url,
    initialUrl: url,
    title: kind === 'newtab' ? 'Новая вкладка' : kind === 'web' ? hostOf(url) : internalPages[kind].title,
    loading: kind === 'web',
    canBack: false,
    canFwd: false,
    audible: false,
    muted: false,
    zoom: 0,
    lastActive: Date.now()
  }
}

/** Вкладки одной группы всегда стоят подряд — на месте первой из них. */
function contiguous(tabs: Tab[]): Tab[] {
  const out: Tab[] = []
  const done = new Set<string>()
  for (const t of tabs) {
    if (!t.group) {
      out.push(t)
      continue
    }
    if (done.has(t.group)) continue
    done.add(t.group)
    out.push(...tabs.filter((x) => x.group === t.group))
  }
  return out
}

function tabFor(url: string): Tab {
  const internal = internalKind(url)
  if (internal) return blankTab(internal, internalPages[internal].url)
  if (url === NEWTAB_URL || !url) return blankTab()
  return blankTab('web', url)
}

interface Store {
  booted: boolean
  settings: Settings
  tabs: Tab[]
  activeId: string
  closed: { url: string; title: string; index: number }[]
  ai: boolean
  palette: PaletteState
  find: FindState
  htmlFullscreen: boolean
  history: HistoryEntry[]
  downloads: DownloadInfo[]
  /** tabs — список всех вкладок дока («ещё N»), extensions — кнопки расширений. */
  popover: null | 'downloads' | 'menu' | 'accounts' | 'qr' | 'tabs' | 'extensions'
  /** Адрес для QR-кода страницы. */
  qrUrl: string
  winMaximized: boolean
  /** Открытое контекстное меню (стеклянное, рисуем сами). */
  menu: { x: number; y: number; entries: MenuEntry[] } | null
  accounts: GoogleAccount[]
  /** Профили Masaki (как в Chrome) — в меню аккаунта. */
  profiles: ProfileInfo[]
  /** Очередь запросов сайтов на доступ. */
  permissions: PermissionPrompt[]
  /** Растёт, когда выбрана новая своя картинка фона, — App перечитывает её. */
  wallpaperRev: number
  /** Синхронизация через Google Диск; null — главный процесс ещё не ответил. */
  sync: SyncState | null
  /** Предложения сохранить пароль после входа на сайт. */
  pwOffers: PasswordOffer[]
  /** Скачанные файлы экспорта паролей, которые можно перенести. */
  pwCsv: PasswordCsv[]
  /** Список аккаунтов у поля входа во вкладке. */
  autofill: { tabId: string; wcId: number; req: AutofillRequest } | null
  /** Растёт, когда меняется список паролей, — страница паролей перечитывает его. */
  pwRev: number
  /** Сайты просят создать ключ доступа или войти по нему — ждут ответа пользователя. */
  pkPrompts: PasskeyPrompt[]
  groups: TabGroup[]
  archive: ArchivedTab[]
  /** Свои раскладки окна у кнопки «развернуть»: где показать. */
  snap: { x: number; y: number } | null
  /** Превью вкладки при наведении в панели. */
  /** above — превью над вкладкой дока (x — середина вкладки), иначе справа от вкладки панели. */
  preview: { tabId: string; x: number; y: number; above?: boolean } | null
  /** Снимки вкладок, сделанные, когда их оставляли, — для превью. */
  thumbs: Record<string, string>
  /** «Взгляд»: ссылка открыта карточкой поверх страницы (Alt+клик). */
  glance: string | null
  /** Две вкладки рядом: a слева, b справа, ratio — доля левой. */
  split: { a: string; b: string; ratio: number } | null
  /** Капсула в свёрнутом режиме сжата, пока страницу листают вниз. */
  capsuleSmall: boolean
  /** Жест «назад/вперёд» с тачпада: сколько уже протянули. */
  swipe: { tabId: string; dx: number } | null

  boot(s: Settings, session: SavedSession | null, history: HistoryEntry[]): void
  setSettings(patch: Partial<Settings>): void
  active(): Tab
  updateTab(id: string, patch: Partial<Tab>): void
  newTab(url?: string, opts?: { background?: boolean }): string
  /** remember=false — не класть в «вернуть закрытую вкладку» (пустые служебные вкладки). */
  closeTab(id?: string, remember?: boolean): void
  reopenTab(): void
  activate(id: string): void
  cycle(delta: number): void
  activateIndex(index: number): void
  navigate(text: string, opts?: { ai?: boolean; target?: 'current' | 'new'; raw?: boolean }): void
  /** ai — открыть палитру сразу в режиме AI Mode; по умолчанию — как в настройках. */
  openPalette(withUrl: boolean, target?: 'current' | 'new', typed?: string, ai?: boolean): void
  closePalette(): void
  toggleSidebar(): void
  setAi(on: boolean): void
  openSettings(): void
  openAddons(): void
  openPasswords(): void
  /** Поиск по открытым вкладкам и архиву (Ctrl+Shift+A). */
  openTabSearch(): void
  /** Добавить вкладку в группу: id группы или 'new' — новая группа. */
  addToGroup(tabId: string, groupId: string): void
  removeFromGroup(tabId: string): void
  updateGroup(id: string, patch: Partial<TabGroup>): void
  ungroup(id: string): void
  closeGroup(id: string): void
  openSplit(otherId: string): void
  closeSplit(): void
  /** Убрать в архив вкладки, которые давно не открывали (настройка archiveAfter). */
  archiveStale(): void
  showQr(url: string): void
  setFind(patch: Partial<FindState>): void
  addHistory(url: string, title: string): void
  upsertDownload(d: DownloadInfo): void
  setPopover(p: Store['popover']): void
  openMenu(x: number, y: number, entries: MenuEntry[]): void
  closeMenu(): void
  loadAccounts(): void
  loadProfiles(): void
  addPermission(p: PermissionPrompt): void
  dropPermission(id: string): void
  moveTab(id: string, to: number): void
  duplicateTab(id: string): void
  closeOthers(id: string): void
  closeBelow(id: string): void
}

export const useStore = create<Store>((set, get) => ({
  booted: false,
  settings: defaultSettings,
  tabs: [],
  activeId: '',
  closed: [],
  ai: false,
  palette: { open: false, anchor: 'side', text: '', select: false, target: 'current', mode: 'all' },
  find: { open: false, text: '', active: 0, matches: 0, focusTick: 0 },
  htmlFullscreen: false,
  history: [],
  downloads: [],
  popover: null,
  qrUrl: '',
  winMaximized: false,
  menu: null,
  accounts: [],
  profiles: [],
  permissions: [],
  wallpaperRev: 0,
  sync: null,
  pwOffers: [],
  pwCsv: [],
  autofill: null,
  pwRev: 0,
  pkPrompts: [],
  groups: [],
  archive: [],
  snap: null,
  preview: null,
  thumbs: {},
  glance: null,
  split: null,
  capsuleSmall: false,
  swipe: null,

  boot(settings, session, history) {
    const saved = session?.tabs?.length ? session.tabs : null
    const groups = (session?.groups ?? []).filter((g) => saved?.some((t) => t.group === g.id))
    const now = Date.now()
    const tabs = saved
      ? saved.map((t) => ({
          ...tabFor(t.url),
          title: t.title || hostOf(t.url),
          favicon: t.favicon,
          group: groups.some((g) => g.id === t.group) ? t.group : undefined,
          lastActive: now
        }))
      : [blankTab()]
    const idx = Math.min(Math.max(session?.active ?? 0, 0), tabs.length - 1)
    set({ booted: true, settings, tabs, groups, archive: session?.archive ?? [], activeId: tabs[idx].id, ai: settings.aiDefault, history })
  },

  setSettings(patch) {
    const settings = { ...get().settings, ...patch }
    set({ settings })
    window.masaki.settings.set(settings)
  },

  active() {
    const s = get()
    return s.tabs.find((t) => t.id === s.activeId) ?? s.tabs[0]
  },

  updateTab(id, patch) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
  },

  newTab(url = NEWTAB_URL, opts = {}) {
    const tab = tabFor(url)
    // Уходим с вкладки — снимок для превью, пока она ещё видна.
    if (!opts.background && get().activeId) captureThumb(get().activeId)
    set((s) => {
      const at = s.tabs.findIndex((t) => t.id === s.activeId)
      const from = s.tabs[at]
      // Как в Chrome: ссылка из вкладки в группе попадает в ту же группу; пустая новая вкладка — нет,
      // она встаёт сразу после группы, чтобы не разрывать её.
      if (from?.group && url !== NEWTAB_URL) tab.group = from.group
      let pos = at + 1
      if (from?.group && !tab.group) {
        while (pos < s.tabs.length && s.tabs[pos].group === from.group) pos++
      }
      const tabs = s.tabs.slice()
      tabs.splice(pos, 0, tab)
      return { tabs: contiguous(tabs), activeId: opts.background ? s.activeId : tab.id, capsuleSmall: opts.background ? s.capsuleSmall : false }
    })
    return tab.id
  },

  closeTab(id, remember = true) {
    const s = get()
    const target = id ?? s.activeId
    const i = s.tabs.findIndex((t) => t.id === target)
    if (i < 0) return
    const tab = s.tabs[i]
    const closed = tab.kind === 'web' && remember ? [...s.closed, { url: tab.url, title: tab.title, index: i }].slice(-25) : s.closed
    let tabs = s.tabs.filter((t) => t.id !== target)
    if (!tabs.length) tabs = [blankTab()]
    // Закрыли вкладку из пары «рядом» — вторая встаёт на весь экран.
    const partner = s.split && (s.split.a === target ? s.split.b : s.split.b === target ? s.split.a : null)
    const activeId = s.activeId === target ? (partner ?? tabs[Math.min(i, tabs.length - 1)].id) : s.activeId
    const groups = s.groups.filter((g) => tabs.some((t) => t.group === g.id))
    const thumbs = { ...s.thumbs }
    delete thumbs[target]
    set({ tabs, activeId, closed, groups, thumbs, split: partner ? null : s.split, preview: null })
  },

  reopenTab() {
    const s = get()
    const last = s.closed[s.closed.length - 1]
    if (!last) return
    const tab = { ...tabFor(last.url), title: last.title }
    const tabs = s.tabs.slice()
    tabs.splice(Math.min(last.index, tabs.length), 0, tab)
    set({ tabs: contiguous(tabs), activeId: tab.id, closed: s.closed.slice(0, -1) })
  },

  activate(id) {
    const s = get()
    const prev = s.activeId
    if (prev && prev !== id) {
      // Снимок оставленной вкладки — для превью при наведении (скрытый webview не рисуется).
      captureThumb(prev)
    }
    // Вкладка в свёрнутой группе — группу раскрываем, иначе активная была бы не видна.
    const tab = s.tabs.find((t) => t.id === id)
    const groups = tab?.group ? s.groups.map((g) => (g.id === tab.group && g.collapsed ? { ...g, collapsed: false } : g)) : s.groups
    const now = Date.now()
    set({
      activeId: id,
      popover: null,
      autofill: null,
      preview: null,
      capsuleSmall: false,
      groups,
      tabs: s.tabs.map((t) => (t.id === prev || t.id === id ? { ...t, lastActive: now } : t))
    })
    const f = get().find
    if (f.open) set({ find: { ...f, open: false, matches: 0, active: 0 } })
  },

  cycle(delta) {
    const s = get()
    const i = s.tabs.findIndex((t) => t.id === s.activeId)
    const n = s.tabs.length
    get().activate(s.tabs[(i + delta + n) % n].id)
  },

  activateIndex(index) {
    const s = get()
    const tab = index < 0 ? s.tabs[s.tabs.length - 1] : s.tabs[index]
    if (tab) get().activate(tab.id)
  },

  navigate(text, opts = {}) {
    const s = get()
    const ai = opts.ai ?? s.ai
    const url = opts.raw ? text : resolveInput(text, ai)
    set({ palette: { ...s.palette, open: false }, ai: s.settings.aiDefault })
    if (opts.target === 'new') {
      get().newTab(url)
      return
    }
    const tab = get().active()
    const internal = internalKind(url)
    if (internal) {
      get().updateTab(tab.id, { ...blankTab(internal, internalPages[internal].url), id: tab.id })
      return
    }
    if (url === NEWTAB_URL) {
      get().updateTab(tab.id, { ...blankTab(), id: tab.id })
      return
    }
    if (tab.kind === 'web') {
      const el = wv(tab.id)
      get().updateTab(tab.id, { url, error: undefined, loading: true })
      if (el) void el.loadURL(url).catch(() => undefined)
      else get().updateTab(tab.id, { initialUrl: url })
      return
    }
    get().updateTab(tab.id, { ...blankTab('web', url), id: tab.id })
  },

  openPalette(withUrl, target = 'current', typed, ai) {
    const tab = get().active()
    const url = withUrl && tab.kind === 'web' ? tab.url : ''
    const anchor: PaletteAnchor = tab.kind === 'newtab' ? 'ntp' : get().settings.sidebarCollapsed ? 'dock' : 'side'
    set({
      palette: { open: true, anchor, text: typed ?? url, select: !typed && !!url, target, mode: 'all' },
      popover: null,
      ai: ai ?? get().settings.aiDefault
    })
  },

  // AI Mode живёт только пока открыта палитра: закрыли — вернулись к режиму из настроек.
  closePalette() {
    set((s) => ({ palette: { ...s.palette, open: false }, ai: s.settings.aiDefault }))
  },

  toggleSidebar() {
    // Запоминаем, где была страница, — App доиграет переход сдвигом (FLIP), без пересчёта вёрстки.
    stageBefore = document.querySelector('.stage')?.getBoundingClientRect() ?? null
    get().setSettings({ sidebarCollapsed: !get().settings.sidebarCollapsed })
  },

  setAi(on) {
    set({ ai: on })
  },

  openSettings() {
    const s = get()
    const existing = s.tabs.find((t) => t.kind === 'settings')
    if (existing) get().activate(existing.id)
    else get().newTab(SETTINGS_URL)
  },

  openAddons() {
    const s = get()
    const existing = s.tabs.find((t) => t.kind === 'addons')
    if (existing) get().activate(existing.id)
    else get().newTab(ADDONS_URL)
  },

  openPasswords() {
    const s = get()
    const existing = s.tabs.find((t) => t.kind === 'passwords')
    if (existing) get().activate(existing.id)
    else get().newTab(PASSWORDS_URL)
  },

  openTabSearch() {
    const anchor: PaletteAnchor = get().active().kind === 'newtab' ? 'ntp' : get().settings.sidebarCollapsed ? 'dock' : 'side'
    set({ palette: { open: true, anchor, text: '', select: false, target: 'current', mode: 'tabs' }, popover: null, ai: false })
  },

  addToGroup(tabId, groupId) {
    const s = get()
    const tab = s.tabs.find((t) => t.id === tabId)
    if (!tab) return
    let groups = s.groups
    let gid = groupId
    if (groupId === 'new') {
      gid = 'g' + Date.now().toString(36)
      const used = new Set(s.groups.map((g) => g.color))
      const color = groupColors.find((c) => !used.has(c)) ?? groupColors[s.groups.length % groupColors.length]
      groups = [...s.groups, { id: gid, name: 'Группа ' + (s.groups.length + 1), color, collapsed: false }]
    }
    // Вкладки группы держим рядом: новая встаёт после последней вкладки группы.
    const rest = s.tabs.filter((t) => t.id !== tabId)
    const lastIdx = rest.map((t) => t.group).lastIndexOf(gid)
    const at = lastIdx >= 0 ? lastIdx + 1 : s.tabs.findIndex((t) => t.id === tabId)
    rest.splice(Math.min(at, rest.length), 0, { ...tab, group: gid })
    set({ tabs: rest, groups: groups.filter((g) => rest.some((t) => t.group === g.id)) })
  },

  removeFromGroup(tabId) {
    const s = get()
    const tabs = s.tabs.map((t) => (t.id === tabId ? { ...t, group: undefined } : t))
    set({ tabs, groups: s.groups.filter((g) => tabs.some((t) => t.group === g.id)) })
  },

  updateGroup(id, patch) {
    set((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) }))
  },

  ungroup(id) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.group === id ? { ...t, group: undefined } : t)), groups: s.groups.filter((g) => g.id !== id) }))
  },

  closeGroup(id) {
    for (const t of get().tabs.filter((x) => x.group === id)) get().closeTab(t.id)
  },

  openSplit(otherId) {
    const s = get()
    const a = s.active()
    const b = s.tabs.find((t) => t.id === otherId)
    if (!b || a.id === b.id || a.kind !== 'web' || b.kind !== 'web') return
    set({ split: { a: a.id, b: b.id, ratio: 0.5 } })
  },

  closeSplit() {
    set({ split: null })
  },

  archiveStale() {
    const s = get()
    const hours = s.settings.archiveAfter
    if (!hours) return
    const limit = Date.now() - hours * 3600_000
    // Не трогаем активную, играющую, сгруппированную и стоящую «рядом» вкладку.
    const stale = s.tabs.filter(
      (t) =>
        t.kind === 'web' &&
        t.id !== s.activeId &&
        !t.audible &&
        !t.group &&
        !(s.split && (s.split.a === t.id || s.split.b === t.id)) &&
        (t.lastActive ?? Date.now()) < limit
    )
    if (!stale.length) return
    const now = Date.now()
    const archive = [...stale.map((t) => ({ url: t.url, title: t.title, favicon: t.favicon, time: now })), ...s.archive].slice(0, 300)
    set({ tabs: s.tabs.filter((t) => !stale.includes(t)), archive })
  },

  showQr(url) {
    set({ qrUrl: url, popover: 'qr', menu: null })
  },

  setFind(patch) {
    set((s) => ({ find: { ...s.find, ...patch } }))
  },

  addHistory(url, title) {
    if (!/^https?:/i.test(url)) return
    const entry = { url, title, time: Date.now() }
    window.masaki.history.add(entry)
    set((s) => {
      const h = s.history
      const last = h[h.length - 1]
      if (last && last.url === url) return { history: [...h.slice(0, -1), { ...last, title: title || last.title }] }
      return { history: [...h, entry].slice(-5000) }
    })
  },

  upsertDownload(d) {
    set((s) => {
      const i = s.downloads.findIndex((x) => x.id === d.id)
      if (i < 0) return { downloads: [d, ...s.downloads].slice(0, 30), popover: 'downloads' }
      const downloads = s.downloads.slice()
      downloads[i] = d
      return { downloads }
    })
  },

  setPopover(p) {
    set({ popover: p, menu: null })
  },

  openMenu(x, y, entries) {
    set({ menu: { x, y, entries }, popover: null })
  },

  closeMenu() {
    set({ menu: null })
  },

  addPermission(p) {
    set((s) => ({ permissions: [...s.permissions, p] }))
  },

  dropPermission(id) {
    set((s) => ({ permissions: s.permissions.filter((x) => x.id !== id) }))
  },

  loadAccounts() {
    // Профиль берёт имя и аватар у своего аккаунта Google — после ответа список профилей свежий.
    void window.masaki.google.accounts().then((accounts) => {
      set({ accounts })
      get().loadProfiles()
    })
  },

  loadProfiles() {
    void window.masaki.profiles.list().then((profiles) => {
      set({ profiles })
      // Окна профилей различаются в панели задач и Alt+Tab по заголовку.
      const me = profiles.find((p) => p.current)
      document.title = profiles.length > 1 && me ? `${me.name} — Masaki` : 'Masaki'
    })
  },

  moveTab(id, to) {
    set((s) => {
      const from = s.tabs.findIndex((t) => t.id === id)
      if (from < 0) return {}
      const tabs = s.tabs.slice()
      const [tab] = tabs.splice(from, 1)
      const at = Math.max(0, Math.min(to > from ? to - 1 : to, tabs.length))
      tabs.splice(at, 0, tab)
      // Группа вкладки — по соседям: внутрь группы — в неё, за её пределы — из неё.
      const above = tabs[at - 1]
      const below = tabs[at + 1]
      const group =
        above?.group && above.group === below?.group
          ? above.group
          : tab.group && (above?.group === tab.group || below?.group === tab.group)
            ? tab.group
            : undefined
      tabs[at] = { ...tab, group }
      const next = contiguous(tabs)
      return { tabs: next, groups: s.groups.filter((g) => next.some((t) => t.group === g.id)) }
    })
  },

  duplicateTab(id) {
    const t = get().tabs.find((x) => x.id === id)
    if (t?.kind === 'web') get().newTab(t.url)
  },

  closeOthers(id) {
    const s = get()
    const keep = s.tabs.find((t) => t.id === id)
    if (!keep) return
    const closed = [
      ...s.closed,
      ...s.tabs.filter((t) => t.id !== id && t.kind === 'web').map((t, i) => ({ url: t.url, title: t.title, index: i }))
    ].slice(-25)
    set({ tabs: [keep], activeId: id, closed })
  },

  closeBelow(id) {
    const s = get()
    const i = s.tabs.findIndex((t) => t.id === id)
    if (i < 0) return
    const below = s.tabs.slice(i + 1)
    const closed = [...s.closed, ...below.filter((t) => t.kind === 'web').map((t) => ({ url: t.url, title: t.title, index: i + 1 }))].slice(-25)
    const tabs = s.tabs.slice(0, i + 1)
    set({ tabs, closed, activeId: tabs.some((t) => t.id === s.activeId) ? s.activeId : id })
  }
}))

// ---------- Сохранение сессии ----------

let saveTimer: number | undefined
useStore.subscribe((s, prev) => {
  if (!s.booted || (s.tabs === prev.tabs && s.activeId === prev.activeId && s.groups === prev.groups && s.archive === prev.archive)) return
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    const st = useStore.getState()
    window.masaki.session.save({
      tabs: st.tabs.map((t) => ({
        url: t.kind === 'newtab' ? NEWTAB_URL : t.kind === 'web' ? t.url : internalPages[t.kind].url,
        title: t.title,
        favicon: t.favicon,
        group: t.group
      })),
      active: Math.max(0, st.tabs.findIndex((t) => t.id === st.activeId)),
      groups: st.groups,
      archive: st.archive
    })
  }, 600)
})
