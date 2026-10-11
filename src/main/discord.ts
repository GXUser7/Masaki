// Статус в Discord, как у Spotify: «Слушает YouCloud» — трек, исполнитель, обложка и полоска времени.
// Говорим с запущенным клиентом Discord по его локальному каналу (discord-ipc-N) протоколом Rich Presence;
// ничего не уходит в интернет от Masaki, статус публикует сам Discord. Имя «YouCloud» и значок задаются
// приложением на discord.com/developers — его ID ниже, он открытый (как у любой программы со статусом).

import crypto from 'node:crypto'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { DiscordTrack } from '../shared/types'

/** Приложение «YouCloud» в Discord Developer Portal (владелец — автор Masaki). */
const APP_ID = process.env.MASAKI_DISCORD_APP_ID || '1558936902051307630'
/** Тесты говорят с подставным Discord, а не с настоящим, если он запущен. */
const TEST_PIPE = process.env.MASAKI_DISCORD_PIPE
const SITE = 'https://youcloud.inkerror67.workers.dev/'
/** Значок YouCloud в PNG (у сайта только SVG, а Discord берёт PNG/JPG по https) — лежит на страницах Masaki. */
const ICON = 'https://gxuser7.github.io/Masaki/youcloud.png'

let enabled = false
let track: DiscordTrack | null = null
let sock: net.Socket | null = null
let ready = false
let connecting = false
let retry: NodeJS.Timeout | undefined
let debounce: NodeJS.Timeout | undefined
/** Что сейчас показано в Discord — чтобы не слать одно и то же (Discord пускает 5 обновлений за 20 с). */
let shown = ''

function pipes(): string[] {
  if (TEST_PIPE) return [TEST_PIPE]
  if (process.platform === 'win32') return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`)
  const dirs = [process.env.XDG_RUNTIME_DIR, process.env.TMPDIR, process.env.TMP, process.env.TEMP, os.tmpdir(), '/tmp']
  return [...new Set(dirs.filter((d): d is string => !!d))].flatMap((d) => Array.from({ length: 10 }, (_, i) => path.join(d, `discord-ipc-${i}`)))
}

function frame(op: number, data: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(data), 'utf8')
  const head = Buffer.alloc(8)
  head.writeUInt32LE(op, 0)
  head.writeUInt32LE(json.length, 4)
  return Buffer.concat([head, json])
}

function tryPipe(p: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(p)
    s.once('connect', () => resolve(s))
    s.once('error', reject)
  })
}

async function connect(): Promise<void> {
  if (sock || connecting || !APP_ID) return
  connecting = true
  try {
    for (const p of pipes()) {
      const s = await tryPipe(p).catch(() => null)
      if (!s) continue
      sock = s
      let buf = Buffer.alloc(0)
      s.on('data', (d: Buffer) => {
        buf = Buffer.concat([buf, d])
        while (buf.length >= 8) {
          const op = buf.readUInt32LE(0)
          const len = buf.readUInt32LE(4)
          if (buf.length < 8 + len) break
          const msg = JSON.parse(buf.subarray(8, 8 + len).toString('utf8')) as { evt?: string }
          buf = buf.subarray(8 + len)
          if (op === 3) s.write(frame(4, msg)) // ping → pong
          if (op === 1 && msg.evt === 'READY') {
            ready = true
            shown = ''
            push()
          }
        }
      })
      s.on('error', () => undefined)
      s.on('close', () => {
        sock = null
        ready = false
        shown = ''
        later()
      })
      s.write(frame(0, { v: 1, client_id: APP_ID }))
      return
    }
    later()
  } finally {
    connecting = false
  }
}

/** Discord закрыт — пробуем снова, пока есть что показать. */
function later(): void {
  clearTimeout(retry)
  if (enabled && track?.playing) retry = setTimeout(() => void connect(), 20_000)
}

/** Discord требует 2–128 символов в строках статуса. */
const fit = (s: string, max = 128): string => (s.length >= 2 ? s.slice(0, max) : (s + '  ').slice(0, 2))

function activity(t: DiscordTrack): Record<string, unknown> {
  const cover = /^https:\/\//i.test(t.artwork) && t.artwork.length <= 300 ? t.artwork : ''
  const a: Record<string, unknown> = {
    type: 2, // «Слушает»
    details: fit(t.title),
    state: fit(t.artist || t.album || 'YouCloud'),
    assets: {
      large_image: cover || ICON,
      large_text: fit(t.album || t.title),
      ...(cover ? { small_image: ICON, small_text: 'YouCloud' } : {})
    },
    buttons: [{ label: 'Открыть YouCloud', url: SITE }]
  }
  if (t.duration && t.position !== null) {
    // Полоска времени: Discord считает её сам от start до end.
    const start = Date.now() - t.position * 1000
    a.timestamps = { start: Math.round(start), end: Math.round(start + t.duration * 1000) }
  }
  return a
}

function push(): void {
  if (!ready || !sock) return
  const a = enabled && track?.playing ? activity(track) : null
  // Сдвиг полоски на пару секунд — не повод для нового статуса; перемотка — повод.
  const key = a ? JSON.stringify({ ...a, timestamps: undefined }) + Math.round(((a.timestamps as { start: number } | undefined)?.start ?? 0) / 5000) : ''
  if (key === shown) return
  shown = key
  sock.write(frame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, ...(a ? { activity: a } : {}) }, nonce: crypto.randomUUID() }))
}

/** Трек от интерфейса — с проверкой типов и длины. */
export function parseTrack(t: unknown): DiscordTrack | null {
  if (!t || typeof t !== 'object') return null
  const o = t as Record<string, unknown>
  const str = (v: unknown, n = 300): string => (typeof v === 'string' ? v.trim().slice(0, n) : '')
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
  const title = str(o.title)
  if (!title) return null
  return {
    title,
    artist: str(o.artist),
    album: str(o.album),
    artwork: str(o.artwork, 4000),
    playing: o.playing === true,
    duration: num(o.duration),
    position: num(o.position)
  }
}

/** Что играет в YouCloud (или null — ничего). Обновления сглажены: при смене трека страница шлёт их пачкой. */
export function setDiscordTrack(t: DiscordTrack | null): void {
  track = t
  clearTimeout(debounce)
  debounce = setTimeout(() => {
    if (enabled && track?.playing) void connect()
    push()
  }, 1500)
}

export function setDiscordEnabled(on: boolean): void {
  if (on === enabled) return
  enabled = on
  if (on) setDiscordTrack(track)
  else push() // снять статус
}
