import type { Command } from '../../shared/types'
import { aiModeUrl, searchUrl } from './lib/url'
import { tabIdOfWebContents, useStore, wv } from './store'

const S = useStore.getState

function activeWebview(): Electron.WebviewTag | null {
  const t = S().active()
  return t && t.kind === 'web' ? wv(t.id) : null
}

export function goBack(): void {
  const el = activeWebview()
  if (el?.canGoBack()) el.goBack()
}

export function goForward(): void {
  const el = activeWebview()
  if (el?.canGoForward()) el.goForward()
}

export function reloadOrStop(hard = false): void {
  const t = S().active()
  const el = activeWebview()
  if (!el) return
  if (t.loading && !hard) {
    el.stop()
    return
  }
  if (t.error) {
    void el.loadURL(t.error.url).catch(() => undefined)
    return
  }
  if (hard) el.reloadIgnoringCache()
  else el.reload()
}

export function zoom(delta: 1 | -1 | 0): void {
  const t = S().active()
  const el = activeWebview()
  if (!el) return
  const z = delta === 0 ? 0 : Math.min(5, Math.max(-4, t.zoom + delta * 0.5))
  el.setZoomLevel(z)
  S().updateTab(t.id, { zoom: z })
}

export function printPage(): void {
  activeWebview()?.print()
}

export function toggleDevtools(): void {
  const el = activeWebview()
  if (!el) return
  if (el.isDevToolsOpened()) el.closeDevTools()
  else el.openDevTools()
}

export function toggleMute(id: string): void {
  const t = S().tabs.find((x) => x.id === id)
  const el = wv(id)
  if (!t || !el) return
  el.setAudioMuted(!t.muted)
  S().updateTab(id, { muted: !t.muted })
}

export function findInPage(text: string, forward = true, next = false): void {
  const el = activeWebview()
  if (!el) return
  if (!text) {
    el.stopFindInPage('clearSelection')
    S().setFind({ matches: 0, active: 0 })
    return
  }
  el.findInPage(text, { forward, findNext: next })
}

export function closeFind(): void {
  activeWebview()?.stopFindInPage('clearSelection')
  S().setFind({ open: false, matches: 0, active: 0 })
}

/** Кнопка AI Mode — это действие «спросить»: всегда открывает палитру сразу в режиме AI Mode. */
export function aiButton(): void {
  S().openPalette(false, 'current', undefined, true)
}

export function toggleFavorite(): void {
  const s = S()
  const t = s.active()
  if (t.kind !== 'web') return
  const favs = s.settings.favorites
  const has = favs.some((f) => f.url === t.url)
  s.setSettings({
    favorites: has ? favs.filter((f) => f.url !== t.url) : [...favs, { title: t.title || t.url, url: t.url }].slice(-8)
  })
}

export function handleCommand(c: Command): void {
  const s = S()
  switch (c.type) {
    case 'new-tab':
      s.newTab()
      break
    case 'close-tab':
      s.closeTab()
      break
    case 'reopen-tab':
      s.reopenTab()
      break
    case 'next-tab':
      s.cycle(1)
      break
    case 'prev-tab':
      s.cycle(-1)
      break
    case 'tab-index':
      s.activateIndex(c.index)
      break
    case 'palette':
      // По хоткею результат открывается в новой вкладке; клик по строке поиска заменяет текущую.
      // Пустую новую вкладку новой вкладкой не плодим.
      s.openPalette(c.withUrl, s.active().kind === 'newtab' ? 'current' : 'new')
      break
    case 'toggle-sidebar':
      s.toggleSidebar()
      break
    case 'back':
      goBack()
      break
    case 'forward':
      goForward()
      break
    case 'reload': {
      const el = activeWebview()
      if (!el) break
      if (c.hard) el.reloadIgnoringCache()
      else el.reload()
      break
    }
    case 'find':
      if (s.active().kind === 'web') s.setFind({ open: true, focusTick: s.find.focusTick + 1 })
      break
    case 'zoom':
      zoom(c.delta)
      break
    case 'devtools':
      toggleDevtools()
      break
    case 'settings':
      s.openSettings()
      break
    case 'addons':
      s.openAddons()
      break
    case 'save-page': {
      const el = activeWebview()
      if (el) window.masaki.pageAction(el.getWebContentsId(), { type: 'save-page' })
      break
    }
    case 'view-source': {
      const t = s.active()
      if (t.kind === 'web' && !t.url.startsWith('view-source:')) s.newTab('view-source:' + t.url)
      break
    }
    case 'print':
      printPage()
      break
    case 'escape':
      if (s.glance) useStore.setState({ glance: null })
      else if (s.snap) useStore.setState({ snap: null })
      else if (s.menu) s.closeMenu()
      else if (s.palette.open) s.closePalette()
      else if (s.popover) s.setPopover(null)
      else if (s.find.open) closeFind()
      break
    case 'open-url':
      s.newTab(c.url, { background: c.background })
      break
    case 'search':
      s.newTab(c.ai ? aiModeUrl(c.text) : searchUrl(c.text))
      break
    case 'tab-search':
      s.openTabSearch()
      break
    case 'close-empty-tab': {
      const id = tabIdOfWebContents(c.wcId)
      if (id) s.closeTab(id, false)
      break
    }
    case 'close-tabs':
      for (const t of s.tabs.filter((t) => t.kind === 'web' && t.url.startsWith(c.prefix))) S().closeTab(t.id)
      break
  }
}
