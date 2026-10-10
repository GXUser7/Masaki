// YouCloud в Masaki со стороны интерфейса: открыть сайт (или уже открытую вкладку), искать в нём
// из палитры, управлять музыкой любой вкладки через её Media Session (main/youcloud.ts — мост
// для самого сайта, preload/media-page.ts — что играет на странице).

import { useStore, wv, type Tab, type TabMedia } from '../store'

export const YOUCLOUD_URL = 'https://youcloud.inkerror67.workers.dev/'
const ORIGINS = ['https://youcloud.inkerror67.workers.dev', 'http://localhost:5190']

export function isYouCloud(url: string): boolean {
  try {
    return ORIGINS.includes(new URL(url).origin)
  } catch {
    return false
  }
}

/** Пользовались ли YouCloud в Masaki: тогда палитра предлагает искать музыку и там. */
export function youcloudKnown(): boolean {
  const s = useStore.getState()
  return s.tabs.some((t) => t.kind === 'web' && isYouCloud(t.url)) || s.history.some((h) => isYouCloud(h.url))
}

/** Открыть YouCloud — уже открытую вкладку, если есть; с запросом — сразу на его поиск. */
export function openYouCloud(query?: string): void {
  const s = useStore.getState()
  const route = query?.trim() ? '#/search/' + encodeURIComponent(query.trim()) : ''
  const open = s.tabs.find((t) => t.kind === 'web' && isYouCloud(t.url))
  if (!open) {
    s.newTab(YOUCLOUD_URL + route)
    return
  }
  s.activate(open.id)
  const el = wv(open.id)
  if (route && el) void el.executeJavaScript(`location.hash = ${JSON.stringify(route)}`).catch(() => undefined)
}

/** Тема Masaki для сайта: его цвет «по умолчанию» и светлота — те же, что у браузера вокруг. */
function theme(): { seed: string; dark: boolean } {
  return {
    seed: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
    dark: !!document.querySelector('.app.dark')
  }
}

/** Отдать тему всем вкладкам YouCloud (или одной, только что загрузившейся). */
export function sendYouCloudTheme(tabId?: string): void {
  const t = theme()
  if (!t.seed) return
  for (const tab of useStore.getState().tabs) {
    if (tab.kind !== 'web' || !isYouCloud(tab.url) || (tabId && tab.id !== tabId)) continue
    try {
      wv(tab.id)?.send('yc:theme', t)
    } catch {
      // webview ещё не готов — тему отдаст dom-ready
    }
  }
}

/** Вкладка, чья музыка сейчас главная: играющая, иначе последняя поставленная на паузу. */
export function musicTab(): Tab | undefined {
  const tabs = useStore.getState().tabs.filter((t) => t.kind === 'web' && (t.media || t.audible || t.pausedByUs))
  return tabs.find((t) => t.audible && !t.pausedByUs) ?? tabs.find((t) => t.pausedByUs) ?? tabs.find((t) => t.media?.title)
}

export const mediaPlaying = (t: Tab): boolean => (t.media ? t.media.playing : t.audible) && !t.pausedByUs

/** Кнопка плеера сайта: следующий, предыдущий, пауза, перемотка — как медиаклавиши. */
export function mediaAction(t: Tab, action: 'play' | 'pause' | 'previoustrack' | 'nexttrack' | 'seekto', time = 0): void {
  const el = wv(t.id)
  if (!el) return
  el.send('media:action', action, time)
  if (action === 'pause') useStore.getState().updateTab(t.id, { pausedByUs: true })
  if (action === 'play') useStore.getState().updateTab(t.id, { pausedByUs: false })
}

const ACTIONS = new Set(['play', 'pause', 'previoustrack', 'nexttrack', 'seekto', 'seekbackward', 'seekforward', 'stop'])
const text = (v: unknown, n = 300): string => (typeof v === 'string' ? v.trim().slice(0, n) : '')
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Что прислала страница о своей музыке — с проверкой: это слова страницы, а не наши. */
export function parseMedia(json: unknown): TabMedia | undefined {
  let d: Record<string, unknown>
  try {
    d = JSON.parse(String(json))
  } catch {
    return undefined
  }
  if (!d || typeof d !== 'object') return undefined
  const art = text(d.artwork, 4000)
  const actions = Array.isArray(d.actions) ? d.actions.filter((a): a is string => typeof a === 'string' && ACTIONS.has(a)) : []
  const p = d.position as Record<string, unknown> | null
  const duration = num(p?.duration)
  const media: TabMedia = {
    title: text(d.title),
    artist: text(d.artist),
    album: text(d.album),
    artwork: /^(https?:|data:image\/)/i.test(art) ? art : '',
    actions,
    playing: d.playing === true,
    position:
      p && duration && duration > 0
        ? { duration, position: Math.max(0, num(p.position) ?? 0), rate: num(p.rate) ?? 1, at: num(p.at) ?? Date.now() }
        : null
  }
  // Без названия и кнопок это не плеер, а просто звук — мини-плеер покажет вкладку, как раньше.
  return media.title || media.actions.length ? media : undefined
}
