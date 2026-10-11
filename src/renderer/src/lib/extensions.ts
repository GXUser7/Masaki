// Кнопки расширений Chrome со стороны интерфейса: состояние кнопок (chrome.action) приходит
// из electron-chrome-extensions в главном процессе, значки — по адресу crx://extension-icon/….

import { useEffect, useState } from 'react'
import type { ExtAction, ExtActionInfo, ExtActionsState, ExtensionInfo } from '../../../shared/types'
import { useStore, wv } from '../store'

let state: ExtActionsState = { actions: [] }
let list: ExtensionInfo[] = []
const listeners = new Set<() => void>()
let started = false

const emit = (): void => listeners.forEach((fn) => fn())

async function refreshActions(): Promise<void> {
  try {
    state = await window.masaki.extensions.actions()
  } catch {
    state = { actions: [] }
  }
  emit()
}

async function refreshList(): Promise<void> {
  list = await window.masaki.extensions.list().catch(() => list)
  emit()
}

function start(): void {
  if (started) return
  started = true
  window.masaki.extensions.onActionsChanged(() => void refreshActions())
  window.masaki.extensions.onChanged(() => {
    void refreshActions()
    void refreshList()
  })
  void refreshActions()
  void refreshList()
}

/** Кнопки расширений и сведения о самих расширениях; обновляются сами. */
export function useExtensions(): { actions: ExtAction[]; list: ExtensionInfo[]; tabId: number } {
  const [, force] = useState(0)
  const activeId = useStore((s) => s.activeId)
  useEffect(() => {
    start()
    const fn = (): void => force((n) => n + 1)
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  }, [])
  let tabId = state.activeTabId ?? -1
  try {
    tabId = wv(activeId)?.getWebContentsId() ?? tabId
  } catch {
    // webview ещё не готов — берём то, что знает главный процесс
  }
  return { actions: state.actions, list, tabId }
}

/** Свойства кнопки для вкладки: своё значение вкладки сильнее общего. */
export function actionFor(a: ExtAction, tabId: number): ExtActionInfo {
  return { ...a, ...(a.tabs[String(tabId)] ?? {}) }
}

export function actionIcon(id: string, tabId: number, modified?: number): string {
  const q = new URLSearchParams({ tabId: String(tabId), partition: 'persist:frost' })
  if (modified) q.append('t', String(modified))
  return `crx://extension-icon/${id}/32/2?${q}`
}

/** Цвет бейджа: расширения задают его строкой или массивом [r, g, b, a]. */
export function badgeColor(c: unknown): string | undefined {
  if (typeof c === 'string') return c
  if (Array.isArray(c) && c.length >= 3) return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${(c[3] ?? 255) / 255})`
  return undefined
}

/** Нажатие на кнопку: всплывающее окно расширения у кнопки (снизу в панели, сверху в доке). */
export function pressAction(id: string, tabId: number, r: { left: number; top: number; width: number; height: number }): void {
  const dock = useStore.getState().settings.sidebarCollapsed
  window.masaki.extensions.activate(id, tabId, { x: r.left, y: r.top, width: r.width, height: r.height }, dock ? 'top' : 'bottom right')
}

export function togglePin(id: string): void {
  const s = useStore.getState()
  const pinned = s.settings.addons.pinnedExtensions
  const next = pinned.includes(id) ? pinned.filter((x) => x !== id) : [...pinned, id]
  s.setSettings({ addons: { ...s.settings.addons, pinnedExtensions: next } })
}

export const STORE_URL = 'https://chromewebstore.google.com/'
