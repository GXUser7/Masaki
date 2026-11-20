// YouCloud — музыкальный сайт пользователя (SoundCloud, Яндекс Музыка, YouTube Music) — встроен в
// Masaki. В Chrome сайту нужно расширение: оно ходит в Яндекс и YouTube с IP слушателя (адреса
// Cloudflare эти сервисы не обслуживают) и ставит заголовки, которые страница сама поставить не
// может. В Electron такое расширение не работает — нет declarativeNetRequest и cookies, — поэтому
// Masaki говорит с сайтом тем же языком сам: скрипт вкладки (preload/guest.ts) — половина
// «страницы», этот модуль — половина «фона». Сайт видит «расширение» и ничего не просит ставить.
//
// Отвечаем только вкладкам YouCloud (по фрейму, не со слов страницы) и ходим только к хостам
// сервисов. Куки YouTube и токены не попадают на страницу: запрос подписывает главный процесс.

import { app, BrowserWindow, ipcMain, session, webContents, type WebContents } from 'electron'
import { createHash, randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import * as ytdlp from './ytdlp'
import { SoundCloudPageWrites } from './soundcloudWrites'

export const YOUCLOUD_URL = 'https://youcloud.inkerror67.workers.dev/'
/** Сайт и его дев-сервер — вкладки, которым отвечает мост. */
export const YOUCLOUD_ORIGINS = ['https://youcloud.inkerror67.workers.dev', 'http://localhost:5190']
/** Какой версии расширения YouCloud равен мост (сайт сверяет, что он умеет): 0.7 — звук YouTube от yt-dlp,
 *  0.8 — и прямых трансляций (их плейлист HLS), 0.9 — продлевает истёкшую сессию SoundCloud,
 *  0.10 — чтение звука YouTube, 0.11 — лайки и проверка SoundCloud, 0.12 — Spotify. */
const BRIDGE_VERSION = '0.12.0'
const BRIDGE_CAPABILITIES = ['sc-page-writes', 'sp-login']
let soundCloudPages: SoundCloudPageWrites

type Ops = Record<string, string | null>

/** Как каждый сервис ждёт запрос — как у расширения и Worker'а YouCloud. */
const PROFILES: { domains: string[]; headers: Ops }[] = [
  // Яндекс не отвечает запросам с чужим Origin, Android-клиент его не шлёт.
  { domains: ['yandex.net'], headers: { origin: null, referer: null, 'user-agent': 'Yandex-Music-API' } },
  { domains: ['music.youtube.com'], headers: { origin: 'https://music.youtube.com', referer: 'https://music.youtube.com/' } },
  { domains: ['www.youtube.com', 'youtubei.googleapis.com'], headers: { origin: 'https://www.youtube.com', referer: 'https://www.youtube.com/' } }
]
/** Откуда идут плейлист и куски прямой трансляции YouTube: только чтение, как есть (hls.js на странице). */
const MEDIA = ['googlevideo.com']
const ALLOWED = [...PROFILES.flatMap((p) => p.domains), ...MEDIA]
const YOUTUBE_HOSTS = ['music.youtube.com', 'www.youtube.com', 'youtubei.googleapis.com']
const SPOTIFY_SITE = 'https://open.spotify.com/'
const SPOTIFY_ORIGIN = new URL(SPOTIFY_SITE).origin
const SPOTIFY_LOGIN = 'https://accounts.spotify.com/login?continue=https%3A%2F%2Fopen.spotify.com%2F'
const SPOTIFY_API = ['api-partner.spotify.com', 'spclient.wg.spotify.com', 'api.spotify.com']
const SPOTIFY_HOSTS = ['open.spotify.com', 'open.spotifycdn.com', 'clienttoken.spotify.com', ...SPOTIFY_API]
const SPOTIFY_PROFILE = { origin: SPOTIFY_ORIGIN, referer: SPOTIFY_SITE }
/** Адреса, у которых главный процесс правит заголовки (onBeforeSendHeaders сессии вкладок). */
export const YOUCLOUD_HEADER_URLS = ['https://*.yandex.net/*', 'https://music.youtube.com/*', 'https://www.youtube.com/*', 'https://youtubei.googleapis.com/*', ...SPOTIFY_HOSTS.map((host) => `https://${host}/*`)]
/** API SoundCloud: в запросах soundcloud.com к нему — его текущий токен (Authorization: OAuth …). */
export const SOUNDCLOUD_API_URLS = ['https://api-v2.soundcloud.com/*']

// Яндекс Музыка: client_id Android-клиента; вход приходит на music.yandex.ru с токеном в адресе.
const YANDEX_LOGIN = 'https://oauth.yandex.ru/authorize?response_type=token&client_id=23cabbbdc6cd418abb4b39c32c41195d'
const SOUNDCLOUD_LOGIN = 'https://soundcloud.com/signin'
const YOUTUBE_LOGIN = 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F'
const LOGIN_WINDOW_MS = 15 * 60_000

let partition = ''
const ses = (): Electron.Session => session.fromPartition(partition)

interface Host {
  /** Открыть адрес вкладкой Masaki. */
  openUrl: (url: string) => void
  /** Закрыть вкладку с этим webContents и вернуться во вкладку YouCloud. */
  closeTab: (wcId: number, then?: number) => void
}
let host: Host

// ---------- Заголовки ----------

/** Заголовки для запросов моста: метка ycr=<id> в адресе — свои правила на один запрос. */
const pending = new Map<string, { url: string; ops: Ops }>()

/** Вызывается из единственного onBeforeSendHeaders сессии; null — запрос не наш. */
export function overrideHeaders(url: string, headers: Record<string, string>): Record<string, string> | null {
  const id = /[?&]ycr=([a-f0-9-]{36})(?:&|$)/.exec(url)?.[1]
  const entry = id ? pending.get(id) : undefined
  if (entry?.url !== url) return null
  const { ops } = entry
  for (const [name, value] of Object.entries(ops)) {
    for (const k of Object.keys(headers)) if (k.toLowerCase() === name) delete headers[k]
    if (value != null) headers[name] = value
  }
  return headers
}

// ---------- Звук YouTube для волны плеера ----------

/** Откуда <audio> сайта берёт звук YouTube — для onHeadersReceived сессии вкладок. */
export const YOUCLOUD_MEDIA_URLS = ['https://*.googlevideo.com/*']

/**
 * Звук YouTube в <audio> вкладки YouCloud: сайт спрашивает его в CORS, чтобы волна полноэкранного
 * плеера его слышала, а googlevideo так отвечает только YouTube. В ответ добавляется разрешение
 * читать звук — сам запрос и всё остальное в ответе как были. Как правило READ_MEDIA у расширения.
 * Вызывается из единственного onHeadersReceived сессии; null — ответ не наш.
 */
export function readableMedia(details: Electron.OnHeadersReceivedListenerDetails): Record<string, string[]> | null {
  if (details.resourceType !== 'media') return null
  let mediaHost: string
  let page: string
  try {
    mediaHost = new URL(details.url).hostname
    page = new URL(details.webContents?.getURL() ?? '').origin
  } catch {
    return null
  }
  if (!MEDIA.some((d) => mediaHost === d || mediaHost.endsWith('.' + d)) || !YOUCLOUD_ORIGINS.includes(page)) return null
  const headers = { ...(details.responseHeaders ?? {}) }
  for (const name of Object.keys(headers)) if (name.toLowerCase() === 'access-control-allow-origin') delete headers[name]
  headers['Access-Control-Allow-Origin'] = ['*']
  return headers
}

const allowedHost = (h: string): boolean => SPOTIFY_HOSTS.includes(h) || ALLOWED.some((d) => h === d || h.endsWith('.' + d))
const profileOf = (h: string): Ops => PROFILES.find((p) => p.domains.some((d) => h === d || h.endsWith('.' + d)))?.headers ?? {}

// ---------- Сессия YouTube ----------

async function cookie(url: string, name: string): Promise<string | null> {
  return (await ses().cookies.get({ url, name }))[0]?.value ?? null
}

async function youtubeSapisid(): Promise<string | null> {
  return (await cookie('https://www.youtube.com/', 'SAPISID')) ?? (await cookie('https://www.youtube.com/', '__Secure-3PAPISID'))
}

/** Authorization, которым подписывают запросы веб-клиенты Google: SHA-1 от времени, куки и origin. */
async function sapisidAuthorization(origin: string, full: boolean): Promise<string> {
  const ts = Math.floor(Date.now() / 1000)
  const schemes = [
    ['SAPISIDHASH', 'SAPISID'],
    ['SAPISID1PHASH', '__Secure-1PAPISID'],
    ['SAPISID3PHASH', '__Secure-3PAPISID']
  ]
  const parts: string[] = []
  for (const [scheme, name] of full ? schemes : schemes.slice(0, 1)) {
    const value = await cookie('https://www.youtube.com/', name)
    if (value) parts.push(`${scheme} ${ts}_${createHash('sha1').update(`${ts} ${value} ${origin}`).digest('hex')}`)
  }
  return parts.join(' ')
}

/** Куки, которые вкладка отправила бы по этому адресу (вместе с httpOnly — их видит только main). */
async function cookieHeader(url: URL): Promise<string> {
  const list = await ses().cookies.get({ url: url.origin + url.pathname })
  return list.map((c) => `${c.name}=${c.value}`).join('; ')
}

// ---------- Запрос от сайта ----------

interface FetchRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  overrides?: Ops
  session?: boolean | string
  /** Ответ — байты (куски трансляции): в body base64. */
  binary?: boolean
}

interface Answer {
  status?: number
  statusText?: string
  headers?: [string, string][]
  body?: string
  /** body — base64 байтов ответа. */
  base64?: boolean
  value?: unknown
  error?: string
}

async function relay(req: FetchRequest, from: WebContents, redirectsLeft = 3): Promise<Answer> {
  let url: URL
  try {
    url = new URL(String(req.url))
  } catch {
    return { error: 'bad url' }
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !allowedHost(url.hostname)) {
    return { error: `host not allowed: ${url.hostname}` }
  }
  const spotify = SPOTIFY_HOSTS.includes(url.hostname)
  const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET'
  // Плейлист и куски трансляции: браузеру их не взять самому — googlevideo через границу сайтов отвечает
  // только страницам YouTube, а свой HLS Chromium не берёт куски с другого хоста, чем плейлист, без CORS.
  if (MEDIA.some((d) => url.hostname.endsWith('.' + d))) {
    if (method !== 'GET') return { error: 'only GET' }
    try {
      const range = typeof req.headers?.range === 'string' ? { range: req.headers.range } : undefined
      const res = await ses().fetch(url.href, { headers: range, credentials: 'omit', signal: AbortSignal.timeout(45_000) })
      const body = req.binary ? Buffer.from(await res.arrayBuffer()).toString('base64') : await res.text()
      return { status: res.status, statusText: res.statusText, headers: [...res.headers], body, base64: !!req.binary }
    } catch (e) {
      return { error: String((e as Error)?.message ?? e) }
    }
  }
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers ?? {})) if (typeof v === 'string') headers[k.toLowerCase()] = v
  const ops: Ops = { ...(spotify ? SPOTIFY_PROFILE : profileOf(url.hostname)) }
  if (spotify) {
    const requestedToken = headers.authorization?.match(/^Bearer (masaki-sp-[a-f0-9-]+)$/)?.[1]
    if (requestedToken) {
      const entry = spotifySessions.get(from.id)
      if (!SPOTIFY_API.includes(url.hostname) || entry?.handle !== requestedToken || entry.expiresAt <= Date.now()) {
        return { status: 401, body: '{"error":"Spotify session expired"}' }
      }
      headers.authorization = `Bearer ${entry.token}`
      headers['client-token'] = entry.clientToken
    } else if (!SPOTIFY_API.includes(url.hostname)) {
      delete headers.authorization
      delete headers['client-token']
    }
    delete headers.cookie
    // При ручном вводе на сайте пользователь может передать только собственную cookie и только
    // конечной точке входа Spotify. Для встроенного входа эту cookie не передаём даже сайту.
    const suppliedCookie = req.overrides?.cookie
    if (url.origin === SPOTIFY_ORIGIN && url.pathname === '/api/token' &&
        typeof suppliedCookie === 'string' && /^sp_dc=[^;\r\n]{1,4096}$/.test(suppliedCookie)) {
      ops.cookie = suppliedCookie
    }
  } else {
    for (const [k, v] of Object.entries(req.overrides ?? {})) if (v === null || typeof v === 'string') ops[k.toLowerCase()] = v
  }

  // YouTube как этот браузер в него вошёл: куки вкладок и подпись SAPISIDHASH.
  if (req.session && YOUTUBE_HOSTS.includes(url.hostname)) {
    const mode = typeof req.session === 'string' ? req.session : 'dnr3'
    if (await youtubeSapisid()) {
      const origin = url.hostname === 'music.youtube.com' ? 'https://music.youtube.com' : 'https://www.youtube.com'
      if (method !== 'GET') {
        headers['authorization'] = await sapisidAuthorization(origin, !mode.endsWith('1'))
        headers['x-goog-authuser'] = '0'
        headers['x-origin'] = origin
      }
      const jar = await cookieHeader(url)
      if (jar) ops.cookie = jar
    }
  }

  const id = randomUUID()
  url.hash = ''
  url.searchParams.set('ycr', id)
  pending.set(id, { url: url.href, ops })
  try {
    const res = await ses().fetch(url.href, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : (req.body ?? undefined),
      credentials: 'omit',
      redirect: spotify ? 'manual' : 'follow',
      signal: AbortSignal.timeout(45_000)
    })
    const location = res.headers.get('location')
    if (spotify && redirectsLeft > 0 && (method === 'GET' || method === 'HEAD') &&
        !headers.authorization && !ops.cookie && res.status >= 300 && res.status < 400 && location) {
      const next = new URL(location, url)
      if (next.origin === url.origin) {
        await res.body?.cancel()
        next.searchParams.delete('ycr')
        return relay({ ...req, url: next.href }, from, redirectsLeft - 1)
      }
    }
    const responseHeaders = [...res.headers].filter(([name]) => !spotify || name !== 'set-cookie')
    return { status: res.status, statusText: res.statusText, headers: responseHeaders, body: await res.text() }
  } catch (e) {
    return { error: String((e as Error)?.message ?? e) }
  } finally {
    pending.delete(id)
  }
}

// ---------- Входы ----------

type TokenKind = 'sc-token' | 'ya-token'
type LoginService = 'sc' | 'ya' | 'yt' | 'sp'
/** Токен, который поймал вход, пока вкладки YouCloud не было: отдаём при её «ping». */
const waitingTokens: { kind: TokenKind; token: string; expiresIn?: number }[] = []
const logins: Partial<Record<LoginService, { at: number; url: string; wcId?: number; from?: number }>> = {}

function youcloudTabs(): WebContents[] {
  return webContents.getAllWebContents().filter((wc) => {
    if (wc.isDestroyed() || wc.getType() !== 'webview') return false
    try {
      return YOUCLOUD_ORIGINS.includes(new URL(wc.getURL()).origin)
    } catch {
      return false
    }
  })
}

function handOver(kind: TokenKind, token: string, expiresIn?: number): void {
  const tabs = youcloudTabs()
  if (!tabs.length) {
    waitingTokens.push({ kind, token, expiresIn })
    return
  }
  for (const wc of tabs) wc.send('yc:token', { kind, token, expiresIn })
}

/** Вкладка входа своё отработала: закрыть и вернуться туда, откуда просили войти. */
function finishLogin(service: LoginService): void {
  const login = logins[service]
  delete logins[service]
  if (login?.wcId != null) host.closeTab(login.wcId, login.from)
}

function openLogin(service: LoginService, url: string, from: WebContents): void {
  logins[service] = { at: Date.now(), url, from: from.id }
  host.openUrl(url)
}

const fresh = (service: LoginService): boolean => {
  const l = logins[service]
  return !!l && Date.now() - l.at < LOGIN_WINDOW_MS
}

/** Каждая вкладка-webview: узнаём вкладку входа и ловим токен Яндекса в её адресе. */
export function watchWebview(contents: WebContents): void {
  const seen = (url: string): void => {
    for (const service of ['sc', 'ya', 'yt', 'sp'] as const) {
      const l = logins[service]
      if (l && l.wcId == null && fresh(service) && url === l.url) l.wcId = contents.id
    }
    // Вход Яндекс ID возвращается на music.yandex.ru с #access_token=…
    if (fresh('ya') && /^https:\/\/music\.yandex\.(ru|com)\//.test(url) && url.includes('access_token=')) {
      const params = new URLSearchParams(url.slice(url.indexOf('#') + 1))
      const token = params.get('access_token')
      if (token) {
        if (logins.ya) logins.ya.wcId ??= contents.id
        handOver('ya-token', token, Number(params.get('expires_in')) || 0)
        finishLogin('ya')
      }
    }
  }
  contents.on('did-start-navigation', (e) => e.isMainFrame && seen(e.url))
  contents.on('did-navigate', (_e, url) => seen(url))
  contents.on('did-navigate-in-page', (_e, url, isMainFrame) => isMainFrame && seen(url))
  contents.on('did-redirect-navigation', (e) => e.isMainFrame && seen(e.url))
}

// ---------- Сессия SoundCloud ----------

const SOUNDCLOUD_SITE = 'https://soundcloud.com/discover'
const RENEW_TIMEOUT_MS = 25_000
let renewal: Promise<string | null> | null = null
let renewWaiter: { stale: string; done: (token: string | null) => void } | null = null

async function soundCloudCookie(): Promise<string | null> {
  const value = await cookie('https://soundcloud.com/', 'oauth_token')
  return value ? decodeURIComponent(value) : null
}

/**
 * Токен SoundCloud вместо истёкшего [stale] — как его продлевает приложение YouCloud
 * (SoundCloudSessionRefresher). Токен у сайта — собственный soundcloud.com, а тот продлевает его сам,
 * пока жива его сессия в Masaki. Сначала его cookie oauth_token; если и там тот же — soundcloud.com
 * в невидимом окне без звука: он продлит сессию, и новый токен придёт в его запросах к API (или в
 * cookie). Null — сессии нет и там, поможет только вход. Годен ли токен, сайт проверит сам.
 */
function renewSoundCloud(stale: string): Promise<string | null> {
  renewal ??= (async () => {
    const now = await soundCloudCookie()
    if (now && now !== stale) return now
    return new Promise<string | null>((resolve) => {
      const win = new BrowserWindow({
        show: false,
        skipTaskbar: true,
        width: 1280,
        height: 800,
        webPreferences: { partition, sandbox: true, backgroundThrottling: false }
      })
      win.webContents.setAudioMuted(true)
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      const waiter = {
        stale,
        done: (token: string | null): void => {
          if (renewWaiter !== waiter) return
          renewWaiter = null
          clearTimeout(timer)
          if (!win.isDestroyed()) win.destroy()
          resolve(token)
        }
      }
      renewWaiter = waiter
      const timer = setTimeout(() => waiter.done(null), RENEW_TIMEOUT_MS)
      // Невидимое окно не должно держать Masaki открытым, когда пользователь закрыл свои.
      for (const other of BrowserWindow.getAllWindows()) {
        if (other !== win) other.once('closed', () => BrowserWindow.getAllWindows().every((w) => w === win) && waiter.done(null))
      }
      win.loadURL(SOUNDCLOUD_SITE).catch(() => undefined)
    })
  })().finally(() => (renewal = null))
  return renewal
}

function renewedSoundCloud(token: string): void {
  if (renewWaiter && token && token !== renewWaiter.stale) renewWaiter.done(token)
}

/** Из onBeforeSendHeaders сессии вкладок: запрос soundcloud.com к своему API, с его токеном. */
export function noteSoundCloudRequest(headers: Record<string, string>): void {
  if (!renewWaiter) return
  const auth = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1]
  if (auth?.startsWith('OAuth ')) renewedSoundCloud(auth.slice('OAuth '.length).trim())
}

// ---------- Сессия Spotify ----------

type SpotifySession = { handle: string; token: string; clientToken: string; expiresAt: number }
const spotifySessions = new Map<number, SpotifySession>()
type SpotifyWaiter = { from: number; done: (session: SpotifySession | null) => void }
const spotifyWaiters = new Map<number, SpotifyWaiter>()
const spotifyRenewals = new Map<number, Promise<SpotifySession | null>>()

async function hasSpotifySession(): Promise<boolean> {
  return (await ses().cookies.get({ url: SPOTIFY_SITE, name: 'sp_dc' })).length > 0
}

function spotifyAnswer(entry: SpotifySession) {
  // Сайт использует поле token как идентификатор сессии. Подлинные заголовки остаются в main.
  return { token: entry.handle, clientToken: 'masaki', expiresAt: entry.expiresAt }
}

function rememberSpotify(from: WebContents, token: string, clientToken: string): SpotifySession {
  if (!spotifySessions.has(from.id)) from.once('destroyed', () => spotifySessions.delete(from.id))
  let expiresAt = Date.now() + 45 * 60_000
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number }
    if (typeof claims.exp === 'number') expiresAt = Math.min(expiresAt, claims.exp * 1000)
  } catch {
    // Токены без открытого срока всё равно обновляются после отказа Spotify.
  }
  const entry = { handle: `masaki-sp-${randomUUID()}`, token, clientToken, expiresAt }
  spotifySessions.set(from.id, entry)
  return entry
}

/** Сессию замечаем только в окне Spotify, которое открыли ради этого входа или продления. */
export function noteSpotifyRequest(details: Electron.OnBeforeSendHeadersListenerDetails): void {
  const wc = details.webContents
  if (!wc || wc.isDestroyed() || details.resourceType !== 'xhr') return
  const waiter = spotifyWaiters.get(wc.id)
  const login = logins.sp
  const loginFrom = login?.wcId === wc.id && fresh('sp') ? login.from : undefined
  const fromId = waiter?.from ?? loginFrom
  if (fromId == null || !SPOTIFY_API.includes(new URL(details.url).hostname) ||
      new URL(wc.getURL()).origin !== SPOTIFY_ORIGIN) return
  const headers = new Map(Object.entries(details.requestHeaders).map(([name, value]) => [name.toLowerCase(), value]))
  const token = headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1]
  const clientToken = headers.get('client-token')
  if (!token || !clientToken) return
  void hasSpotifySession().then((signedIn) => {
    if (!signedIn || wc.isDestroyed()) return
    if (waiter ? spotifyWaiters.get(wc.id) !== waiter : logins.sp !== login || !fresh('sp')) return
    const from = youcloudTabs().find((tab) => tab.id === fromId)
    if (!from) {
      waiter?.done(null)
      return
    }
    const entry = rememberSpotify(from, token, clientToken)
    if (waiter) waiter.done(entry)
    else {
      from.send('yc:token', { kind: 'sp-token', ...spotifyAnswer(entry) })
      finishLogin('sp')
    }
  }).catch(() => undefined)
}

function renewSpotify(from: WebContents, stale: unknown): Promise<SpotifySession | null> {
  const current = spotifySessions.get(from.id)
  if (current && current.handle !== stale && current.expiresAt > Date.now() + 60_000) return Promise.resolve(current)
  const pending = spotifyRenewals.get(from.id)
  if (pending) return pending
  const renewal = (async () => {
    if (!(await hasSpotifySession()) || from.isDestroyed()) return null
    return new Promise<SpotifySession | null>((resolve) => {
      const window = new BrowserWindow({
        show: false, skipTaskbar: true,
        webPreferences: { partition, sandbox: true, backgroundThrottling: false }
      })
      window.webContents.setAudioMuted(true)
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      const id = window.webContents.id
      const done = (entry: SpotifySession | null): void => {
        if (!spotifyWaiters.delete(id)) return
        clearTimeout(timer)
        from.removeListener('destroyed', cancel)
        if (!window.isDestroyed()) window.destroy()
        resolve(entry)
      }
      const cancel = (): void => done(null)
      const timer = setTimeout(cancel, RENEW_TIMEOUT_MS)
      spotifyWaiters.set(id, { from: from.id, done })
      from.once('destroyed', cancel)
      window.once('closed', cancel)
      window.loadURL(SPOTIFY_SITE).catch(cancel)
    })
  })().finally(() => spotifyRenewals.delete(from.id))
  spotifyRenewals.set(from.id, renewal)
  return renewal
}

function watchCookies(): void {
  ses().cookies.on('changed', (_e, c, _cause, removed) => {
    const domain = c.domain ?? ''
    if (c.name === 'sp_dc' && /(^|\.)spotify\.com$/.test(domain)) spotifySessions.clear()
    if (removed) return
    // SoundCloud после входа кладёт сессию в cookie oauth_token, туда же — продлённую.
    if (c.name === 'oauth_token' && /(^|\.)soundcloud\.com$/.test(domain.replace(/^\./, ''))) {
      renewedSoundCloud(decodeURIComponent(c.value))
      if (fresh('sc')) {
        handOver('sc-token', decodeURIComponent(c.value))
        finishLogin('sc')
      }
    }
    // Вошли в Google: YouTube у сайта теперь «вошедший» — пусть перепроверит.
    if (c.name === 'SAPISID' && /youtube\.com$/.test(domain)) {
      for (const wc of youcloudTabs()) wc.send('yc:event', { kind: 'session', service: 'yt' })
      if (fresh('yt')) setTimeout(() => finishLogin('yt'), 1500)
    }
  })
}

async function call(name: string, from: WebContents, args?: unknown): Promise<Answer> {
  switch (name) {
    case 'sc-request':
      return soundCloudPages.request(from, args)
    case 'sc-captcha':
      return soundCloudPages.showChallenge(from, args)
    case 'sc-token':
      return { value: await soundCloudCookie() }
    case 'sc-renew': {
      const stale = (args as { stale?: unknown } | undefined)?.stale
      return { value: await renewSoundCloud(typeof stale === 'string' ? stale : '') }
    }
    case 'sc-login':
      openLogin('sc', SOUNDCLOUD_LOGIN, from)
      return { value: true }
    case 'ya-login':
      openLogin('ya', YANDEX_LOGIN, from)
      return { value: true }
    case 'sp-token':
      return { value: await hasSpotifySession() }
    case 'sp-renew': {
      const entry = await renewSpotify(from, (args as { stale?: unknown } | undefined)?.stale)
      return { value: entry ? spotifyAnswer(entry) : null }
    }
    case 'sp-login':
      openLogin('sp', SPOTIFY_LOGIN, from)
      return { value: true }
    case 'yt-login':
      openLogin('yt', YOUTUBE_LOGIN, from)
      return { value: true }
    case 'yt-account':
      return { value: !!(await youtubeSapisid()) }
    case 'yt-cookies': {
      const lists = await Promise.all(['https://www.youtube.com/', 'https://music.youtube.com/'].map((url) => ses().cookies.get({ url })))
      return { value: [...new Set(lists.flat().map((c) => c.name))].sort() }
    }
  }
  return { error: `unknown call: ${name}` }
}

/** Отвечаем только главному фрейму вкладки YouCloud — сайт определяем по фрейму, не со слов страницы. */
function fromYouCloud(e: Electron.IpcMainInvokeEvent): boolean {
  if (e.sender.getType() !== 'webview' || !e.senderFrame || e.senderFrame.parent) return false
  return YOUCLOUD_ORIGINS.includes(e.senderFrame.origin)
}

// ---------- Расширение YouCloud не нужно ----------

/** Распакованное расширение YouCloud: в Masaki вместо него мост, а вдвоём они отвечали бы сайту дважды. */
export function isYouCloudExtension(dir: string): boolean {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { content_scripts?: { matches?: string[] }[] }
    return (manifest.content_scripts ?? []).some((cs) => (cs.matches ?? []).some((m) => m.includes('youcloud.inkerror67.workers.dev')))
  } catch {
    return false
  }
}

export function initYouCloud(partitionName: string, h: Host): void {
  partition = partitionName
  host = h
  soundCloudPages = new SoundCloudPageWrites(partition)
  app.once('before-quit', () => {
    soundCloudPages.dispose()
    spotifyWaiters.forEach((waiter) => waiter.done(null))
  })
  watchCookies()
  ipcMain.handle('yc:hello', (e) => {
    if (!fromYouCloud(e)) return null
    // Открыли YouCloud — yt-dlp скачивается заранее, чтобы первый трек YouTube не ждал.
    ytdlp.prepare()
    return { version: BRIDGE_VERSION, capabilities: BRIDGE_CAPABILITIES, tokens: waitingTokens.splice(0) }
  })
  // Звук YouTube: ссылку находит yt-dlp, с IP и входом этого браузера. fresh — прежняя не заиграла;
  // live — сайт знает, что это прямая трансляция.
  ipcMain.handle('yc:yt-stream', async (e, videoId: string, fresh?: boolean, live?: boolean) => {
    if (!fromYouCloud(e)) return { error: 'not allowed' }
    if (fresh) ytdlp.forget(String(videoId))
    try {
      return { value: await ytdlp.resolve(String(videoId), ses(), !!live) }
    } catch (err) {
      return { error: String((err as Error)?.message ?? err) }
    }
  })
  ipcMain.handle('yc:fetch', (e, req: FetchRequest) => (fromYouCloud(e) && req && typeof req === 'object' ? relay(req, e.sender) : { error: 'not allowed' }))
  ipcMain.handle('yc:call', (e, name: string, args?: unknown) =>
    fromYouCloud(e) ? call(String(name), e.sender, args).catch((err) => ({ error: String(err?.message ?? err) })) : { error: 'not allowed' }
  )
}
