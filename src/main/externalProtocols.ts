import { app, shell, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import type { PermissionPrompt } from '../shared/types'

// Эти адреса принадлежат браузеру: передавать их обработчику Windows нельзя.
const INTERNAL = new Set(['http:', 'https:', 'file:', 'about:', 'data:', 'blob:', 'javascript:', 'masaki:', 'frost:', 'chrome:', 'chrome-extension:', 'devtools:', 'crx:', 'view-source:', 'ws:', 'wss:'])
const BLOCKED = new Set(['shell:', 'cmd:', 'powershell:', 'ms-msdt:', 'search-ms:', 'ms-search:'])
type Pending = { wc: WebContents; url: string; origin: string; close(): void }
const pending = new Map<string, Pending>()
let notify: (channel: string, payload: unknown) => void

export function initExternalProtocols(ui: typeof notify): void { notify = ui }

/** Только прикладные URI. Ни файлы, ни код, ни адреса с управляющими символами не идут в ОС. */
export function externalScheme(url: string): string | null {
  if (url.length > 8192 || /[\u0000-\u0020\u007f]/.test(url)) return null
  try {
    const scheme = new URL(url).protocol
    return INTERNAL.has(scheme) || BLOCKED.has(scheme) ? null : scheme
  } catch { return null }
}

/** Перехват ссылки/редиректа: запрос остаётся у исходной страницы, пустую вкладку не создаём. */
export function requestExternal(wc: WebContents, url: string): boolean {
  const scheme = externalScheme(url)
  if (!scheme) return BLOCKED.has(url.split(':', 1)[0].toLowerCase() + ':')
  if (!notify || wc.isDestroyed()) return true
  const origin = wc.mainFrame.origin
  if (!/^(https?:\/\/|file:\/\/)/.test(origin)) return true
  if ([...pending.values()].some((p) => p.wc === wc)) return true
  const id = 'external-' + randomUUID()
  const close = (): void => {
    pending.delete(id)
    wc.removeListener('did-start-navigation', navigate)
    wc.removeListener('destroyed', close)
    notify('permission-dismiss', id)
  }
  const navigate = (e: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
    if (e.isMainFrame && !e.isSameDocument && externalScheme(e.url) !== scheme) close()
  }
  pending.set(id, { wc, url, origin, close })
  wc.on('did-start-navigation', navigate)
  wc.once('destroyed', close)
  let name = scheme.slice(0, -1)
  try { name = app.getApplicationNameForProtocol(url) || name } catch { /* Обработчик может быть не установлен. */ }
  const prompt: PermissionPrompt = {
    id, wcId: wc.id, origin, kind: 'external',
    text: `хочет открыть приложение «${name}»`, externalUrl: url
  }
  notify('permission', prompt)
  return true
}

export function answerExternal(id: string, allow: boolean): boolean {
  const p = pending.get(id)
  if (!p) return false
  p.close()
  if (allow && !p.wc.isDestroyed() && p.wc.mainFrame.origin === p.origin) {
    void shell.openExternal(p.url).catch(() => {
      if (p.wc.isDestroyed() || p.wc.mainFrame.origin !== p.origin) return
      notify('permission', {
        id: 'external-error-' + randomUUID(), origin: p.origin, kind: 'external', wcId: p.wc.id,
        text: 'не смог открыть приложение. Проверьте, что оно установлено.'
      } satisfies PermissionPrompt)
    })
  }
  return true
}

export function watchExternalProtocols(wc: WebContents): void {
  wc.on('will-frame-navigate', (e) => { if (requestExternal(wc, e.url)) e.preventDefault() })
  wc.on('will-redirect', (e, url) => { if (requestExternal(wc, url)) e.preventDefault() })
}
