import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  Command,
  DownloadInfo,
  ExtInstallPrompt,
  HistoryEntry,
  MasakiApi,
  PageMenuParams,
  PasskeyPrompt,
  PasswordCsv,
  PasswordOffer,
  PermissionPrompt,
  Settings,
  SyncState,
  WindowState
} from '../shared/types'

/** Сессия вкладок: в ней живут расширения. Имя осталось от прежнего названия — не переименовывать. */
const TABS_PARTITION = 'persist:frost'

function listen<T>(channel: string, cb: (value: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, value: T): void => cb(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: MasakiApi = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-max'),
    close: () => ipcRenderer.send('win:close'),
    snap: (r) => ipcRenderer.send('win:snap', r),
    setFullScreen: (on) => ipcRenderer.send('win:fullscreen', on),
    onState: (cb) => {
      void ipcRenderer.invoke('win:state').then((s: WindowState) => cb(s))
      return listen<WindowState>('win-state', cb)
    }
  },
  onCommand: (cb) => listen<Command>('command', cb),
  navMouse: (dir) => ipcRenderer.send('nav:mouse', dir),
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (s) => ipcRenderer.send('settings:set', s),
    onChanged: (cb) => listen<Settings>('settings-changed', cb)
  },
  session: {
    load: () => ipcRenderer.invoke('session:load'),
    save: (s) => ipcRenderer.send('session:save', s)
  },
  history: {
    list: () => ipcRenderer.invoke('history:list'),
    add: (e) => ipcRenderer.send('history:add', e),
    clear: () => ipcRenderer.send('history:clear'),
    onChanged: (cb) => listen<HistoryEntry[]>('history-changed', cb)
  },
  downloads: {
    onUpdate: (cb) => listen<DownloadInfo>('download', cb),
    open: (p) => ipcRenderer.send('dl:open', p),
    showInFolder: (p) => ipcRenderer.send('dl:show', p),
    drag: (p) => ipcRenderer.send('dl:drag', p)
  },
  site: {
    clearData: (origin) => ipcRenderer.invoke('site:clear-data', origin),
    clearCache: () => ipcRenderer.invoke('site:clear-cache')
  },
  adblock: {
    set: (enabled) => ipcRenderer.invoke('adblock:set', enabled)
  },
  extensions: {
    list: () => ipcRenderer.invoke('ext:list'),
    add: () => ipcRenderer.invoke('ext:add'),
    remove: (id) => ipcRenderer.invoke('ext:remove', id),
    setEnabled: (id, on) => ipcRenderer.invoke('ext:enable', id, !!on),
    onChanged: (cb) => listen<void>('ext:changed', cb),
    onInstallPrompt: (cb) => listen<ExtInstallPrompt>('ext:install-prompt', cb),
    answerInstall: (id, allow) => ipcRenderer.send('ext:install-answer', id, !!allow),
    activeTab: (wcId) => ipcRenderer.send('ext:active-tab', wcId),
    // Кнопки расширений живут в electron-chrome-extensions: спрашиваем его же каналом, указывая сессию вкладок.
    actions: async () => {
      await ipcRenderer.invoke('crx-msg-remote', TABS_PARTITION, 'browserAction.addObserver')
      return ipcRenderer.invoke('crx-msg-remote', TABS_PARTITION, 'browserAction.getState')
    },
    onActionsChanged: (cb) => listen<void>('browserAction.update', cb),
    activate: (id, tabId, anchor, alignment) =>
      void ipcRenderer.invoke('crx-msg-remote', TABS_PARTITION, 'browserAction.activate', {
        eventType: 'click',
        extensionId: id,
        tabId,
        anchorRect: anchor,
        alignment
      }),
    menuClick: (index) => ipcRenderer.send('ext:menu-click', index)
  },
  captureTab: (wcId) => ipcRenderer.invoke('tab:capture', wcId),
  favicon: (url) => ipcRenderer.invoke('favicon', url),
  learnFavicon: (pageUrl, iconUrl) => ipcRenderer.send('favicon:learn', pageUrl, iconUrl),
  onFaviconUpdated: (cb) => listen<string>('favicon-updated', cb),
  google: {
    accounts: () => ipcRenderer.invoke('google:accounts')
  },
  sync: {
    state: () => ipcRenderer.invoke('sync:state'),
    onState: (cb) => listen<SyncState>('sync-state', cb),
    pickClient: () => ipcRenderer.invoke('sync:pick-client'),
    setClient: (id, secret) => ipcRenderer.invoke('sync:set-client', id, secret),
    removeClient: () => ipcRenderer.send('sync:remove-client'),
    signIn: (external) => ipcRenderer.invoke('sync:sign-in', !!external),
    cancelSignIn: () => ipcRenderer.send('sync:cancel'),
    signOut: () => ipcRenderer.invoke('sync:sign-out'),
    syncNow: () => ipcRenderer.invoke('sync:now'),
    setOptions: (o) => ipcRenderer.send('sync:options', o),
    setDeviceName: (name) => ipcRenderer.send('sync:device-name', name),
    forgetDevice: (id) => ipcRenderer.invoke('sync:forget-device', id),
    wipe: () => ipcRenderer.invoke('sync:wipe'),
    setVaultKey: (passphrase) => ipcRenderer.invoke('sync:vault-key', passphrase),
    resetVault: () => ipcRenderer.invoke('sync:vault-reset')
  },
  passwords: {
    list: () => ipcRenderer.invoke('passwords:list'),
    reveal: (id) => ipcRenderer.invoke('passwords:reveal', id),
    copy: (id) => ipcRenderer.invoke('passwords:copy', id),
    save: (p) => ipcRenderer.invoke('passwords:save', p),
    remove: (id) => ipcRenderer.invoke('passwords:remove', id),
    importFile: () => ipcRenderer.invoke('passwords:import-file'),
    importDownloaded: (id) => ipcRenderer.invoke('passwords:import-downloaded', id),
    dismissCsv: (id) => ipcRenderer.send('passwords:dismiss-csv', id),
    onCsv: (cb) => listen<PasswordCsv>('passwords-csv', cb),
    onOffer: (cb) => listen<PasswordOffer>('passwords-offer', cb),
    answer: (id, action) => ipcRenderer.send('passwords:answer', id, action),
    fill: (wcId, id) => ipcRenderer.send('passwords:fill', wcId, id),
    never: () => ipcRenderer.invoke('passwords:never'),
    forgetNever: (origin) => ipcRenderer.send('passwords:forget-never', origin),
    onChanged: (cb) => listen<void>('passwords-changed', () => cb())
  },
  passkeys: {
    list: () => ipcRenderer.invoke('passkeys:list'),
    remove: (id) => ipcRenderer.invoke('passkeys:remove', id),
    onChanged: (cb) => listen<void>('passkeys-changed', () => cb()),
    onPrompt: (cb) => listen<PasskeyPrompt>('passkey-prompt', cb),
    onPromptClose: (cb) => listen<string>('passkey-prompt-close', cb),
    answer: (id, action, account) => ipcRenderer.send('passkeys:answer', id, action, account),
    useConditional: (wcId, id) => ipcRenderer.send('passkeys:use', wcId, id)
  },
  chrome: {
    profiles: () => ipcRenderer.invoke('chrome:profiles'),
    import: (dir, what) => ipcRenderer.invoke('chrome:import', dir, what)
  },
  onPageMenu: (cb) => listen<PageMenuParams>('page-menu', cb),
  permissions: {
    onPrompt: (cb) => listen<PermissionPrompt>('permission', cb),
    onDismiss: (cb) => listen<string>('permission-dismiss', cb),
    answer: (id, allow, remember) => ipcRenderer.send('permission:answer', id, allow, remember),
    list: () => ipcRenderer.invoke('permission:list'),
    forget: (origin, permission) => ipcRenderer.send('permission:forget', origin, permission)
  },
  pageAction: (wcId, a) => ipcRenderer.send('page:action', wcId, a),
  uiEdit: (cmd) => ipcRenderer.send('ui:edit', cmd),
  copyText: (text) => ipcRenderer.send('clipboard:write', text),
  cursor: () => ipcRenderer.invoke('cursor'),
  suggest: (q) => ipcRenderer.invoke('suggest', q),
  wallpaper: () => ipcRenderer.invoke('wallpaper'),
  pickWallpaper: () => ipcRenderer.invoke('wallpaper:pick'),
  customWallpaper: () => ipcRenderer.invoke('wallpaper:custom'),
  mediaArt: (url) => ipcRenderer.invoke('media:art', url)
}

contextBridge.exposeInMainWorld('masaki', api)
