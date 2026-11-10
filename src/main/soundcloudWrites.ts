import { BrowserWindow, type WebContents } from 'electron'

const PAGE_URL = 'https://soundcloud.com/'
const LOAD_TIMEOUT_MS = 25_000
const SETTLE_MS = 1_500
const REQUEST_TIMEOUT_MS = 25_000

type Write = { url: string; method: string; token: string }
type Result = { status: number; body: string }
type Client = {
  from: WebContents
  window: BrowserWindow | null
  ready: Promise<void> | null
  queue: Promise<void>
  generation: number
  challenge: { url: string; generation: number } | null
  destroyed: () => void
  navigated: (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => void
}

function challengeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (url.hostname === 'captcha-delivery.com' || url.hostname.endsWith('.captcha-delivery.com')) ? url.href : null
  } catch {
    return null
  }
}

function validateWrite(value: unknown): Write {
  const args = value as Partial<Write> | null
  const url = new URL(String(args?.url ?? ''))
  const method = String(args?.method ?? '')
  const like = /^\/users\/\d+\/track_likes\/\d+$/.test(url.pathname) && ['PUT', 'DELETE'].includes(method)
  const follow = /^\/me\/followings\/\d+$/.test(url.pathname) && ['POST', 'DELETE'].includes(method)
  if (url.origin !== 'https://api-v2.soundcloud.com' || url.username || url.password || url.hash || !(like || follow)) {
    throw new Error('Этот запрос SoundCloud не разрешён')
  }
  const token = String(args?.token ?? '')
  if (!token || token.length > 4096 || /[\r\n]/.test(token)) throw new Error('Нет сессии SoundCloud')
  return { url: url.href, method, token }
}

function timeout<T>(task: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    task,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ]).finally(() => clearTimeout(timer))
}

// Эта функция сериализуется в мир страницы: никаких ссылок на окружение главного процесса.
async function pageRequest({ url, method, token, expiresAt }: Write & { expiresAt: number }): Promise<Result> {
  if (location.origin !== 'https://soundcloud.com') throw new Error('Страница SoundCloud изменилась')
  const headers: Record<string, string> = {
    Authorization: `OAuth ${token}`,
    Accept: 'application/json, text/javascript, */*; q=0.1'
  }
  const cookie = document.cookie.match(/(?:^|;\s*)datadome=([^;]+)/)
  if (cookie) headers['X-Datadome-ClientId'] = decodeURIComponent(cookie[1])
  const remaining = expiresAt - Date.now()
  if (remaining <= 0) throw new Error('Запрос SoundCloud устарел: повтори действие')
  try {
    const response = await fetch(url, { method, headers, credentials: 'include', signal: AbortSignal.timeout(Math.min(20_000, remaining)) })
    return { status: response.status, body: await response.text() }
  } catch (error) {
    // Тег DataDome иногда прерывает fetch, уже показав проверку в своём iframe.
    for (const frame of document.querySelectorAll<HTMLIFrameElement>('iframe[src]')) {
      try {
        const candidate = new URL(frame.src)
        if (candidate.protocol === 'https:' && !candidate.username && !candidate.password && !candidate.port &&
          (candidate.hostname === 'captcha-delivery.com' || candidate.hostname.endsWith('.captcha-delivery.com'))) {
          return { status: 403, body: JSON.stringify({ url: candidate.href }) }
        }
      } catch { /* Это не ссылка проверки. */ }
    }
    throw error
  }
}

function pageChallenge(url: string): void {
  if (location.origin !== 'https://soundcloud.com') throw new Error('Страница SoundCloud изменилась')
  if ([...document.querySelectorAll<HTMLIFrameElement>('iframe[src]')].some((frame) => frame.src === url)) return
  document.getElementById('youcloud-soundcloud-challenge')?.remove()
  const host = document.createElement('div')
  host.id = 'youcloud-soundcloud-challenge'
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#fff;display:flex;flex-direction:column'
  const close = document.createElement('button')
  close.textContent = 'Закрыть проверку SoundCloud'
  close.style.cssText = 'height:52px;padding:12px 24px;border:0;background:#f2f2f2;color:#222;font:600 16px system-ui;cursor:pointer'
  const frame = document.createElement('iframe')
  frame.title = 'Проверка SoundCloud'
  frame.src = url
  frame.style.cssText = 'width:100%;flex:1;border:0'
  const origin = new URL(url).origin
  const cleanup = (): void => { host.remove(); removeEventListener('message', solved) }
  const solved = (event: MessageEvent): void => {
    if (event.origin !== origin || event.source !== frame.contentWindow) return
    let data: unknown = event.data
    try { if (typeof data === 'string') data = JSON.parse(data) } catch { return }
    const cookie = (data as { cookie?: unknown } | null)?.cookie
    if (typeof cookie !== 'string' || cookie.length > 4096 || /[\r\n]/.test(cookie) || !/^datadome=[^;]+(?:;|$)/.test(cookie)) return
    const domain = /;\s*domain=([^;]+)/i.exec(cookie)?.[1]?.toLowerCase()
    if (domain && domain !== 'soundcloud.com' && domain !== '.soundcloud.com') return
    // Cookie остаётся у SoundCloud; сайт YouCloud и его скрипты его не получают.
    document.cookie = cookie
    cleanup()
  }
  addEventListener('message', solved)
  close.onclick = cleanup
  host.append(close, frame)
  document.documentElement.append(host)
  close.focus()
}

/** Лайки и подписки идут тем же движком и с теми же cookie, где слушатель проходит капчу. */
export class SoundCloudPageWrites {
  private readonly clients = new Map<number, Client>()
  private disposed = false

  constructor(private readonly partition: string) {}

  private client(from: WebContents): Client {
    if (this.disposed || from.isDestroyed()) throw new Error('Вкладка YouCloud закрыта')
    const known = this.clients.get(from.id)
    if (known) return known
    const destroyed = (): void => this.release(from.id)
    // WebContents переживает перезагрузку и уход с YouCloud. Очередь и проверка
    // относятся к вызвавшему их документу, а не к следующей странице вкладки.
    const navigated = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
      if (event.isMainFrame && !event.isSameDocument) this.release(from.id)
    }
    const client: Client = { from, window: null, ready: null, queue: Promise.resolve(), generation: 0, challenge: null, destroyed, navigated }
    this.clients.set(from.id, client)
    from.once('destroyed', destroyed)
    from.on('did-start-navigation', navigated)
    return client
  }

  private release(id: number): void {
    const client = this.clients.get(id)
    if (!client) return
    this.clients.delete(id)
    client.from.removeListener('destroyed', client.destroyed)
    client.from.removeListener('did-start-navigation', client.navigated)
    client.challenge = null
    client.generation++
    if (client.window && !client.window.isDestroyed()) client.window.destroy()
    client.window = null
    client.ready = null
  }

  private enqueue<T>(client: Client, task: () => Promise<T>): Promise<T> {
    const result = client.queue.catch(() => undefined).then(() => {
      if (this.disposed || client.from.isDestroyed() || this.clients.get(client.from.id) !== client) throw new Error('Вкладка YouCloud закрыта')
      return task()
    })
    client.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async page(client: Client): Promise<BrowserWindow> {
    const known = client.window
    if (known && !known.isDestroyed()) {
      if (new URL(known.webContents.getURL() || PAGE_URL).origin === 'https://soundcloud.com') {
        await client.ready
        return known
      }
      known.destroy()
    }
    const window = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      width: 1000,
      height: 760,
      title: 'Проверка SoundCloud — Masaki',
      autoHideMenuBar: true,
      webPreferences: { partition: this.partition, sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false }
    })
    client.window = window
    client.challenge = null
    const contents = window.webContents
    contents.setAudioMuted(true)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.on('page-title-updated', (event) => event.preventDefault())
    const changed = (): void => { client.generation++; client.challenge = null }
    contents.on('did-start-navigation', (event) => { if (event.isMainFrame) changed() })
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => { if (isMainFrame) changed() })
    contents.on('will-navigate', (event, url) => {
      try { if (new URL(url).origin === 'https://soundcloud.com') return } catch { /* Неверный адрес. */ }
      event.preventDefault()
      changed()
    })
    window.once('closed', () => {
      if (client.window !== window) return
      client.window = null
      client.ready = null
      changed()
    })
    client.ready = timeout(window.loadURL(PAGE_URL).then(() => new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS))), LOAD_TIMEOUT_MS, 'Страница SoundCloud не загрузилась')
    try {
      await client.ready
      if (window.isDestroyed() || client.window !== window || new URL(contents.getURL()).origin !== 'https://soundcloud.com') throw new Error('Страница SoundCloud изменилась')
      return window
    } catch (error) {
      if (!window.isDestroyed()) window.destroy()
      throw error
    }
  }

  async request(from: WebContents, args: unknown): Promise<{ value: Result }> {
    const write = validateWrite(args)
    // The site's bridge gives up after 55s, including queue/page load. Never send a
    // delayed mutation after that caller has already reported the action as failed.
    const expiresAt = Date.now() + 50_000
    const client = this.client(from)
    return this.enqueue(client, async () => {
      if (Date.now() >= expiresAt) throw new Error('Запрос SoundCloud устарел: повтори действие')
      const window = await this.page(client)
      const generation = client.generation
      const response = await timeout(window.webContents.executeJavaScript(`(${pageRequest.toString()})(${JSON.stringify({ ...write, expiresAt })})`, true) as Promise<Result>, REQUEST_TIMEOUT_MS, 'SoundCloud не ответил')
      if (window.isDestroyed() || client.window !== window || client.generation !== generation) throw new Error('Страница SoundCloud изменилась: повтори действие')
      if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599 || typeof response.body !== 'string') throw new Error('SoundCloud не ответил')
      client.challenge = null
      if (response.status === 403) {
        try {
          const url = challengeUrl(JSON.parse(response.body).url)
          if (url) client.challenge = { url, generation }
        } catch { /* Ответ не содержит ссылки проверки. */ }
      } else if (response.status >= 200 && response.status < 300) {
        // После ручной проверки пользователь вернулся в YouCloud и повторил действие.
        window.hide()
      }
      return { value: response }
    })
  }

  async showChallenge(from: WebContents, args: unknown): Promise<{ value: true }> {
    const url = challengeUrl((args as { url?: unknown } | null)?.url)
    const client = this.clients.get(from.id)
    if (!url || !client) throw new Error('Проверка SoundCloud устарела: повтори действие')
    return this.enqueue(client, async () => {
      const window = client.window
      if (!window || window.isDestroyed() || client.challenge?.url !== url || client.challenge.generation !== client.generation ||
        new URL(window.webContents.getURL()).origin !== 'https://soundcloud.com') throw new Error('Проверка SoundCloud устарела: повтори действие')
      const generation = client.generation
      await window.webContents.executeJavaScript(`(${pageChallenge.toString()})(${JSON.stringify(url)})`, true)
      if (window.isDestroyed() || client.generation !== generation) throw new Error('Проверка SoundCloud устарела: повтори действие')
      const test = !!process.env.MASAKI_PROFILE
      if (!(test && process.env.MASAKI_TEST_HEADLESS !== '0')) {
        window.setSkipTaskbar(false)
        if (test && process.env.MASAKI_TEST_INACTIVE) window.showInactive()
        else window.show()
      }
      return { value: true as const }
    })
  }

  dispose(): void {
    this.disposed = true
    for (const id of this.clients.keys()) this.release(id)
  }
}
