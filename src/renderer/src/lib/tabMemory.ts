import { useStore, wv, type Tab } from '../store'

const visible = (id: string): boolean => {
  const s = useStore.getState()
  return id === s.activeId || !!(s.split && (s.split.a === s.activeId || s.split.b === s.activeId) &&
    (s.split.a === id || s.split.b === id))
}

/** Периодический обход создаёт снимок навигации, а затем удаляет сам webview вместе со страницей. */
export async function sleepInactiveTabs(now = Date.now()): Promise<void> {
  const eligible = (tab: Tab): boolean => {
    const s = useStore.getState()
    const wcId = wv(tab.id)?.getWebContentsId()
    return s.settings.sleepAfter > 0 && tab.kind === 'web' && !tab.sleeping && !visible(tab.id) &&
      !tab.loading && !tab.audible && !tab.media?.playing &&
      now - (tab.lastActive ?? now) >= s.settings.sleepAfter * 60_000 &&
      !s.permissions.some((p) => p.wcId === wcId) &&
      !s.pkPrompts.some((p) => p.wcId === wcId) &&
      !s.jsDialogs.some((p) => p.wcId === wcId)
  }
  for (const tab of useStore.getState().tabs) {
    if (!eligible(tab)) continue
    const el = wv(tab.id)
    if (!el) continue
    const key = await window.masaki.tabMemory.save(el.getWebContentsId()).catch(() => null)
    if (!key) continue
    const current = useStore.getState().tabs.find((t) => t.id === tab.id)
    // Пока главный процесс читал состояние, вкладку могли выбрать, закрыть или перевести на другой адрес.
    if (!current || !eligible(current) || current.url !== tab.url || wv(tab.id) !== el) {
      window.masaki.tabMemory.forget(key)
      continue
    }
    useStore.getState().updateTab(tab.id, {
      sleeping: true, resumeKey: key, initialUrl: current.url,
      loading: false, audible: false, media: undefined, pausedByUs: false, glassBg: undefined
    })
  }
}

export function startTabMemory(): () => void {
  let checking = false
  const timer = window.setInterval(() => {
    if (checking) return
    checking = true
    void sleepInactiveTabs().finally(() => { checking = false })
  }, 30_000)
  return () => window.clearInterval(timer)
}
