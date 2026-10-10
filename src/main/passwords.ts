// Менеджер паролей Masaki. Google Password Manager закрыт для сторонних программ, а пароли Chrome
// зашифрованы от чужих программ (вскрывать это — работа стилеров), поэтому пароли переносятся только
// честным путём: пользователь сам экспортирует CSV на passwords.google.com, Masaki его забирает и
// удаляет файл. Пароли хранятся в profile/passwords.json, каждый зашифрован Windows (safeStorage, DPAPI);
// в интерфейс уходят только логины, сам пароль — лишь по «показать» или прямо в поле страницы.

import { clipboard, safeStorage, webContents, type WebContents } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { JsonFile } from './store'
import type { AutofillRequest, PasswordCsv, PasswordImportResult, PasswordItem, PasswordOffer } from '../shared/types'

export interface Login {
  id: string
  origin: string
  username: string
  /** Пароль, зашифрованный Windows (safeStorage), в base64. */
  secret: string
  note: string
  created: number
  updated: number
  used: number
  /** Когда запись меняли в последний раз — для синхронизации. */
  t: number
  /** Удалённая запись остаётся пометкой, чтобы удаление дошло до других устройств. */
  deleted?: boolean
}

interface Data {
  v: 1
  logins: Login[]
  /** Сайты, для которых пользователь выбрал «Никогда не сохранять». */
  never: string[]
}

export interface PasswordHooks {
  /** Сообщение интерфейсу Masaki. */
  ui(channel: string, payload?: unknown): void
  /** Список паролей поменялся — синхронизации пора отправить изменения. */
  changed(): void
}

const file = new JsonFile<Data>('passwords.json')
let data: Data = { v: 1, logins: [], never: [] }
let hooks: PasswordHooks

export async function initPasswords(h: PasswordHooks): Promise<void> {
  hooks = h
  const saved = await file.read()
  if (saved && Array.isArray(saved.logins)) data = { v: 1, logins: saved.logins, never: saved.never ?? [] }
}

export function flushPasswords(): void {
  file.flushSync()
}

function persist(): void {
  file.write(data, 200)
  hooks.ui('passwords-changed')
  // Вкладки перечитают список аккаунтов для автозаполнения.
  for (const wc of webContents.getAllWebContents()) if (wc.getType() === 'webview' && !wc.isDestroyed()) wc.send('pw:changed')
  hooks.changed()
}

const encrypt = (pw: string): string => safeStorage.encryptString(pw).toString('base64')

function decrypt(l: Login): string | null {
  try {
    return safeStorage.decryptString(Buffer.from(l.secret, 'base64'))
  } catch {
    return null
  }
}

const live = (): Login[] => data.logins.filter((l) => !l.deleted)

/** Адрес → origin сайта (схема, хост, порт). Пароли Android-приложений и прочее — null. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url.trim())
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return u.origin
  } catch {
    return null
  }
}

/** Регистрируемый домен по-простому: github.com для gist.github.com, example.co.uk для www.example.co.uk. */
function siteOf(origin: string): string {
  let host: string
  try {
    host = new URL(origin).hostname
  } catch {
    return origin
  }
  if (/^[\d.]+$/.test(host) || host.startsWith('[') || !host.includes('.')) return host
  const parts = host.split('.')
  const tld = parts[parts.length - 1]
  const sld = parts[parts.length - 2]
  const n = parts.length > 2 && tld.length === 2 && /^(co|com|net|org|gov|edu|ac|or|ne|go|msk|spb)$/.test(sld) ? 3 : 2
  return parts.slice(-n).join('.')
}

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host.replace(/^www\./, '')
  } catch {
    return origin
  }
}

function item(l: Login): PasswordItem {
  return { id: l.id, origin: l.origin, host: hostOf(l.origin), username: l.username, note: l.note, updated: l.updated, used: l.used }
}

export function list(): PasswordItem[] {
  return live()
    .map(item)
    .sort((a, b) => a.host.localeCompare(b.host) || a.username.localeCompare(b.username))
}

export function reveal(id: string): string | null {
  const l = live().find((x) => x.id === id)
  return l ? decrypt(l) : null
}

let clipTimer: NodeJS.Timeout | undefined
export async function copy(id: string): Promise<boolean> {
  const pw = reveal(id)
  if (pw === null) return false
  await clipboard.writeText(pw)
  clearTimeout(clipTimer)
  // Через минуту убираем пароль из буфера, если там всё ещё он.
  clipTimer = setTimeout(async () => {
    try {
      if ((await clipboard.readText()) === pw) await clipboard.writeText('')
    } catch {
      // буфер занят другой программой — оставляем как есть
    }
  }, 60_000)
  return true
}

function upsert(origin: string, username: string, password: string, note = '', now = Date.now()): 'added' | 'updated' | 'same' {
  const existing = live().find((l) => l.origin === origin && l.username === username)
  if (existing) {
    if (decrypt(existing) === password && (!note || existing.note === note)) return 'same'
    existing.secret = encrypt(password)
    if (note) existing.note = note
    existing.updated = now
    existing.t = now
    return 'updated'
  }
  data.logins.push({
    id: crypto.randomBytes(9).toString('base64url'),
    origin,
    username,
    secret: encrypt(password),
    note,
    created: now,
    updated: now,
    used: 0,
    t: now
  })
  return 'added'
}

export function save(p: { id?: string; url: string; username: string; password?: string; note?: string }): { ok: boolean; error?: string } {
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'Шифрование Windows недоступно — пароль негде хранить безопасно' }
  const origin = originOf(/^[a-z]+:/i.test(p.url.trim()) ? p.url : 'https://' + p.url.trim())
  if (!origin) return { ok: false, error: 'Нужен адрес сайта, например github.com' }
  const username = p.username.trim()
  const now = Date.now()
  if (p.id) {
    const l = live().find((x) => x.id === p.id)
    if (!l) return { ok: false, error: 'Пароль уже удалён' }
    if (live().some((x) => x !== l && x.origin === origin && x.username === username)) {
      return { ok: false, error: 'Для этого сайта такой логин уже сохранён' }
    }
    l.origin = origin
    l.username = username
    if (p.password) l.secret = encrypt(p.password)
    if (p.note !== undefined) l.note = p.note
    l.updated = now
    l.t = now
  } else {
    if (!p.password) return { ok: false, error: 'Пустой пароль не сохраняю' }
    upsert(origin, username, p.password, p.note ?? '', now)
  }
  persist()
  return { ok: true }
}

export function remove(id: string): void {
  const l = data.logins.find((x) => x.id === id)
  if (!l || l.deleted) return
  l.deleted = true
  l.secret = ''
  l.username = ''
  l.note = ''
  l.t = Date.now()
  persist()
}

// ---------- Импорт CSV ----------

/** CSV по RFC 4180: кавычки, запятые и переводы строк внутри кавычек. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((x) => x !== ''))
}

interface CsvLogin {
  origin: string
  username: string
  password: string
  note: string
}

/** Понимает экспорт Google Password Manager / Chrome (name,url,username,password,note), Firefox и Bitwarden. */
function readCsv(file: string): { logins: CsvLogin[]; skipped: number } {
  const rows = parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
  const head = (rows.shift() ?? []).map((h) => h.trim().toLowerCase())
  const col = (...names: string[]): number => head.findIndex((h) => names.includes(h))
  const iUrl = col('url', 'login_uri', 'origin', 'website')
  const iUser = col('username', 'login_username', 'login', 'email')
  const iPass = col('password', 'login_password')
  const iNote = col('note', 'notes')
  if (iUrl < 0 || iPass < 0) throw new Error('Не похоже на экспорт паролей: нет столбцов url и password')
  const logins: CsvLogin[] = []
  let skipped = 0
  for (const r of rows) {
    const origin = originOf(r[iUrl] ?? '')
    const password = r[iPass] ?? ''
    // Пароли Android-приложений (android://…) и пустые записи браузеру не нужны.
    if (!origin || !password) {
      skipped++
      continue
    }
    logins.push({ origin, username: (iUser >= 0 ? r[iUser] : '')?.trim() ?? '', password, note: iNote >= 0 ? (r[iNote] ?? '') : '' })
  }
  return { logins, skipped }
}

export function importCsv(file: string, removeAfter: boolean): PasswordImportResult {
  if (!safeStorage.isEncryptionAvailable()) return { added: 0, updated: 0, skipped: 0, error: 'Шифрование Windows недоступно' }
  let parsed: { logins: CsvLogin[]; skipped: number }
  try {
    parsed = readCsv(file)
  } catch (e) {
    return { added: 0, updated: 0, skipped: 0, error: e instanceof Error ? e.message : String(e) }
  }
  const res: PasswordImportResult = { added: 0, updated: 0, skipped: parsed.skipped }
  for (const l of parsed.logins) {
    const r = upsert(l.origin, l.username, l.password, l.note)
    if (r === 'added') res.added++
    else if (r === 'updated') res.updated++
  }
  persist()
  // Файл с открытыми паролями на диске оставлять нельзя.
  if (removeAfter) {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      res.error = 'Пароли перенесены, но файл удалить не вышло — удалите его вручную: ' + path.basename(file)
    }
  }
  return res
}

// Скачанные файлы экспорта: интерфейс предлагает перенести их, путь знает только главный процесс.
const csvFiles = new Map<string, string>()

export function isPasswordExport(filename: string): boolean {
  return /pass(word)?s?[^/\\]*\.csv$/i.test(filename) || /пароли[^/\\]*\.csv$/i.test(filename)
}

export function csvDownloaded(file: string): void {
  let count = 0
  try {
    count = readCsv(file).logins.length
  } catch {
    return
  }
  if (!count) return
  const id = crypto.randomBytes(6).toString('hex')
  csvFiles.set(id, file)
  hooks.ui('passwords-csv', { id, filename: path.basename(file), count } satisfies PasswordCsv)
}

export function importDownloaded(id: string): PasswordImportResult {
  const f = csvFiles.get(id)
  csvFiles.delete(id)
  if (!f) return { added: 0, updated: 0, skipped: 0, error: 'Файл уже обработан' }
  return importCsv(f, true)
}

export function dismissCsv(id: string): void {
  csvFiles.delete(id)
}

// ---------- Автозаполнение ----------

/** Аккаунты для страницы: сначала этого же адреса, затем того же сайта (вход на поддомене). */
export function matchesFor(origin: string | undefined): AutofillRequest['items'] {
  if (!origin || !originOf(origin)) return []
  const site = siteOf(origin)
  const secure = origin.startsWith('https:')
  const exact = live().filter((l) => l.origin === origin)
  const related = live().filter((l) => l.origin !== origin && (!secure || l.origin.startsWith('https:')) && siteOf(l.origin) === site)
  return [...exact, ...related]
    .sort((a, b) => (a.origin === origin ? 0 : 1) - (b.origin === origin ? 0 : 1) || b.used - a.used)
    .slice(0, 12)
    .map((l) => ({ id: l.id, username: l.username, host: hostOf(l.origin) }))
}

/** Вписать логин и пароль во вкладку — только если она всё ещё на том же сайте. */
export function fill(wc: WebContents, id: string): void {
  const l = live().find((x) => x.id === id)
  if (!l || wc.isDestroyed()) return
  const origin = wc.mainFrame.origin
  if (!matchesFor(origin).some((m) => m.id === id)) return
  const password = decrypt(l)
  if (password === null) return
  l.used = Date.now()
  file.write(data, 1000)
  wc.send('pw:fill', { username: l.username, password })
}

// ---------- Предложение сохранить ----------

interface Pending {
  offer: PasswordOffer
  origin: string
  password: string
  wcId: number
  at: number
}
const pending = new Map<string, Pending>()
/** Вход в несколько шагов: логин со страницы без пароля (почта на первом шаге входа Google). */
const usernameSteps = new Map<number, { origin: string; username: string; at: number }>()

export function onUsernameStep(wc: WebContents, origin: string | undefined, username: string): void {
  if (!origin || !originOf(origin) || !username) return
  usernameSteps.set(wc.id, { origin, username: username.slice(0, 200), at: Date.now() })
}

export function onSubmit(wc: WebContents, origin: string | undefined, d: { username: string; password: string }): void {
  if (!origin || !originOf(origin) || !d.password || d.password.length > 500) return
  if (data.never.includes(origin)) return
  let username = (d.username ?? '').slice(0, 200)
  const step = usernameSteps.get(wc.id)
  if (!username && step && step.origin === origin && Date.now() - step.at < 10 * 60_000) username = step.username
  const existing = live().find((l) => l.origin === origin && l.username === username)
  if (existing && decrypt(existing) === d.password) {
    existing.used = Date.now()
    file.write(data, 1000)
    return
  }
  // Одна вкладка — одно предложение: повторная отправка формы просто обновляет его.
  const now = Date.now()
  for (const [id, p] of pending) if (now - p.at > 15 * 60_000) pending.delete(id)
  const prev = [...pending.values()].find((p) => p.wcId === wc.id && p.origin === origin)
  const id = prev?.offer.id ?? crypto.randomBytes(6).toString('hex')
  const offer: PasswordOffer = { id, host: hostOf(origin), username, update: !!existing }
  pending.set(id, { offer, origin, password: d.password, wcId: wc.id, at: now })
  hooks.ui('passwords-offer', offer)
}

export function answer(id: string, action: 'save' | 'never' | 'dismiss'): void {
  const p = pending.get(id)
  pending.delete(id)
  if (!p) return
  if (action === 'save') {
    upsert(p.origin, p.offer.username, p.password)
    persist()
  } else if (action === 'never') {
    if (!data.never.includes(p.origin)) data.never.push(p.origin)
    file.write(data, 200)
  }
}

export function neverList(): string[] {
  return data.never.slice().sort()
}

export function forgetNever(origin: string): void {
  data.never = data.never.filter((o) => o !== origin)
  file.write(data, 200)
}

// ---------- Для синхронизации ----------

/** Запись для синхронизации: пароль открытым текстом, шифрует его уже синхронизация ключом пользователя. */
export interface PlainLogin {
  id: string
  t: number
  deleted?: boolean
  origin: string
  username: string
  password: string
  note: string
  created: number
}

/** Все записи вместе с удалёнными. */
export function syncExport(): PlainLogin[] {
  return data.logins.map((l) => ({
    id: l.id,
    t: l.t,
    deleted: l.deleted,
    origin: l.origin,
    username: l.username,
    password: l.deleted ? '' : (decrypt(l) ?? ''),
    note: l.note,
    created: l.created
  }))
}

/** Записи с других устройств, которые новее своих (по t). */
export function syncApply(items: PlainLogin[]): void {
  let changed = false
  for (const r of items) {
    const l = data.logins.find((x) => x.id === r.id)
    if (l && l.t >= r.t) continue
    const origin = originOf(r.origin)
    if (!r.deleted && !origin) continue
    // Тот же логин, заведённый на двух устройствах независимо (например, оба импортировали один CSV):
    // остаётся одна запись — более новая, вторая удаляется пометкой и уйдёт на Диск.
    const twin = !l && !r.deleted ? live().find((x) => x.origin === origin && x.username === r.username) : undefined
    if (twin) {
      const now = Date.now()
      if (r.t > twin.t) {
        Object.assign(twin, { deleted: true, secret: '', username: '', note: '', t: now })
      } else {
        data.logins.push({ id: r.id, origin: '', username: '', secret: '', note: '', created: r.created, updated: now, used: 0, t: now, deleted: true })
        changed = true
        continue
      }
    }
    const next: Login = {
      id: r.id,
      origin: origin ?? '',
      username: r.deleted ? '' : r.username,
      secret: r.deleted ? '' : encrypt(r.password),
      note: r.deleted ? '' : r.note,
      created: r.created || r.t,
      updated: r.t,
      used: l?.used ?? 0,
      t: r.t,
      deleted: r.deleted || undefined
    }
    if (l) Object.assign(l, next)
    else data.logins.push(next)
    changed = true
  }
  if (!changed) return
  file.write(data, 200)
  hooks.ui('passwords-changed')
  for (const wc of webContents.getAllWebContents()) if (wc.getType() === 'webview' && !wc.isDestroyed()) wc.send('pw:changed')
}
