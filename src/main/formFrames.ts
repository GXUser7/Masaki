import { ipcMain, type WebContents, type WebFrameMain } from 'electron'
import { randomUUID } from 'crypto'
import type { AutofillRequest } from '../shared/types'

const contexts = new Map<number, { token: string; frame: WebFrameMain; origin: string; request: AutofillRequest }>()
const watched = new WeakSet<WebContents>()

/** Токен относится к конкретному документу: навигация любого фрейма снимает старое предложение. */
export function formTarget(wc: WebContents, token: unknown): WebFrameMain | null {
  const c = contexts.get(wc.id)
  try {
    return c && typeof token === 'string' && c.token === token && !c.frame.detached && c.frame.origin === c.origin ? c.frame : null
  } catch { return null }
}

export function initFormFrames(): void {
  ipcMain.handle('form:register', (e, request: AutofillRequest) => {
    if (e.sender.getType() !== 'webview' || !e.senderFrame || !/^https?:/.test(e.senderFrame.origin)) return null
    if (!request || !Array.isArray(request.items) || request.items.length > 64) return null
    const token = randomUUID()
    contexts.set(e.sender.id, { token, frame: e.senderFrame, origin: e.senderFrame.origin, request })
    if (!watched.has(e.sender)) {
      watched.add(e.sender)
      e.sender.on('did-start-navigation', (event) => { if (!event.isSameDocument) contexts.delete(e.sender.id) })
      e.sender.once('destroyed', () => contexts.delete(e.sender.id))
    }
    return token
  })
  ipcMain.handle('form:project', (e, token: unknown, rect: AutofillRequest['rect'], dpr: number) => {
    if (e.senderFrame !== e.sender.mainFrame || !formTarget(e.sender, token)) return null
    if (!rect || ![rect.x, rect.y, rect.w, rect.h, dpr].every(Number.isFinite) || rect.w <= 0 || rect.h <= 0 || dpr <= 0) return null
    return { ...contexts.get(e.sender.id)!.request, rect, dpr, frameToken: token }
  })
}
