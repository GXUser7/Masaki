// YouCloud — музыкальный сайт пользователя (SoundCloud, Яндекс Музыка, YouTube Music) — встроен в
// Masaki. В Chrome сайту нужно расширение: оно ходит в Яндекс и YouTube с IP слушателя (адреса
// Cloudflare эти сервисы не обслуживают) и ставит заголовки, которые страница сама поставить не
// может. В Electron такое расширение не работает — нет declarativeNetRequest и cookies, — поэтому
// Masaki говорит с сайтом тем же языком сам: скрипт вкладки (preload/guest.ts) — половина
// «страницы», этот модуль — половина «фона». Сайт видит «расширение» и ничего не просит ставить.
//
// Отвечаем только вкладкам YouCloud (по фрейму, не со слов страницы) и ходим только к хостам
// сервисов. Куки YouTube и токены не попадают на страницу: запрос подписывает главный процесс.

import { ipcMain, session, webContents, type WebContents } from 'electron'
import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import * as ytdlp from './ytdlp'

export const YOUCLOUD_URL = 'https://youcloud.inkerror67.workers.dev/'
/** Сайт и его дев-сервер — вкладки, которым отвечает мост. */
export const YOUCLOUD_ORIGINS = ['https://youcloud.inkerror67.workers.dev', 'http://localhost:5190']
/** Какой версии расширения YouCloud равен мост (сайт сверяет, что он умеет): 0.7 — звук YouTube от yt-dlp,
 *  0.8 — и прямых трансляций (их плейлист HLS). */
const BRIDGE_VERSION = '0.8.0'

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
/** Адреса, у которых главный процесс правит заголовки (onBeforeSendHeaders сессии вкладок). */
export const YOUCLOUD_HEADER_URLS = ['https://*.yandex.net/*', 'https://music.youtube.com/*', 'https://www.youtube.com/*', 'https://youtubei.googleapis.com/*']

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
const pending = new Map<string, Ops>()
let seq = 0

/** Вызывается из единственного onBeforeSendHeaders сессии; null — запрос не наш. */
export function overrideHeaders(url: string, headers: Record<string, string>): Record<string, string> | null {
  const id = /[?&]ycr=(\d+)/.exec(url)?.[1]
  const ops = id ? pending.get(id) : undefined
  if (!ops) return null
  for (const [name, value] of Object.entries(ops)) {
    for (const k of Object.keys(headers)) if (k.toLowerCase() === name) delete headers[k]
    if (value != null) headers[name] = value
  }
  return headers
}

const allowedHost = (h: string): boolean => ALLOWED.some((d) => h === d || h.endsWith('.' + d))
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

async function relay(req: FetchRequest): Promise<Answer> {
  let url: URL
  try {
    url = new URL(String(req.url))
  } catch {
    return { error: 'bad url' }
  }
  if (url.protocol !== 'https:' || !allowedHost(url.hostname)) return { error: `host not allowed: ${url.hostname}` }
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
  for (const [k, v] of Object.entries(req.headers ?? {})) if (typeof v === 'string') headers[k] = v
  const ops: Ops = { ...profileOf(url.hostname) }
  for (const [k, v] of Object.entries(req.overrides ?? {})) if (v === null || typeof v === 'string') ops[k.toLowerCase()] = v

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

  const id = String(++seq % 1_000_000)
  url.searchParams.set('ycr', id)
  pending.set(id, ops)
  try {
    const res = await ses().fetch(url.href, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : (req.body ?? undefined),
      credentials: 'omit',
      signal: AbortSignal.timeout(45_000)
    })
    return { status: res.status, statusText: res.statusText, headers: [...res.headers], body: await res.text() }
  } catch (e) {
    return { error: String((e as Error)?.message ?? e) }
  } finally {
    pending.delete(id)
  }
}

// ---------- Входы ----------

type TokenKind = 'sc-token' | 'ya-token'
/** Токен, который поймал вход, пока вкладки YouCloud не было: отдаём при её «ping». */
const waitingTokens: { kind: TokenKind; token: string; expiresIn?: number }[] = []
const logins: Partial<Record<'sc' | 'ya' | 'yt', { at: number; url: string; wcId?: number; from?: number }>> = {}

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
function finishLogin(service: 'sc' | 'ya' | 'yt'): void {
  const login = logins[service]
  delete logins[service]
  if (login?.wcId != null) host.closeTab(login.wcId, login.from)
}

function openLogin(service: 'sc' | 'ya' | 'yt', url: string, from: WebContents): void {
  logins[service] = { at: Date.now(), url, from: from.id }
  host.openUrl(url)
}

const fresh = (service: 'sc' | 'ya' | 'yt'): boolean => {
  const l = logins[service]
  return !!l && Date.now() - l.at < LOGIN_WINDOW_MS
}

/** Каждая вкладка-webview: узнаём вкладку входа и ловим токен Яндекса в её адресе. */
export function watchWebview(contents: WebContents): void {
  const seen = (url: string): void => {
    for (const service of ['sc', 'ya', 'yt'] as const) {
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

function watchCookies(): void {
  ses().cookies.on('changed', (_e, c, _cause, removed) => {
    if (removed) return
    const domain = c.domain ?? ''
    // SoundCloud после входа кладёт сессию в cookie oauth_token.
    if (c.name === 'oauth_token' && /(^|\.)soundcloud\.com$/.test(domain.replace(/^\./, '')) && fresh('sc')) {
      handOver('sc-token', decodeURIComponent(c.value))
      finishLogin('sc')
    }
    // Вошли в Google: YouTube у сайта теперь «вошедший» — пусть перепроверит.
    if (c.name === 'SAPISID' && /youtube\.com$/.test(domain)) {
      for (const wc of youcloudTabs()) wc.send('yc:event', { kind: 'session', service: 'yt' })
      if (fresh('yt')) setTimeout(() => finishLogin('yt'), 1500)
    }
  })
}

async function call(name: string, from: WebContents): Promise<Answer> {
  switch (name) {
    case 'sc-token': {
      const value = await cookie('https://soundcloud.com/', 'oauth_token')
      return { value: value ? decodeURIComponent(value) : null }
    }
    case 'sc-login':
      openLogin('sc', SOUNDCLOUD_LOGIN, from)
      return { value: true }
    case 'ya-login':
      openLogin('ya', YANDEX_LOGIN, from)
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
  watchCookies()
  ipcMain.handle('yc:hello', (e) => {
    if (!fromYouCloud(e)) return null
    // Открыли YouCloud — yt-dlp скачивается заранее, чтобы первый трек YouTube не ждал.
    ytdlp.prepare()
    return { version: BRIDGE_VERSION, tokens: waitingTokens.splice(0) }
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
  ipcMain.handle('yc:fetch', (e, req: FetchRequest) => (fromYouCloud(e) && req && typeof req === 'object' ? relay(req) : { error: 'not allowed' }))
  ipcMain.handle('yc:call', (e, name: string) =>
    fromYouCloud(e) ? call(String(name), e.sender).catch((err) => ({ error: String(err?.message ?? err) })) : { error: 'not allowed' }
  )
}
