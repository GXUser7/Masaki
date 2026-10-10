import { createElement, useEffect, useRef } from 'react'
import type { AutofillRequest } from '../../../shared/types'
import { finishSwipe } from './Extras'
import { hostOf } from '../lib/url'
import { captureThumb, markReady, registerWebview, unregisterWebview, useStore, type Tab } from '../store'
import { syncGlass } from '../lib/glass'
import { isYouCloud, parseMedia, sendYouCloudTheme } from '../lib/youcloud'

/** Одна вкладка = один <webview>. Неактивные просто скрыты и продолжают жить, как в Chrome. */
export function WebView({ tab, active, pane, ratio = 0.5 }: { tab: Tab; active: boolean; pane?: 'a' | 'b'; ratio?: number }): React.JSX.Element {
  const ref = useRef<Electron.WebviewTag | null>(null)
  const id = tab.id

  useEffect(() => {
    const el = ref.current
    if (!el) return
    registerWebview(id, el)
    const store = useStore.getState
    const up = (patch: Partial<Tab>): void => store().updateTab(id, patch)
    const syncNav = (): void => {
      try {
        up({ url: el.getURL(), canBack: el.canGoBack(), canFwd: el.canGoForward() })
      } catch {
        // webview ещё не готов
      }
    }

    const handlers: [string, (e: never) => void][] = [
      [
        'dom-ready',
        () => {
          markReady(id)
          syncNav()
          const t = store().tabs.find((x) => x.id === id)
          if (t?.zoom) el.setZoomLevel(t.zoom)
          if (t?.muted) el.setAudioMuted(true)
          // Новая страница — новый документ: прозрачность ставим заново.
          up({ glassBg: undefined })
          void syncGlass(id)
          if (isYouCloud(el.getURL())) sendYouCloudTheme(id)
        }
      ],
      [
        'did-start-loading',
        () => {
          up({ loading: true, error: undefined })
          if (store().autofill?.tabId === id) useStore.setState({ autofill: null })
        }
      ],
      [
        // Скрипт страницы просит показать (или спрятать) список аккаунтов у поля входа.
        'ipc-message',
        (e: Electron.IpcMessageEvent) => {
          const st = store()
          switch (e.channel) {
            case 'pw:show':
              if (st.activeId === id) useStore.setState({ autofill: { tabId: id, wcId: el.getWebContentsId(), req: e.args[0] as AutofillRequest } })
              break
            case 'pw:hide':
              if (st.autofill?.tabId === id) useStore.setState({ autofill: null })
              break
            case 'glance': {
              // Alt+клик по ссылке: карточка поверх страницы вместо новой вкладки.
              const url = String(e.args[0] ?? '')
              if (/^https?:/i.test(url)) useStore.setState({ glance: url })
              break
            }
            case 'scroll':
              // Листают вниз — капсула сжимается до домена, вверх — возвращается.
              if (st.activeId === id && st.settings.sidebarCollapsed) {
                const small = e.args[0] === 'down'
                if (st.capsuleSmall !== small) useStore.setState({ capsuleSmall: small })
              }
              break
            case 'swipe':
              if (st.activeId === id) useStore.setState({ swipe: { tabId: id, dx: Number(e.args[0]) || 0 } })
              break
            case 'swipe-end':
              finishSwipe(id, Number(e.args[0]) || 0)
              break
            case 'media':
              // Что играет на странице (Media Session) — для мини-плеера с обложкой и кнопками.
              up({ media: parseMedia(e.args[0]) })
              break
          }
        }
      ],
      [
        // В режиме «рядом» клик по второй половине делает её активной (адрес, поиск на странице).
        'focus',
        () => {
          const st = store()
          if (st.activeId !== id && st.split && (st.split.a === id || st.split.b === id)) st.activate(id)
        }
      ],
      ['did-stop-loading', () => {
        up({ loading: false })
        syncNav()
        // Снимок для превью, пока вкладка видна: потом, в фоне, она не рисуется.
        window.setTimeout(() => {
          if (store().activeId === id) captureThumb(id)
        }, 1200)
      }],
      [
        'did-navigate',
        (e: Electron.DidNavigateEvent) => {
          const prev = store().tabs.find((x) => x.id === id)
          const sameHost = prev && hostOf(prev.url) === hostOf(e.url)
          // Новый документ — прежний плеер страницы ушёл вместе с ним.
          up({ url: e.url, favicon: sameHost ? prev?.favicon : undefined, media: undefined })
          syncNav()
          store().addHistory(e.url, el.getTitle())
          // После входа или выхода из Google обновляем аватар в панели.
          if (/(^|\.)google\.com$/.test(new URL(e.url).hostname)) store().loadAccounts()
        }
      ],
      [
        'did-navigate-in-page',
        (e: Electron.DidNavigateInPageEvent) => {
          if (!e.isMainFrame) return
          up({ url: e.url })
          syncNav()
        }
      ],
      [
        'page-title-updated',
        (e: Electron.PageTitleUpdatedEvent) => {
          up({ title: e.title })
          store().addHistory(el.getURL(), e.title)
        }
      ],
      [
        'page-favicon-updated',
        (e: Electron.PageFaviconUpdatedEvent) => {
          up({ favicon: e.favicons[0] })
          // Значок сайта из избранного или ярлыков — запоминаем для плиток.
          const url = el.getURL()
          const host = hostOf(url)
          const st = store().settings
          if (e.favicons[0] && [...st.favorites, ...st.shortcuts].some((x) => hostOf(x.url) === host)) {
            window.masaki.learnFavicon(url, e.favicons[0])
          }
        }
      ],
      [
        'did-fail-load',
        (e: Electron.DidFailLoadEvent) => {
          // -3 — отменённая загрузка (например, новая навигация поверх старой), это не ошибка.
          if (!e.isMainFrame || e.errorCode === -3) return
          up({ loading: false, error: { code: e.errorCode, desc: e.errorDescription, url: e.validatedURL } })
        }
      ],
      ['media-started-playing', () => up({ audible: true, pausedByUs: false })],
      ['media-paused', () => up({ audible: false })],
      [
        'enter-html-full-screen',
        () => {
          useStore.setState({ htmlFullscreen: true })
          window.masaki.win.setFullScreen(true)
        }
      ],
      [
        'leave-html-full-screen',
        () => {
          useStore.setState({ htmlFullscreen: false })
          window.masaki.win.setFullScreen(false)
        }
      ],
      [
        'found-in-page',
        (e: Electron.FoundInPageEvent) => {
          const r = e.result
          store().setFind({ active: r.activeMatchOrdinal, matches: r.matches })
        }
      ]
    ]
    for (const [name, fn] of handlers) el.addEventListener(name, fn as EventListener)
    return () => {
      for (const [name, fn] of handlers) el.removeEventListener(name, fn as EventListener)
      unregisterWebview(id)
    }
  }, [id])

  return createElement('webview', {
    ref,
    src: tab.initialUrl,
    partition: 'persist:frost', // старое имя сессии: в ней куки и входы, не менять
    allowpopups: 'true',
    webpreferences: 'spellcheck=yes',
    className: 'wv' + (active || pane ? ' on' : '') + (pane ? ' pane' : '') + (pane && active ? ' focused' : ''),
    style: pane === 'a' ? { width: `calc(${ratio * 100}% - 4px)` } : pane === 'b' ? { left: `calc(${ratio * 100}% + 4px)`, width: 'auto', right: 0 } : undefined,
    'data-tab': id
  })
}
