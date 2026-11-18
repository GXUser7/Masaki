// Полный preload расширений Chrome (и в страницах расширений, и в Service Worker).
// Не импортирует локальные файлы (sandbox/SW не умеет общие chunks): только 'electron'.
//
// Исправляет критические несовместимости Electron 44 + electron-chrome-extensions:
// 1. Зеркалирует пропатченные API chrome.* на нативный globalThis.browser (в Electron 44 появился
//    урезанный нативный globalThis.browser без tabs.create/permissions/windows/contextMenus — из-за
//    него падали uBlock Origin Lite, AdGuard, Bitwarden, Stylus и др.).
// 2. Не замораживает globalThis.chrome (Object.freeze ломал SponsorBlock и полифиллы).
// 3. Поддерживает ImageData в MV3 action.setIcon через OffscreenCanvas / canvas.
// 4. Не подменяет chrome.storage.managed данными из storage.local (это ломало настройки расширений).
// 5. Подключает declarativeNetRequest, webRequest, runtime.onInstalled/onStartup, commands,
//    fontSettings, userScripts, identity, sidePanel, tabs (captureVisibleTab/insertCSS/removeCSS),
//    history, bookmarks, topSites, downloads, browsingData, sessions, search, permissions.

import { contextBridge, ipcRenderer } from 'electron'

if (process.type === 'service-worker' || location.href.startsWith('chrome-extension://')) {
  const sendIpc = (channel: string, ...args: unknown[]): void => {
    try {
      ipcRenderer.send(channel, ...args)
    } catch {
      // worker/frame мог уже закрыться
    }
  }
  const invokeIpc = (channel: string, ...args: unknown[]): Promise<unknown> => ipcRenderer.invoke(channel, ...args)

  const listenerCount = new Map<string, number>()
  const eventSubscribers = new Map<string, Set<(...args: unknown[]) => void>>()
  const hookedChannels = new Set<string>()

  const ensureChannelHook = (channel: string): void => {
    if (hookedChannels.has(channel)) return
    hookedChannels.add(channel)
    ipcRenderer.on(channel, (_e, ...args: unknown[]) => {
      const subs = eventSubscribers.get(channel)
      if (!subs) return
      for (const fn of [...subs]) {
        try {
          fn(...args)
        } catch {
          // ошибка в пользовательском слушателе расширения не должна ломать остальные
        }
      }
    })
  }

  const addExtListener = (extensionId: string, name: string, cb: (...args: unknown[]) => void): void => {
    const ch = `crx-${name}`
    ensureChannelHook(ch)
    let subs = eventSubscribers.get(ch)
    if (!subs) {
      subs = new Set()
      eventSubscribers.set(ch, subs)
    }
    if (!subs.has(cb)) {
      subs.add(cb)
      const cnt = listenerCount.get(name) ?? 0
      if (cnt === 0) sendIpc('crx-add-listener', extensionId, name)
      listenerCount.set(name, cnt + 1)
    }
  }

  const removeExtListener = (extensionId: string, name: string, cb: (...args: unknown[]) => void): void => {
    const ch = `crx-${name}`
    const subs = eventSubscribers.get(ch)
    if (subs?.delete(cb)) {
      const cnt = listenerCount.get(name) ?? 0
      if (cnt <= 1) {
        listenerCount.delete(name)
        sendIpc('crx-remove-listener', extensionId, name)
      } else {
        listenerCount.set(name, cnt - 1)
      }
    }
  }

  const masakiListeners = new Map<string, Set<(...args: unknown[]) => void>>()
  let masakiHooked = false
  const addMasakiListener = (eventName: string, cb: (...args: unknown[]) => void): void => {
    if (!masakiHooked) {
      masakiHooked = true
      ipcRenderer.on('ext:event', (_e, name: string, args: unknown[]) => {
        const set = masakiListeners.get(name)
        if (!set) return
        for (const fn of [...set]) {
          try {
            fn(...(Array.isArray(args) ? args : []))
          } catch {
            // изолируем сбой отдельного слушателя
          }
        }
      })
    }
    let set = masakiListeners.get(eventName)
    if (!set) {
      set = new Set()
      masakiListeners.set(eventName, set)
    }
    set.add(cb)
  }
  const removeMasakiListener = (eventName: string, cb: (...args: unknown[]) => void): void => {
    masakiListeners.get(eventName)?.delete(cb)
  }

  const webRequestListeners = new Map<string, { event: string; fn: (...args: unknown[]) => unknown }>()
  let wrHooked = false
  const ensureWrHook = (extensionId: string): void => {
    if (wrHooked) return
    wrHooked = true
    ipcRenderer.on(
      'ext:wr-event',
      (_e, listenerId: string, _event: string, details: unknown, reqId?: string) => {
        const entry = webRequestListeners.get(listenerId)
        if (!entry) {
          if (reqId) sendIpc('ext:wr-answer', reqId, null)
          return
        }
        try {
          const result = entry.fn(details)
          if (reqId) {
            if (result && typeof (result as Promise<unknown>).then === 'function') {
              void (result as Promise<unknown>).then(
                (r) => sendIpc('ext:wr-answer', reqId, r ?? null),
                () => sendIpc('ext:wr-answer', reqId, null)
              )
            } else {
              sendIpc('ext:wr-answer', reqId, result ?? null)
            }
          }
        } catch {
          if (reqId) sendIpc('ext:wr-answer', reqId, null)
        }
      }
    )
    void extensionId
  }

  const bridge = {
    invokeCrx: (extensionId: string, fnName: string, args: unknown[]): Promise<unknown> =>
      invokeIpc('crx-msg', extensionId, fnName, ...args),
    invokeApi: (extensionId: string, method: string, args: unknown[]): Promise<unknown> =>
      invokeIpc('ext:api', extensionId, method, ...args),
    addListener: addExtListener,
    removeListener: removeExtListener,
    addMasakiListener,
    removeMasakiListener,
    lifecycleReady: (extensionId: string): Promise<unknown> => invokeIpc('ext:lifecycle-ready', extensionId),
    syncDnr: (extensionId: string, payload: unknown): Promise<unknown> => invokeIpc('ext:dnr-sync', extensionId, payload),
    getMatchedRules: (extensionId: string, filter: unknown): Promise<unknown> =>
      invokeIpc('ext:dnr-matched', extensionId, filter),
    addWebRequestListener: (
      extensionId: string,
      listenerId: string,
      event: string,
      filter: unknown,
      extraInfoSpec: unknown,
      fn: (...args: unknown[]) => unknown
    ): void => {
      ensureWrHook(extensionId)
      webRequestListeners.set(listenerId, { event, fn })
      sendIpc('ext:wr-add', extensionId, { listenerId, event, filter, extraInfoSpec })
    },
    removeWebRequestListener: (extensionId: string, listenerId: string): void => {
      webRequestListeners.delete(listenerId)
      sendIpc('ext:wr-remove', extensionId, listenerId)
    },
    connectNative: (
      extensionId: string,
      application: string,
      receive: (msg: unknown) => void,
      disconnect: () => void,
      callback: (connectionId: string, send: (msg: unknown) => void) => void
    ): void => {
      const connectionId = globalThis.crypto.randomUUID()
      void invokeIpc('crx-msg', extensionId, 'runtime.connectNative', connectionId, application)
      const onMsg = (_e: unknown, msg: unknown): void => receive(msg)
      ipcRenderer.on(`crx-native-msg-${connectionId}`, onMsg)
      ipcRenderer.once(`crx-native-msg-${connectionId}-disconnect`, () => {
        ipcRenderer.off(`crx-native-msg-${connectionId}`, onMsg)
        disconnect()
      })
      callback(connectionId, (msg: unknown) => sendIpc(`crx-native-msg-${connectionId}`, msg))
    },
    disconnectNative: (extensionId: string, connectionId: string): void => {
      void invokeIpc('crx-msg', extensionId, 'runtime.disconnectNative', connectionId)
    },
    randomUuid: (): string => globalThis.crypto.randomUUID()
  }

  function mainWorldScript(): void {
    const g = globalThis as Record<string, unknown> & {
      chrome?: Record<string, unknown>
      browser?: Record<string, unknown>
    }
    const bridgeApi = g.__masakiExtBridge as typeof bridge | undefined
    if (!bridgeApi) return
    delete g.__masakiExtBridge

    const chrome = (g.chrome || {}) as Record<string, Record<string, unknown> | unknown>
    g.chrome = chrome
    const runtimeBase = (chrome.runtime || {}) as Record<string, unknown>
    const extensionId = typeof runtimeBase.id === 'string' ? runtimeBase.id : ''
    let manifest: Record<string, unknown> = {}
    try {
      manifest = (typeof runtimeBase.getManifest === 'function' ? (runtimeBase.getManifest as () => Record<string, unknown>)() : {}) || {}
    } catch {
      manifest = {}
    }

    let currentLastError: { message: string } | undefined
    const setLastError = (msg?: string): void => {
      currentLastError = msg ? { message: msg } : undefined
      try {
        runtimeBase.lastError = currentLastError
      } catch {
        // runtimeBase.lastError может быть геттером в старом окружении
      }
    }

    const invokeCrx =
      (fnName: string, opts: { noop?: boolean; defaultResponse?: unknown; serialize?: (...a: unknown[]) => unknown[] | Promise<unknown[]> } = {}) =>
      (...rawArgs: unknown[]): Promise<unknown> | void => {
        const args = [...rawArgs]
        const callback = typeof args[args.length - 1] === 'function' ? (args.pop() as (res?: unknown) => void) : undefined
        if (opts.noop) {
          if (callback) {
            queueMicrotask(() => callback(opts.defaultResponse))
            return
          }
          return Promise.resolve(opts.defaultResponse)
        }
        const run = async (): Promise<unknown> => {
          const finalArgs = opts.serialize ? await opts.serialize(...args) : args
          return bridgeApi.invokeCrx(extensionId, fnName, finalArgs)
        }
        const p = run()
        if (callback) {
          p.then(
            (res) => {
              setLastError(undefined)
              callback(res)
            },
            (err) => {
              setLastError(err instanceof Error ? err.message : String(err))
              callback(undefined)
              setLastError(undefined)
            }
          )
          return
        }
        return p
      }

    const invokeApi =
      (method: string, opts: { defaultResponse?: unknown } = {}) =>
      (...rawArgs: unknown[]): Promise<unknown> | void => {
        const args = [...rawArgs]
        const callback = typeof args[args.length - 1] === 'function' ? (args.pop() as (res?: unknown) => void) : undefined
        const p = bridgeApi.invokeApi(extensionId, method, args)
        if (callback) {
          p.then(
            (res) => {
              setLastError(undefined)
              callback(res === undefined ? opts.defaultResponse : res)
            },
            (err) => {
              setLastError(err instanceof Error ? err.message : String(err))
              callback(opts.defaultResponse)
              setLastError(undefined)
            }
          )
          return
        }
        return p
      }

    // Работает и на страницах (document.createElement('canvas')), и в MV3 Service Worker (OffscreenCanvas)
    async function imageDataToBase64(imageData: ImageData): Promise<string | null> {
      if (!imageData || !imageData.width || !imageData.height) return null
      try {
        if (typeof document !== 'undefined') {
          const canvas = document.createElement('canvas')
          canvas.width = imageData.width
          canvas.height = imageData.height
          const ctx = canvas.getContext('2d')
          if (!ctx) return null
          ctx.putImageData(imageData, 0, 0)
          return canvas.toDataURL('image/png')
        }
        if (typeof OffscreenCanvas !== 'undefined') {
          const canvas = new OffscreenCanvas(imageData.width, imageData.height)
          const ctx = canvas.getContext('2d')
          if (!ctx) return null
          ctx.putImageData(imageData, 0, 0)
          const blob = await canvas.convertToBlob({ type: 'image/png' })
          const bytes = new Uint8Array(await blob.arrayBuffer())
          let bin = ''
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
          return 'data:image/png;base64,' + btoa(bin)
        }
      } catch {
        return null
      }
      return null
    }

    class ExtensionEvent {
      listeners = new Set<(...args: unknown[]) => void>()
      constructor(private name: string, private source: 'crx' | 'masaki' = 'crx') {}
      addListener(cb: (...args: unknown[]) => void): void {
        if (typeof cb !== 'function') return
        this.listeners.add(cb)
        if (this.source === 'crx') bridgeApi!.addListener(extensionId, this.name, cb)
        else bridgeApi!.addMasakiListener(this.name, cb)
      }
      removeListener(cb: (...args: unknown[]) => void): void {
        this.listeners.delete(cb)
        if (this.source === 'crx') bridgeApi!.removeListener(extensionId, this.name, cb)
        else bridgeApi!.removeMasakiListener(this.name, cb)
      }
      hasListener(cb: (...args: unknown[]) => void): boolean {
        return this.listeners.has(cb)
      }
      hasListeners(): boolean {
        return this.listeners.size > 0
      }
      addRules(_rules: unknown, cb?: () => void): void {
        cb?.()
      }
      removeRules(_ids: unknown, cb?: () => void): void {
        cb?.()
      }
      getRules(_ids: unknown, cb?: (r: unknown[]) => void): void {
        cb?.([])
      }
    }

    class LocalEvent {
      listeners: ((...args: unknown[]) => void)[] = []
      _emit(...args: unknown[]): void {
        for (const fn of [...this.listeners]) fn(...args)
      }
      addListener(cb: (...args: unknown[]) => void): void {
        if (typeof cb === 'function' && !this.listeners.includes(cb)) this.listeners.push(cb)
      }
      removeListener(cb: (...args: unknown[]) => void): void {
        const i = this.listeners.indexOf(cb)
        if (i >= 0) this.listeners.splice(i, 1)
      }
      hasListener(cb: (...args: unknown[]) => void): boolean {
        return this.listeners.includes(cb)
      }
      hasListeners(): boolean {
        return this.listeners.length > 0
      }
    }

    // Чистая read-only реализация для managed-политик и настроек privacy/fontSettings
    function createChromeSetting(settingKey: string): Record<string, unknown> {
      const store = new Map<string, unknown>()
      return {
        get: (details: { incognito?: boolean } | ((r: unknown) => void), cb?: (r: unknown) => void) => {
          const callback = typeof details === 'function' ? details : cb
          const res = { value: store.has(settingKey) ? store.get(settingKey) : undefined, levelOfControl: 'controllable_by_this_extension' }
          if (callback) {
            queueMicrotask(() => callback(res))
            return
          }
          return Promise.resolve(res)
        },
        set: (details: { value?: unknown }, cb?: () => void) => {
          store.set(settingKey, details?.value)
          if (cb) {
            queueMicrotask(() => cb())
            return
          }
          return Promise.resolve()
        },
        clear: (_details: unknown, cb?: () => void) => {
          store.delete(settingKey)
          if (cb) {
            queueMicrotask(() => cb())
            return
          }
          return Promise.resolve()
        },
        onChange: new LocalEvent()
      }
    }

    class NativePort {
      connectionId = ''
      connected = false
      pending: unknown[] = []
      name = ''
      onMessage = new LocalEvent()
      onDisconnect = new LocalEvent()
      _init(connectionId: string, send: (msg: unknown) => void): void {
        this.connected = true
        this.connectionId = connectionId
        this._send = send
        for (const m of this.pending) this.postMessage(m)
        this.pending = []
      }
      _send(msg: unknown): void {
        this.pending.push(msg)
      }
      _receive(msg: unknown): void {
        this.onMessage._emit(msg)
      }
      _disconnect(): void {
        this.disconnect()
      }
      postMessage(msg: unknown): void {
        this._send(msg)
      }
      disconnect(): void {
        if (this.connected) {
          bridgeApi!.disconnectNative(extensionId, this.connectionId)
          this.onDisconnect._emit()
          this.connected = false
        }
      }
    }

    const browserActionFactory = (base: Record<string, unknown> = {}): Record<string, unknown> => ({
      ...base,
      setTitle: invokeCrx('browserAction.setTitle'),
      getTitle: invokeCrx('browserAction.getTitle'),
      setIcon: invokeCrx('browserAction.setIcon', {
        serialize: async (...rawArgs: unknown[]) => {
          const copy = { ...((rawArgs[0] as Record<string, unknown>) ?? {}) }
          if (copy.imageData) {
            const img = copy.imageData as ImageData | Record<string, ImageData>
            if (typeof (img as ImageData).width === 'number' && (img as ImageData).data) {
              copy.imageData = await imageDataToBase64(img as ImageData)
            } else if (typeof img === 'object') {
              const converted: Record<string, string> = {}
              for (const [k, v] of Object.entries(img)) {
                const b64 = await imageDataToBase64(v as ImageData)
                if (b64) converted[k] = b64
              }
              copy.imageData = Object.keys(converted).length ? converted : undefined
            }
          }
          return [copy]
        }
      }),
      setPopup: invokeCrx('browserAction.setPopup'),
      getPopup: invokeCrx('browserAction.getPopup'),
      setBadgeText: invokeCrx('browserAction.setBadgeText'),
      getBadgeText: invokeCrx('browserAction.getBadgeText'),
      setBadgeBackgroundColor: invokeCrx('browserAction.setBadgeBackgroundColor'),
      getBadgeBackgroundColor: invokeCrx('browserAction.getBadgeBackgroundColor'),
      setBadgeTextColor: invokeApi('action.setBadgeTextColor'),
      getBadgeTextColor: invokeApi('action.getBadgeTextColor'),
      getUserSettings: invokeCrx('browserAction.getUserSettings'),
      enable: invokeApi('action.enable'),
      disable: invokeApi('action.disable'),
      isEnabled: invokeApi('action.isEnabled', { defaultResponse: true }),
      openPopup: invokeCrx('browserAction.openPopup'),
      onClicked: new ExtensionEvent('browserAction.onClicked')
    })

    // События жизненного цикла: onInstalled и onStartup собираем и запрашиваем у main после
    // завершения первого такта регистрации слушателей (queueMicrotask).
    const installedListeners = new Set<(d: unknown) => void>()
    const startupListeners = new Set<() => void>()
    let lifecycleAsked = false
    const scheduleLifecyclePull = (): void => {
      if (lifecycleAsked || !extensionId) return
      lifecycleAsked = true
      queueMicrotask(() => {
        void bridgeApi.lifecycleReady(extensionId).then((res) => {
          const info = res as { installed?: unknown; startup?: boolean } | null
          if (!info) return
          if (info.installed) for (const fn of installedListeners) fn(info.installed)
          if (info.startup) for (const fn of startupListeners) fn()
        })
      })
    }

    // Пустое read-only хранилище managed (ни в коем случае не storage.local!)
    const managedStorage = {
      QUOTA_BYTES: 102400,
      onChanged: new LocalEvent(),
      get(keys: unknown, cb?: (items: Record<string, unknown>) => void): Promise<Record<string, unknown>> | void {
        const res: Record<string, unknown> = {}
        if (keys && typeof keys === 'object' && !Array.isArray(keys)) {
          Object.assign(res, keys)
        }
        if (typeof cb === 'function') {
          queueMicrotask(() => cb(res))
          return
        }
        return Promise.resolve(res)
      },
      getBytesInUse(_keys: unknown, cb?: (n: number) => void): Promise<number> | void {
        if (typeof cb === 'function') {
          queueMicrotask(() => cb(0))
          return
        }
        return Promise.resolve(0)
      },
      set(_items: unknown, cb?: () => void): Promise<void> | void {
        if (typeof cb === 'function') {
          queueMicrotask(() => cb())
          return
        }
        return Promise.resolve()
      },
      remove(_keys: unknown, cb?: () => void): Promise<void> | void {
        if (typeof cb === 'function') {
          queueMicrotask(() => cb())
          return
        }
        return Promise.resolve()
      },
      clear(cb?: () => void): Promise<void> | void {
        if (typeof cb === 'function') {
          queueMicrotask(() => cb())
          return
        }
        return Promise.resolve()
      }
    }

    // Расширяем contextMenus поддержкой update, checkbox/radio и menus (Firefox-алиас)
    let menuCounter = 0
    const menuCallbacks: Record<string, (info: unknown, tab: unknown) => void> = {}
    const menuCreate = invokeCrx('contextMenus.create')
    let hasInternalMenuListener = false
    const onMenuClicked = new ExtensionEvent('contextMenus.onClicked')
    const ensureInternalMenuListener = (): void => {
      if (hasInternalMenuListener) return
      hasInternalMenuListener = true
      onMenuClicked.addListener((info: unknown, tab: unknown) => {
        const id = (info as { menuItemId?: string })?.menuItemId
        const cb = id ? menuCallbacks[id] : undefined
        if (cb && tab) cb(info, tab)
      })
    }
    const contextMenusApi = {
      ACTION_MENU_TOP_LEVEL_LIMIT: 6,
      create(props: Record<string, unknown>, cb?: () => void): string {
        const p = { ...props }
        if (p.id === undefined) p.id = String(++menuCounter)
        if (typeof p.onclick === 'function') {
          ensureInternalMenuListener()
          menuCallbacks[String(p.id)] = p.onclick as (info: unknown, tab: unknown) => void
          delete p.onclick
        }
        void menuCreate(p, cb)
        return String(p.id)
      },
      update(id: string | number, props: Record<string, unknown>, cb?: () => void): Promise<unknown> | void {
        const p = { ...props }
        if (typeof p.onclick === 'function') {
          ensureInternalMenuListener()
          menuCallbacks[String(id)] = p.onclick as (info: unknown, tab: unknown) => void
          delete p.onclick
        }
        return invokeApi('contextMenus.update')(String(id), p, cb)
      },
      remove(id: string | number, cb?: () => void): Promise<unknown> | void {
        delete menuCallbacks[String(id)]
        return invokeCrx('contextMenus.remove')(String(id), cb)
      },
      removeAll(cb?: () => void): Promise<unknown> | void {
        for (const k of Object.keys(menuCallbacks)) delete menuCallbacks[k]
        return invokeCrx('contextMenus.removeAll')(cb)
      },
      refresh(cb?: () => void): Promise<void> | void {
        if (cb) {
          queueMicrotask(() => cb())
          return
        }
        return Promise.resolve()
      },
      onClicked: onMenuClicked
    }

    // Декларативный DNR: проксируем нативные методы Chromium + синхронизируем с главным процессом
    const dnrBase = (chrome.declarativeNetRequest || {}) as Record<string, unknown>
    let dnrBootSynced = false
    const pushFullDnrSnapshot = async (): Promise<void> => {
      if (!extensionId || typeof dnrBase.getDynamicRules !== 'function') return
      try {
        // Не отправляем enabledRulesets при старте: нативный getEnabledRulesets() в Electron может
        // возвращать [], затирая статические rule_resources из manifest.json в extNet.
        const [dynamicRules, sessionRules] = await Promise.all([
          (dnrBase.getDynamicRules as () => Promise<unknown[]>)().catch(() => undefined),
          (dnrBase.getSessionRules as () => Promise<unknown[]>)().catch(() => undefined)
        ])
        await bridgeApi.syncDnr(extensionId, {
          boot: true,
          ...(dynamicRules !== undefined ? { dynamicRules } : {}),
          ...(sessionRules !== undefined ? { sessionRules } : {})
        })
      } catch {
        // расширение без DNR-разрешений
      }
    }
    if (
      extensionId &&
      typeof dnrBase.getDynamicRules === 'function' &&
      !dnrBootSynced &&
      (typeof document === 'undefined' || !(manifest.background as { service_worker?: string } | undefined)?.service_worker)
    ) {
      dnrBootSynced = true
      queueMicrotask(() => void pushFullDnrSnapshot())
    }

    const wrapDnrUpdater = (
      method: string,
      fetchKind: 'dynamic' | 'session' | 'rulesets' | 'static',
      actionOpts?: boolean
    ): ((arg: unknown, cb?: () => void) => Promise<void> | void) | undefined => {
      const orig = dnrBase[method] as ((arg: unknown) => Promise<unknown>) | undefined
      if (typeof orig !== 'function' && (fetchKind === 'dynamic' || fetchKind === 'session') && !actionOpts) return undefined
      return (arg: unknown, cb?: () => void): Promise<void> | void => {
        const runNative =
          typeof orig === 'function'
            ? Promise.resolve()
                .then(() => orig.call(dnrBase, arg))
                .catch(() => undefined)
            : Promise.resolve(undefined)
        const p = runNative.then(async (res) => {
          if (actionOpts) {
            await bridgeApi.syncDnr(extensionId, { actionOptions: arg })
          } else if (fetchKind === 'dynamic') {
            const dynamicRules = await (dnrBase.getDynamicRules as () => Promise<unknown[]>)().catch(() => undefined)
            if (dynamicRules !== undefined) await bridgeApi.syncDnr(extensionId, { dynamicRules })
          } else if (fetchKind === 'session') {
            const sessionRules = await (dnrBase.getSessionRules as () => Promise<unknown[]>)().catch(() => undefined)
            if (sessionRules !== undefined) await bridgeApi.syncDnr(extensionId, { sessionRules })
          } else if (fetchKind === 'rulesets') {
            await bridgeApi.syncDnr(extensionId, { rulesetDelta: arg })
          } else if (fetchKind === 'static') {
            await bridgeApi.syncDnr(extensionId, { staticRuleDelta: arg })
          }
          return res
        })
        if (cb) {
          p.then(
            () => cb(),
            () => cb()
          )
          return
        }
        return p as Promise<void>
      }
    }

    // webRequest события через main (не ломая chrome.webRequest.ResourceType и прочие константы)
    let wrSeq = 0
    const makeWebRequestEvent = (eventName: string): Record<string, unknown> => {
      const fnToId = new WeakMap<(...args: unknown[]) => unknown, string>()
      return {
        addListener(
          cb: (...args: unknown[]) => unknown,
          filter?: unknown,
          extraInfoSpec?: string[]
        ): void {
          if (typeof cb !== 'function') return
          let id = fnToId.get(cb)
          if (!id) {
            id = `${extensionId}:${eventName}:${++wrSeq}`
            fnToId.set(cb, id)
          }
          bridgeApi.addWebRequestListener(extensionId, id, eventName, filter, extraInfoSpec, cb)
        },
        removeListener(cb: (...args: unknown[]) => unknown): void {
          const id = fnToId.get(cb)
          if (id) {
            fnToId.delete(cb)
            bridgeApi.removeWebRequestListener(extensionId, id)
          }
        },
        hasListener(cb: (...args: unknown[]) => unknown): boolean {
          return fnToId.has(cb)
        },
        hasListeners(): boolean {
          return false
        }
      }
    }

    // Сопоставление URL-паттерна для permissions.contains (включая <all_urls> и *://*.host/*)
    const patternMatches = (granted: string, requested: string): boolean => {
      if (granted === requested || granted === '<all_urls>') return true
      try {
        const esc = (s: string): string => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
        return new RegExp('^' + esc(granted) + '$', 'i').test(requested)
      } catch {
        return false
      }
    }

    const tabsBase = (chrome.tabs || {}) as Record<string, unknown>
    const tabsApi: Record<string, unknown> = {
      ...tabsBase,
      TAB_ID_NONE: -1,
      create: invokeCrx('tabs.create'),
      get: invokeCrx('tabs.get'),
      getCurrent: invokeCrx('tabs.getCurrent'),
      getAllInWindow: invokeCrx('tabs.getAllInWindow'),
      query: invokeCrx('tabs.query'),
      reload: invokeCrx('tabs.reload'),
      update: invokeApi('tabs.update'),
      remove: invokeCrx('tabs.remove'),
      goBack: invokeCrx('tabs.goBack'),
      goForward: invokeCrx('tabs.goForward'),
      duplicate: invokeApi('tabs.duplicate'),
      captureVisibleTab: invokeApi('tabs.captureVisibleTab'),
      detectLanguage: invokeApi('tabs.detectLanguage', { defaultResponse: 'und' }),
      discard: invokeApi('tabs.discard'),
      move: invokeApi('tabs.move'),
      highlight: invokeApi('tabs.highlight'),
      group: invokeApi('tabs.group'),
      ungroup: invokeApi('tabs.ungroup'),
      insertCSS(arg1: unknown, arg2: unknown, arg3?: unknown): Promise<unknown> | void {
        if (typeof arg1 === 'object' && arg1 !== null) {
          const cb = typeof arg2 === 'function' ? (arg2 as () => void) : undefined
          const p = (tabsApi.query as (q: unknown) => Promise<{ id: number }[]>)({ active: true, currentWindow: true }).then(
            (tabs) => (tabs[0] ? invokeApi('tabs.insertCSS')(tabs[0].id, arg1) : undefined)
          )
          if (cb) {
            p.then(() => cb(), () => cb())
            return
          }
          return p
        }
        return invokeApi('tabs.insertCSS')(arg1, arg2, arg3)
      },
      removeCSS(arg1: unknown, arg2: unknown, arg3?: unknown): Promise<unknown> | void {
        if (typeof arg1 === 'object' && arg1 !== null) {
          const cb = typeof arg2 === 'function' ? (arg2 as () => void) : undefined
          const p = (tabsApi.query as (q: unknown) => Promise<{ id: number }[]>)({ active: true, currentWindow: true }).then(
            (tabs) => (tabs[0] ? invokeApi('tabs.removeCSS')(tabs[0].id, arg1) : undefined)
          )
          if (cb) {
            p.then(() => cb(), () => cb())
            return
          }
          return p
        }
        return invokeApi('tabs.removeCSS')(arg1, arg2, arg3)
      },
      executeScript(arg1: unknown, arg2: unknown, arg3?: unknown): Promise<unknown> | void {
        const orig = tabsBase.executeScript as ((...a: unknown[]) => Promise<unknown>) | undefined
        if (typeof arg1 === 'object' && arg1 !== null) {
          const cb = typeof arg2 === 'function' ? (arg2 as (r?: unknown) => void) : undefined
          const p = (tabsApi.query as (q: unknown) => Promise<{ id: number }[]>)({ active: true, currentWindow: true }).then(
            (tabs) => (tabs[0] && orig ? orig.call(tabsBase, tabs[0].id, arg1) : [])
          )
          if (cb) {
            p.then((r) => cb(r), () => cb([]))
            return
          }
          return p
        }
        return orig ? orig.call(tabsBase, arg1, arg2, arg3) : Promise.resolve([])
      },
      onCreated: new ExtensionEvent('tabs.onCreated'),
      onRemoved: new ExtensionEvent('tabs.onRemoved'),
      onUpdated: new ExtensionEvent('tabs.onUpdated'),
      onActivated: new ExtensionEvent('tabs.onActivated'),
      onReplaced: new ExtensionEvent('tabs.onReplaced')
    }

    const permContainsBase = invokeCrx('permissions.contains')
    const permGetAllBase = invokeCrx('permissions.getAll')

    const apiDefinitions: Record<string, { shouldInject?: () => boolean; factory: (base: Record<string, unknown>) => Record<string, unknown> }> = {
      action: {
        shouldInject: () => manifest.manifest_version === 3 && (!!manifest.action || !!manifest.permissions),
        factory: browserActionFactory
      },
      browserAction: {
        shouldInject: () => manifest.manifest_version === 2 && !!manifest.browser_action,
        factory: browserActionFactory
      },
      commands: {
        factory: (base) => ({
          ...base,
          getAll: invokeCrx('commands.getAll'),
          onCommand: new ExtensionEvent('commands.onCommand')
        })
      },
      contextMenus: { factory: () => contextMenusApi },
      cookies: {
        factory: (base) => ({
          ...base,
          get: invokeCrx('cookies.get'),
          getAll: invokeCrx('cookies.getAll'),
          set: invokeCrx('cookies.set'),
          remove: invokeCrx('cookies.remove'),
          getAllCookieStores: invokeCrx('cookies.getAllCookieStores'),
          onChanged: new ExtensionEvent('cookies.onChanged')
        })
      },
      declarativeNetRequest: {
        shouldInject: () =>
          !!dnrBase &&
          (Object.keys(dnrBase).length > 0 ||
            typeof dnrBase.getDynamicRules === 'function' ||
            !!manifest.declarative_net_request),
        factory: (base) => ({
          ...base,
          updateDynamicRules: wrapDnrUpdater('updateDynamicRules', 'dynamic') ?? base.updateDynamicRules,
          updateSessionRules: wrapDnrUpdater('updateSessionRules', 'session') ?? base.updateSessionRules,
          updateEnabledRulesets: wrapDnrUpdater('updateEnabledRulesets', 'rulesets') ?? base.updateEnabledRulesets,
          updateStaticRules: wrapDnrUpdater('updateStaticRules', 'static') ?? base.updateStaticRules,
          getEnabledRulesets: invokeApi('dnr.getEnabledRulesets', { defaultResponse: [] }),
          getDisabledRuleIds: invokeApi('dnr.getDisabledRuleIds', { defaultResponse: [] }),
          getAvailableStaticRuleCount: (cb?: (n: number) => void) => {
            if (typeof cb === 'function') {
              queueMicrotask(() => cb(300000))
              return
            }
            return Promise.resolve(300000)
          },
          setExtensionActionOptions:
            wrapDnrUpdater('setExtensionActionOptions', 'dynamic', true) ?? base.setExtensionActionOptions,
          getMatchedRules: (filter: unknown, cb?: (r: unknown) => void) => {
            const f = typeof filter === 'function' ? undefined : filter
            const callback = typeof filter === 'function' ? (filter as (r: unknown) => void) : cb
            const p = bridgeApi.getMatchedRules(extensionId, f)
            if (callback) {
              p.then((r) => callback(r), () => callback({ rulesMatchedInfo: [] }))
              return
            }
            return p
          }
        })
      },
      downloads: {
        factory: (base) => ({
          ...base,
          download: invokeApi('downloads.download'),
          search: invokeApi('downloads.search', { defaultResponse: [] }),
          pause: invokeApi('downloads.pause'),
          resume: invokeApi('downloads.resume'),
          cancel: invokeApi('downloads.cancel'),
          erase: invokeApi('downloads.erase', { defaultResponse: [] }),
          open: invokeApi('downloads.open'),
          show: invokeApi('downloads.show'),
          showDefaultFolder: invokeApi('downloads.showDefaultFolder'),
          removeFile: invokeApi('downloads.removeFile'),
          acceptDanger: invokeCrx('downloads.acceptDanger', { noop: true }),
          getFileIcon: invokeCrx('downloads.getFileIcon', { noop: true }),
          setUiOptions: invokeCrx('downloads.setUiOptions', { noop: true }),
          onChanged: new ExtensionEvent('downloads.onChanged', 'masaki'),
          onCreated: new ExtensionEvent('downloads.onCreated', 'masaki'),
          onDeterminingFilename: new LocalEvent(),
          onErased: new LocalEvent()
        })
      },
      extension: {
        factory: (base) => ({
          ...base,
          getURL: (p: string) =>
            typeof runtimeBase.getURL === 'function'
              ? (runtimeBase.getURL as (x: string) => string)(p)
              : `chrome-extension://${extensionId}/${String(p || '').replace(/^\//, '')}`,
          isAllowedFileSchemeAccess: invokeApi('extension.isAllowedFileSchemeAccess', { defaultResponse: true }),
          isAllowedIncognitoAccess: invokeApi('extension.isAllowedIncognitoAccess', { defaultResponse: false }),
          getViews: () => [],
          getBackgroundPage: () => null
        })
      },
      fontSettings: {
        factory: () => ({
          getFontList: invokeApi('fontSettings.getFontList', { defaultResponse: [] }),
          getFont: invokeApi('fontSettings.getFont', { defaultResponse: { fontId: '', levelOfControl: 'controllable_by_this_extension' } }),
          setFont: invokeApi('fontSettings.setFont'),
          clearFont: invokeApi('fontSettings.clearFont'),
          getDefaultFontSize: invokeApi('fontSettings.getDefaultFontSize', { defaultResponse: { pixelSize: 16, levelOfControl: 'controllable_by_this_extension' } }),
          setDefaultFontSize: invokeApi('fontSettings.setDefaultFontSize'),
          getDefaultFixedFontSize: invokeApi('fontSettings.getDefaultFixedFontSize', { defaultResponse: { pixelSize: 13, levelOfControl: 'controllable_by_this_extension' } }),
          setDefaultFixedFontSize: invokeApi('fontSettings.setDefaultFixedFontSize'),
          getMinimumFontSize: invokeApi('fontSettings.getMinimumFontSize', { defaultResponse: { pixelSize: 0, levelOfControl: 'controllable_by_this_extension' } }),
          setMinimumFontSize: invokeApi('fontSettings.setMinimumFontSize'),
          onFontChanged: new LocalEvent(),
          onDefaultFontSizeChanged: new LocalEvent(),
          onDefaultFixedFontSizeChanged: new LocalEvent(),
          onMinimumFontSizeChanged: new LocalEvent()
        })
      },
      history: {
        factory: () => ({
          search: invokeApi('history.search', { defaultResponse: [] }),
          getVisits: invokeApi('history.getVisits', { defaultResponse: [] }),
          addUrl: invokeApi('history.addUrl'),
          deleteUrl: invokeApi('history.deleteUrl'),
          deleteRange: invokeApi('history.deleteRange'),
          deleteAll: invokeApi('history.deleteAll'),
          onVisited: new ExtensionEvent('history.onVisited', 'masaki'),
          onVisitRemoved: new LocalEvent()
        })
      },
      bookmarks: {
        factory: () => ({
          get: invokeApi('bookmarks.get', { defaultResponse: [] }),
          getTree: invokeApi('bookmarks.getTree', { defaultResponse: [] }),
          getChildren: invokeApi('bookmarks.getChildren', { defaultResponse: [] }),
          getRecent: invokeApi('bookmarks.getRecent', { defaultResponse: [] }),
          search: invokeApi('bookmarks.search', { defaultResponse: [] }),
          create: invokeApi('bookmarks.create'),
          update: invokeApi('bookmarks.update'),
          remove: invokeApi('bookmarks.remove'),
          removeTree: invokeApi('bookmarks.remove'),
          onCreated: new LocalEvent(),
          onRemoved: new LocalEvent(),
          onChanged: new LocalEvent()
        })
      },
      browsingData: {
        factory: () => ({
          settings: invokeApi('browsingData.settings', { defaultResponse: { options: {}, dataToRemove: {}, dataRemovalPermitted: {} } }),
          remove: invokeApi('browsingData.remove'),
          removeCache: invokeApi('browsingData.removeCache'),
          removeCookies: invokeApi('browsingData.removeCookies'),
          removeHistory: invokeApi('browsingData.removeHistory'),
          removeLocalStorage: invokeApi('browsingData.removeLocalStorage')
        })
      },
      identity: {
        factory: () => ({
          getRedirectURL: (path = '') => `https://${extensionId}.chromiumapp.org/${String(path).replace(/^\//, '')}`,
          launchWebAuthFlow: invokeApi('identity.launchWebAuthFlow'),
          getProfileUserInfo: invokeApi('identity.getProfileUserInfo', { defaultResponse: { email: '', id: '' } }),
          getAuthToken: invokeApi('identity.getAuthToken'),
          removeCachedAuthToken: invokeApi('identity.removeCachedAuthToken'),
          clearAllCachedAuthTokens: invokeApi('identity.clearAllCachedAuthTokens'),
          onSignInChanged: new LocalEvent()
        })
      },
      i18n: {
        factory: (base) =>
          typeof base.getMessage === 'function'
            ? base
            : {
                ...base,
                getUILanguage: () => (typeof navigator !== 'undefined' ? navigator.language || 'ru' : 'ru'),
                getAcceptLanguages: (cb?: (langs: string[]) => void) => {
                  const langs = typeof navigator !== 'undefined' && navigator.languages?.length ? [...navigator.languages] : ['ru', 'en-US']
                  if (cb) {
                    queueMicrotask(() => cb(langs))
                    return
                  }
                  return Promise.resolve(langs)
                },
                getMessage: (msg: string) => msg
              }
      },
      notifications: {
        factory: (base) => ({
          ...base,
          clear: invokeCrx('notifications.clear'),
          create: invokeApi('notifications.create'),
          getAll: invokeCrx('notifications.getAll'),
          getPermissionLevel: invokeCrx('notifications.getPermissionLevel'),
          update: invokeCrx('notifications.update'),
          onClicked: new ExtensionEvent('notifications.onClicked'),
          onButtonClicked: new ExtensionEvent('notifications.onButtonClicked'),
          onClosed: new ExtensionEvent('notifications.onClosed')
        })
      },
      permissions: {
        factory: (base) => ({
          ...base,
          contains(perms: { permissions?: string[]; origins?: string[] }, cb?: (ok: boolean) => void): Promise<boolean> | void {
            const p = (permGetAllBase() as Promise<{ permissions?: string[]; origins?: string[] }>).then((cur) => {
              const curP = cur?.permissions ?? []
              const curO = cur?.origins ?? []
              const okP = (perms?.permissions ?? []).every((x) => curP.includes(x))
              const okO = (perms?.origins ?? []).every((req) => curO.some((g) => patternMatches(g, req)))
              return okP && okO
            })
            if (cb) {
              p.then((ok) => cb(ok), () => cb(false))
              return
            }
            return p
          },
          getAll: permGetAllBase,
          remove: invokeCrx('permissions.remove'),
          request: invokeCrx('permissions.request'),
          onAdded: new ExtensionEvent('permissions.onAdded'),
          onRemoved: new ExtensionEvent('permissions.onRemoved')
        })
      },
      privacy: {
        factory: () => ({
          network: {
            networkPredictionEnabled: createChromeSetting('networkPredictionEnabled'),
            webRTCIPHandlingPolicy: createChromeSetting('webRTCIPHandlingPolicy')
          },
          services: {
            autofillAddressEnabled: createChromeSetting('autofillAddressEnabled'),
            autofillCreditCardEnabled: createChromeSetting('autofillCreditCardEnabled'),
            passwordSavingEnabled: createChromeSetting('passwordSavingEnabled')
          },
          websites: {
            hyperlinkAuditingEnabled: createChromeSetting('hyperlinkAuditingEnabled'),
            doNotTrackEnabled: createChromeSetting('doNotTrackEnabled'),
            thirdPartyCookiesAllowed: createChromeSetting('thirdPartyCookiesAllowed'),
            referrersEnabled: createChromeSetting('referrersEnabled')
          }
        })
      },
      runtime: {
        factory: (base) => ({
          ...base,
          get lastError() {
            return currentLastError ?? (base.lastError as { message: string } | undefined)
          },
          connectNative: (application: string) => {
            const port = new NativePort()
            bridgeApi.connectNative(
              extensionId,
              application,
              port._receive.bind(port),
              port._disconnect.bind(port),
              (connectionId, send) => port._init(connectionId, send)
            )
            return port
          },
          openOptionsPage: invokeCrx('runtime.openOptionsPage'),
          sendNativeMessage: invokeCrx('runtime.sendNativeMessage'),
          onInstalled: {
            addListener(cb: (d: unknown) => void): void {
              if (typeof cb === 'function') {
                installedListeners.add(cb)
                scheduleLifecyclePull()
              }
            },
            removeListener(cb: (d: unknown) => void): void {
              installedListeners.delete(cb)
            },
            hasListener(cb: (d: unknown) => void): boolean {
              return installedListeners.has(cb)
            },
            hasListeners(): boolean {
              return installedListeners.size > 0
            }
          },
          onStartup: {
            addListener(cb: () => void): void {
              if (typeof cb === 'function') {
                startupListeners.add(cb)
                scheduleLifecyclePull()
              }
            },
            removeListener(cb: () => void): void {
              startupListeners.delete(cb)
            },
            hasListener(cb: () => void): boolean {
              return startupListeners.has(cb)
            },
            hasListeners(): boolean {
              return startupListeners.size > 0
            }
          }
        })
      },
      search: {
        factory: () => ({
          query: invokeApi('search.query')
        })
      },
      sessions: {
        factory: () => ({
          MAX_SESSION_RESULTS: 25,
          getRecentlyClosed: invokeApi('sessions.getRecentlyClosed', { defaultResponse: [] }),
          getDevices: invokeApi('sessions.getDevices', { defaultResponse: [] }),
          restore: invokeApi('sessions.restore'),
          onChanged: new LocalEvent()
        })
      },
      sidePanel: {
        factory: () => ({
          setOptions: invokeApi('sidePanel.setOptions'),
          getOptions: invokeApi('sidePanel.getOptions', { defaultResponse: { enabled: false } }),
          setPanelBehavior: invokeApi('sidePanel.setPanelBehavior'),
          getPanelBehavior: invokeApi('sidePanel.getPanelBehavior', { defaultResponse: { openPanelOnActionClick: false } }),
          open: invokeApi('sidePanel.open')
        })
      },
      storage: {
        factory: (base) => {
          const local = base?.local
          const session = base?.session ?? local
          return {
            ...base,
            local,
            session,
            sync: local,
            managed: managedStorage
          }
        }
      },
      tabGroups: {
        factory: () => ({
          TAB_GROUP_ID_NONE: -1,
          get: invokeApi('tabGroups.get'),
          query: invokeApi('tabGroups.query', { defaultResponse: [] }),
          update: invokeApi('tabGroups.update'),
          move: invokeApi('tabGroups.move'),
          onCreated: new LocalEvent(),
          onRemoved: new LocalEvent(),
          onUpdated: new LocalEvent()
        })
      },
      tabs: { factory: () => tabsApi },
      topSites: {
        factory: () => ({
          get: invokeApi('topSites.get', { defaultResponse: [] })
        })
      },
      tts: {
        factory: () => ({
          speak: () => Promise.resolve(),
          stop: () => {},
          pause: () => {},
          resume: () => {},
          isSpeaking: (cb?: (v: boolean) => void) => {
            if (cb) {
              queueMicrotask(() => cb(false))
              return
            }
            return Promise.resolve(false)
          },
          getVoices: (cb?: (v: unknown[]) => void) => {
            if (cb) {
              queueMicrotask(() => cb([]))
              return
            }
            return Promise.resolve([])
          }
        })
      },
      userScripts: {
        factory: () => ({
          ExecutionWorld: { MAIN: 'MAIN', USER_SCRIPT: 'USER_SCRIPT' },
          register: invokeApi('userScripts.register'),
          unregister: invokeApi('userScripts.unregister'),
          update: invokeApi('userScripts.update'),
          getScripts: invokeApi('userScripts.getScripts', { defaultResponse: [] }),
          configureWorld: invokeApi('userScripts.configureWorld'),
          getWorldConfigurations: invokeApi('userScripts.getWorldConfigurations', { defaultResponse: [] }),
          resetWorldConfiguration: invokeApi('userScripts.resetWorldConfiguration'),
          execute: invokeApi('userScripts.execute', { defaultResponse: [] })
        })
      },
      webNavigation: {
        factory: (base) => ({
          ...base,
          getFrame: invokeCrx('webNavigation.getFrame'),
          getAllFrames: invokeCrx('webNavigation.getAllFrames'),
          onBeforeNavigate: new ExtensionEvent('webNavigation.onBeforeNavigate'),
          onCommitted: new ExtensionEvent('webNavigation.onCommitted'),
          onCompleted: new ExtensionEvent('webNavigation.onCompleted'),
          onCreatedNavigationTarget: new ExtensionEvent('webNavigation.onCreatedNavigationTarget'),
          onDOMContentLoaded: new ExtensionEvent('webNavigation.onDOMContentLoaded'),
          onErrorOccurred: new ExtensionEvent('webNavigation.onErrorOccurred'),
          onHistoryStateUpdated: new ExtensionEvent('webNavigation.onHistoryStateUpdated'),
          onReferenceFragmentUpdated: new ExtensionEvent('webNavigation.onReferenceFragmentUpdated'),
          onTabReplaced: new ExtensionEvent('webNavigation.onTabReplaced')
        })
      },
      webRequest: {
        factory: (base) => ({
          ...base,
          handlerBehaviorChanged: (cb?: () => void) => {
            if (cb) {
              queueMicrotask(() => cb())
              return
            }
            return Promise.resolve()
          },
          onBeforeRequest: makeWebRequestEvent('onBeforeRequest'),
          onBeforeSendHeaders: makeWebRequestEvent('onBeforeSendHeaders'),
          onSendHeaders: makeWebRequestEvent('onSendHeaders'),
          onHeadersReceived: makeWebRequestEvent('onHeadersReceived'),
          onResponseStarted: makeWebRequestEvent('onResponseStarted'),
          onBeforeRedirect: makeWebRequestEvent('onBeforeRedirect'),
          onCompleted: makeWebRequestEvent('onCompleted'),
          onErrorOccurred: makeWebRequestEvent('onErrorOccurred')
        })
      },
      windows: {
        factory: (base) => ({
          ...base,
          WINDOW_ID_NONE: -1,
          WINDOW_ID_CURRENT: -2,
          get: invokeCrx('windows.get'),
          getCurrent: invokeCrx('windows.getCurrent'),
          getLastFocused: invokeCrx('windows.getLastFocused'),
          getAll: invokeCrx('windows.getAll'),
          create: invokeCrx('windows.create'),
          update: invokeCrx('windows.update'),
          remove: invokeCrx('windows.remove'),
          onCreated: new ExtensionEvent('windows.onCreated'),
          onRemoved: new ExtensionEvent('windows.onRemoved'),
          onFocusChanged: new ExtensionEvent('windows.onFocusChanged'),
          onBoundsChanged: new ExtensionEvent('windows.onBoundsChanged')
        })
      }
    }

    for (const [apiName, def] of Object.entries(apiDefinitions)) {
      if (def.shouldInject && !def.shouldInject()) continue
      const baseApi = (chrome[apiName] as Record<string, unknown>) || {}
      try {
        Object.defineProperty(chrome, apiName, {
          value: def.factory(baseApi),
          enumerable: true,
          configurable: true,
          writable: true
        })
      } catch {
        // на случай защищённого свойства в конкретном контексте
      }
    }

    // Критично для Electron 44 (Chromium 146+): нативный globalThis.browser содержит урезанные
    // биндинги без permissions/tabs.create/windows/contextMenus. Синхронизируем все пространства.
    if (typeof g.browser === 'object' && g.browser) {
      const br = g.browser
      for (const key of Object.keys(chrome)) {
        try {
          Object.defineProperty(br, key, {
            value: chrome[key],
            enumerable: true,
            configurable: true,
            writable: true
          })
        } catch {
          // игнорируем нередактируемые служебные поля
        }
      }
      try {
        Object.defineProperty(br, 'menus', {
          value: chrome.contextMenus,
          enumerable: true,
          configurable: true,
          writable: true
        })
      } catch {
        // игнорируем
      }
    } else {
      g.browser = { ...chrome, menus: chrome.contextMenus }
    }

    // Важно: НЕ вызываем Object.freeze(chrome) — расширения вроде SponsorBlock дописывают туда полифиллы.
    void permContainsBase
  }

  if (!process.contextIsolated) {
    ;(globalThis as Record<string, unknown>).__masakiExtBridge = bridge
    mainWorldScript()
  } else {
    try {
      contextBridge.exposeInMainWorld('__masakiExtBridge', bridge)
      contextBridge.executeInMainWorld({ func: mainWorldScript })
    } catch (e) {
      console.error('Masaki extension preload error:', location.href, e)
    }
  }
}
