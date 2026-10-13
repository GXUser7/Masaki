// Звук YouTube для YouCloud — как в Android-приложении YouCloud: настоящий yt-dlp. Сайт в браузере
// повторяет лишь часть его логики, и YouTube многим трекам ему отказывает («подтвердите, что вы не
// бот», поток без PO-токена обрывается на первом мегабайте). yt-dlp спрашивает YouTube правильно и
// догоняет его изменения за дни. Замер 2026-10-10: ролик, которому все клиенты сайта отказали,
// yt-dlp отдал без входа (клиент VISIONOS) и googlevideo выдал файл целиком.
//
// Скачивается при первой нужде с ночных сборок (их yt-dlp советует для YouTube), сверяется с
// SHA2-256SUMS того же выпуска, раз в сутки и после сбоя проверяет обновление. Задачи YouTube на
// JavaScript решает сам Masaki: его exe с ELECTRON_RUN_AS_NODE — это Node, отдельный не нужен.
// Сначала без входа (быстро и как у всех), при отказе — с куками входа на youtube.com этого браузера:
// файл с ними живёт только на время запуска.

import { app, net, type Session } from 'electron'
import { spawn } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import { connect as tcpConnect, type Socket } from 'net'
import path from 'path'
import { connect as tlsConnect } from 'tls'

const RELEASE = 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/'
/** Сборка yt-dlp под систему: в выпуске — файл ASSET, у нас он лежит как EXE. */
const ASSET = process.platform === 'darwin' ? 'yt-dlp_macos' : process.platform === 'linux' ? 'yt-dlp_linux' : 'yt-dlp.exe'
const EXE = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
const DAY = 24 * 60 * 60_000
const RUN_TIMEOUT = 60_000

const dir = (): string => path.join(app.getPath('userData'), 'yt-dlp')
const exePath = (): string => path.join(dir(), EXE)
const stateFile = (): string => path.join(dir(), 'state.json')

interface State {
  checkedAt: number
  sha256: string
}

function readState(): State | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as State
  } catch {
    return null
  }
}

async function text(url: string): Promise<string> {
  const res = await net.fetch(url)
  if (!res.ok) throw new Error(`GitHub ответил ${res.status}`)
  return res.text()
}

/** Скачать свежий yt-dlp, если его нет или он не совпадает с последним выпуском. */
async function update(): Promise<void> {
  fs.mkdirSync(dir(), { recursive: true })
  const sums = await text(RELEASE + 'SHA2-256SUMS')
  const want = sums.split('\n').map((l) => l.trim().split(/\s+\*?/)).find(([, name]) => name === ASSET)?.[0]
  if (!want || !/^[0-9a-f]{64}$/.test(want)) throw new Error(`в SHA2-256SUMS нет ${ASSET}`)
  const have = readState()
  if (have?.sha256 === want && fs.existsSync(exePath())) {
    fs.writeFileSync(stateFile(), JSON.stringify({ ...have, checkedAt: Date.now() }))
    return
  }
  const res = await net.fetch(RELEASE + ASSET)
  if (!res.ok) throw new Error(`GitHub ответил ${res.status}`)
  const body = Buffer.from(await res.arrayBuffer())
  const got = crypto.createHash('sha256').update(body).digest('hex')
  if (got !== want) throw new Error(`${ASSET} не совпал с контрольной суммой`)
  const part = exePath() + '.part'
  fs.writeFileSync(part, body, { mode: 0o755 })
  // Пока прежний yt-dlp работает, Windows не даст его заменить — тогда в следующий раз.
  fs.renameSync(part, exePath())
  fs.writeFileSync(stateFile(), JSON.stringify({ checkedAt: Date.now(), sha256: want } satisfies State))
}

let updating: Promise<void> | null = null
const updateOnce = (): Promise<void> => (updating ??= update().finally(() => (updating = null)))

/** Путь к yt-dlp: первый раз ждём скачивания, дальше проверка обновления идёт в фоне. */
async function ensure(): Promise<string> {
  if (!fs.existsSync(exePath())) await updateOnce()
  else if (Date.now() - (readState()?.checkedAt ?? 0) > DAY) void updateOnce().catch(() => undefined)
  return exePath()
}

/** Скачать заранее — когда открыли YouCloud, чтобы первый трек не ждал скачивания. */
export function prepare(): void {
  void ensure().catch(() => undefined)
}

// ---------- Запуск ----------

// ---------- Ретранслятор: yt-dlp ходит в YouTube через сам Masaki ----------
// googlevideo привязывает ссылку к IP того, кто её спросил, а играет её <audio> во вкладке. VPN, включённый
// только для Masaki (правило по программе в Clash, раздельное туннелирование), yt-dlp.exe не видит: тот
// спрашивал бы YouTube мимо VPN, и ссылка не играла бы с IP вкладки (жалоба пользователя 2026-10-11).
// Поэтому yt-dlp получает прокси — маленький CONNECT-сервер в главном процессе: соединения открывает
// Masaki.exe и тем же путём, что и вкладки (их прокси или напрямую). Пускает только с паролем этого
// запуска и только к YouTube и Google на порт 443 — чужие программы через него никуда не выйдут.

const ALLOWED = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|googlevideo\.com|ytimg\.com|ggpht\.com|google\.com|googleapis\.com|gstatic\.com)$/i

/** Первые байты ответа до признака конца (заголовков HTTP или ответа SOCKS). */
function readUntil(sock: Socket, done: (buf: Buffer) => boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    const onData = (d: Buffer): void => {
      buf = Buffer.concat([buf, d])
      if (done(buf)) {
        cleanup()
        resolve(buf)
      }
    }
    const onEnd = (): void => {
      cleanup()
      reject(new Error('прокси закрыл соединение'))
    }
    const cleanup = (): void => {
      sock.off('data', onData)
      sock.off('error', onEnd)
      sock.off('end', onEnd)
    }
    sock.on('data', onData)
    sock.on('error', onEnd)
    sock.on('end', onEnd)
  })
}

const opened = (sock: Socket): Promise<void> =>
  new Promise((resolve, reject) => {
    sock.once('connect', () => resolve())
    sock.once('secureConnect', () => resolve())
    sock.once('error', reject)
  })

/** Соединение с host:port тем путём, которым ходит сессия вкладок к этому адресу. */
async function upstream(ses: Session, host: string, port: number): Promise<Socket> {
  const rule = (await ses.resolveProxy(`https://${host}/`)).split(';')[0].trim()
  const m = /^(PROXY|HTTPS|SOCKS5|SOCKS4|SOCKS)\s+\[?([^\]\s]+?)\]?:(\d+)$/i.exec(rule)
  if (!m) {
    const sock = tcpConnect(port, host)
    await opened(sock)
    return sock
  }
  const kind = m[1].toUpperCase()
  const ph = m[2]
  const pp = Number(m[3])
  if (kind === 'PROXY' || kind === 'HTTPS') {
    const sock = kind === 'HTTPS' ? tlsConnect({ host: ph, port: pp, servername: ph }) : tcpConnect(pp, ph)
    await opened(sock)
    sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
    const head = (await readUntil(sock, (b) => b.includes('\r\n\r\n'))).toString('latin1')
    if (!/^HTTP\/1\.[01] 200/.test(head)) throw new Error('прокси отказал: ' + head.split('\r\n')[0])
    return sock
  }
  const sock = tcpConnect(pp, ph)
  await opened(sock)
  const name = Buffer.from(host)
  if (kind === 'SOCKS5') {
    sock.write(Buffer.from([5, 1, 0]))
    const hello = await readUntil(sock, (b) => b.length >= 2)
    if (hello[1] !== 0) throw new Error('SOCKS5 просит вход')
    sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 255])]))
    const r = await readUntil(sock, (b) => b.length >= 5 && b.length >= (b[3] === 1 ? 10 : b[3] === 4 ? 22 : 7 + b[4]))
    if (r[1] !== 0) throw new Error('SOCKS5 отказал: ' + r[1])
  } else {
    // SOCKS4a: имя адреса разрешает сам прокси.
    sock.write(Buffer.concat([Buffer.from([4, 1, port >> 8, port & 255, 0, 0, 0, 1, 0]), name, Buffer.from([0])]))
    const r = await readUntil(sock, (b) => b.length >= 8)
    if (r[1] !== 0x5a) throw new Error('SOCKS4 отказал: ' + r[1])
  }
  return sock
}

let relay: Promise<string> | null = null

/** Адрес ретранслятора для --proxy (поднимается один раз на запуск). */
function relayFor(ses: Session): Promise<string> {
  return (relay ??= new Promise((resolve, reject) => {
    const token = crypto.randomBytes(18).toString('base64url')
    const auth = 'Basic ' + Buffer.from('masaki:' + token).toString('base64')
    const server = http.createServer((_req, res) => {
      res.writeHead(405).end()
    })
    server.on('connect', async (req: http.IncomingMessage, client: Socket, head: Buffer) => {
      client.on('error', () => client.destroy())
      const [host, p] = (req.url ?? '').split(/:(?=\d+$)/)
      const port = Number(p)
      if (req.headers['proxy-authorization'] !== auth || port !== 443 || !ALLOWED.test(host ?? '')) {
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        return
      }
      try {
        const up = await upstream(ses, host, port)
        up.on('error', () => client.destroy())
        client.on('close', () => up.destroy())
        up.on('close', () => client.destroy())
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) up.write(head)
        up.pipe(client)
        client.pipe(up)
      } catch {
        client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      }
    })
    server.on('error', (e) => {
      relay = null
      reject(e)
    })
    server.listen(0, '127.0.0.1', () => {
      const a = server.address()
      if (!a || typeof a === 'string') return reject(new Error('ретранслятор не поднялся'))
      resolve(`http://masaki:${token}@127.0.0.1:${a.port}`)
    })
  }))
}

/** Куки youtube.com в формате Netscape, который читает yt-dlp; null — входа нет. */
async function cookieFile(ses: Session): Promise<string | null> {
  const list = (await ses.cookies.get({})).filter((c) => /(^|\.)youtube\.com$/.test((c.domain ?? '').replace(/^\./, '')))
  if (!list.some((c) => c.name === 'SAPISID' || c.name === '__Secure-3PAPISID')) return null
  const lines = ['# Netscape HTTP Cookie File']
  for (const c of list) {
    const domain = c.domain ?? ''
    lines.push(
      [
        (c.httpOnly ? '#HttpOnly_' : '') + domain,
        domain.startsWith('.') ? 'TRUE' : 'FALSE',
        c.path ?? '/',
        c.secure ? 'TRUE' : 'FALSE',
        String(Math.floor(c.expirationDate ?? 0)),
        c.name,
        c.value
      ].join('\t')
    )
  }
  fs.mkdirSync(path.join(dir(), 'tmp'), { recursive: true })
  const file = path.join(dir(), 'tmp', `cookies-${crypto.randomBytes(8).toString('hex')}.txt`)
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 })
  return file
}

/** Звук ролика: ссылка для <audio> и когда она истекает (мс); live — плейлист HLS прямой трансляции. */
interface Found {
  url: string
  expire: number
  live?: boolean
}

// Что спрашивать у yt-dlp. Звук ролика — файлом по HTTPS: его <audio> играет сам, манифесты HLS/DASH
// не нужны. У прямой трансляции есть только HLS: её плейлист только со звуком (itag 233, 234), иначе
// целый с приличным звуком (93: 360p и AAC 128 кбит/с), иначе самый маленький. DASH трансляции yt-dlp
// и сам пропускает без --live-from-start.
const FILE_ARGS = ['-f', 'bestaudio[protocol=https]/bestaudio', '--extractor-args', 'youtube:skip=hls,dash']
const LIVE_ARGS = ['-f', 'bestaudio[protocol^=m3u8]/234/233/93/worst[protocol^=m3u8]', '--extractor-args', 'youtube:skip=dash']

/** Трансляцию спросили как файл: её живые форматы yt-dlp пропускает, и не остаётся ни одного. */
const NO_FORMATS = /no video formats found|requested format is not available/i

/** Когда ссылка истекает, мс: из expire — у плейлиста трансляции он в пути (/expire/1760400000/), а не в запросе. */
function expiryOf(link: string): number {
  const u = new URL(link)
  const seconds = Number(u.searchParams.get('expire') ?? u.pathname.match(/\/expire\/(\d+)/)?.[1])
  return seconds > 0 ? seconds * 1000 : Date.now() + 3_600_000
}

function run(exe: string, videoId: string, proxy: string, cookies: string | null, live: boolean): Promise<Found> {
  const args = [
    '--ignore-config',
    '--no-playlist',
    '--dump-json',
    '--no-warnings',
    '--socket-timeout',
    '15',
    ...(live ? LIVE_ARGS : FILE_ARGS),
    '--js-runtimes',
    `node:${process.execPath}`,
    '--cache-dir',
    path.join(dir(), 'cache'),
    '--proxy',
    proxy,
    ...(cookies ? ['--cookies', cookies] : []),
    '--',
    `https://www.youtube.com/watch?v=${videoId}`
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    const timer = setTimeout(() => child.kill(), RUN_TIMEOUT)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      try {
        const j = JSON.parse(out) as { url?: string; is_live?: boolean }
        if (!j.url) throw new Error('без ссылки')
        resolve({ url: j.url, expire: expiryOf(j.url), live: live || !!j.is_live })
      } catch {
        // «ERROR: [youtube] id: Sign in to confirm…» — причина в последней строке ERROR.
        const line = err.split('\n').reverse().find((l) => l.startsWith('ERROR')) ?? (code === null ? 'yt-dlp не ответил за минуту' : `yt-dlp завершился с кодом ${code}`)
        reject(new Error(line.replace(/^ERROR:\s*(\[youtube\]\s*[\w-]+:\s*)?/, '').slice(0, 300)))
      }
    })
  })
}

/**
 * Сначала без входа, при отказе — с входом этого браузера. live — сайт знает, что это трансляция. Ролик,
 * у которого не нашлось файла, — трансляция, о которой сайт не знал: её спрашивают ещё раз как трансляцию,
 * и дальше уже так.
 */
async function runWith(exe: string, videoId: string, ses: Session, live: boolean): Promise<Found> {
  const proxy = await relayFor(ses)
  const attempt = async (cookies: string | null): Promise<Found> => {
    try {
      return await run(exe, videoId, proxy, cookies, live)
    } catch (e) {
      if (live || !NO_FORMATS.test((e as Error).message)) throw e
      live = true
      try {
        return await run(exe, videoId, proxy, cookies, true)
      } catch (again) {
        if (!NO_FORMATS.test((again as Error).message)) throw again
        // И не трансляция: причину говорит первый отказ.
        live = false
        throw e
      }
    }
  }
  try {
    return await attempt(null)
  } catch (anonymous) {
    const cookies = await cookieFile(ses)
    if (!cookies) throw anonymous
    try {
      return await attempt(cookies)
    } finally {
      fs.rmSync(cookies, { force: true })
    }
  }
}

const found = new Map<string, Found>()
const inflight = new Map<string, Promise<Found>>()
let lastForcedUpdate = 0

/** Ссылка на звук ролика: из запаса, пока не истекает, иначе свежая от yt-dlp. live — сайт знает, что это трансляция. */
export function resolve(videoId: string, ses: Session, live = false): Promise<Found> {
  if (!/^[\w-]{11}$/.test(videoId)) return Promise.reject(new Error('неверный id ролика'))
  const kept = found.get(videoId)
  if (kept && kept.expire - Date.now() > 10 * 60_000) return Promise.resolve(kept)
  let p = inflight.get(videoId)
  if (!p) {
    p = (async () => {
      const exe = await ensure()
      try {
        return await runWith(exe, videoId, ses, live)
      } catch (e) {
        // YouTube мог измениться: yt-dlp обновляется и пробует ещё раз (не чаще раза в час).
        if (Date.now() - lastForcedUpdate < 60 * 60_000) throw e
        lastForcedUpdate = Date.now()
        const before = readState()?.sha256
        await updateOnce().catch(() => undefined)
        if (readState()?.sha256 === before) throw e
        return runWith(exe, videoId, ses, live)
      }
    })()
      .then((f) => {
        found.set(videoId, f)
        return f
      })
      .finally(() => inflight.delete(videoId))
    inflight.set(videoId, p)
  }
  return p
}

/** Ссылку не стал играть <audio>: забыть её, следующий запрос спросит yt-dlp заново. */
export function forget(videoId: string): void {
  found.delete(videoId)
}
