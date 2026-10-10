// Аддон «Прозрачные сайты» — как моды Zen. Фон страницы становится прозрачным, и сквозь
// страницу видно матовое стекло Masaki. Чтобы текст светлых сайтов не потерялся, свой цвет
// сайта Masaki подкладывает под страницу полупрозрачным слоем (насколько — решает ползунок).

import { hostOf } from './url'
import { useStore, wv } from '../store'
// Сам скрипт для страницы — в glass-page.js: ставится один раз и даёт window.__masakiGlass.
import INSTALL from './glass-page.js?raw'

export function glassAllowed(url: string): boolean {
  const { enabled, exclude } = useStore.getState().settings.addons.glass
  if (!enabled || !/^https?:|^file:/i.test(url)) return false
  return !exclude.includes(hostOf(url))
}

/** Тёмный ли цвет «r,g,b» — то же правило, что в glass-page.js. */
export function isDarkRgb(rgb: string): boolean {
  const [r, g, b] = rgb.split(',').map(Number)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128
}

/**
 * «Как у панели»: под сайтом то же стекло, что у боковой панели, — но только если сайт той же
 * светлоты, что тема. Светлый сайт в тёмной теме остаётся на своём цвете, иначе пропадёт текст.
 */
export function matchesPanel(glassBg: string | undefined, dark: boolean): boolean {
  return !!glassBg && useStore.getState().settings.addons.glass.match && isDarkRgb(glassBg) === dark
}

/** Цвет стекла панели (--wall) и тема — для шапок сайта в режиме «как у панели». */
function panelTint(): { rgb: number[]; dark: boolean } | null {
  if (!useStore.getState().settings.addons.glass.match) return null
  const hex = getComputedStyle(document.documentElement).getPropertyValue('--wall').trim()
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return null
  const n = parseInt(m[1], 16)
  return { rgb: [n >> 16, (n >> 8) & 255, n & 255], dark: !!document.querySelector('.app.dark') }
}

/** Включить или снять прозрачность во вкладке по текущим настройкам. */
export async function syncGlass(tabId: string): Promise<void> {
  const el = wv(tabId)
  const store = useStore.getState()
  const tab = store.tabs.find((t) => t.id === tabId)
  if (!el || !tab || tab.kind !== 'web') return
  try {
    if (glassAllowed(tab.url)) {
      const strong = store.settings.addons.glass.strength === 'strong'
      const panel = JSON.stringify(panelTint())
      const bg = (await el.executeJavaScript(`${INSTALL}; window.__masakiGlass.apply(${strong}, ${panel})`)) as string
      useStore.getState().updateTab(tabId, { glassBg: bg })
    } else if (tab.glassBg) {
      await el.executeJavaScript('window.__masakiGlass && window.__masakiGlass.remove()')
      useStore.getState().updateTab(tabId, { glassBg: undefined })
    }
  } catch {
    // страница ещё грузится или недоступна для скриптов (например, view-source:)
  }
}

export function syncGlassAll(): void {
  for (const t of useStore.getState().tabs) if (t.kind === 'web') void syncGlass(t.id)
}

/** Включить или выключить аддон целиком (кнопка рядом с кнопкой панели, команда палитры). */
export function toggleGlass(): void {
  const s = useStore.getState()
  const g = s.settings.addons.glass
  s.setSettings({ addons: { ...s.settings.addons, glass: { ...g, enabled: !g.enabled } } })
}

/** Переключить прозрачность для сайта вкладки (пункт контекстного меню). */
export function toggleGlassForSite(url: string): void {
  const s = useStore.getState()
  const g = s.settings.addons.glass
  const host = hostOf(url)
  const exclude = g.exclude.includes(host) ? g.exclude.filter((h) => h !== host) : [...g.exclude, host]
  s.setSettings({ addons: { ...s.settings.addons, glass: { ...g, exclude } } })
  syncGlassAll()
}
