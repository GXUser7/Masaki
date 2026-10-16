// Синхронизация через Google Диск. Chrome Sync закрыт для сторонних браузеров с 2021 года, поэтому
// Masaki хранит свои данные в скрытой папке приложения на Диске пользователя (appDataFolder, доступ
// drive.appdata — остальные файлы Диска не видны). Формат — простые JSON-файлы, чтобы к ним могли
// подключиться и другие версии Masaki (например, будущая Android):
//   prefs.json          { v: 1, fields: { <поле настроек>: { t: время изменения, v: значение } } }
//   history.json        { v: 1, clearedAt, entries: HistoryEntry[] }
//   device-<id>.json    { v: 1, id, name, platform, updated, tabs: SavedTab[] }
//   vault.json          { v: 1, kdf, check, items: { <id>: { t, c } } } — пароли и ключи доступа (passkey,
//                       у них kind: 'passkey' и закрытый ключ PKCS#8 base64url), каждая запись зашифрована
//                       AES-256-GCM ключом из фразы пользователя (PBKDF2-SHA256): Google их не прочитает
// Настройки сливаются по полям «кто позже изменил, тот и прав», история — объединением.
// Ключ Google (OAuth-клиент «Приложение для компьютера») пользователь создаёт сам в Google Cloud:
// встроенного в Masaki нет. Ключ и токен входа лежат в профиле, зашифрованные Windows (safeStorage).

import { app, net, safeStorage, shell } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import type { AddressInfo } from 'net'
import os from 'os'
import path from 'path'
import { JsonFile } from './store'
import type { PlainLogin } from './passwords'
import type { PlainPasskey } from './passkeys'

/** Запись сейфа: пароль или ключ доступа (у ключа kind: 'passkey'). */
export type VaultItem = PlainLogin | PlainPasskey
import type {
  HistoryEntry,
  SavedTab,
  Settings,
  Shortcut,
  SyncAccount,
  SyncDevice,
  SyncOptions,
  SyncState
} from '../shared/types'

export interface SyncHooks {
  settings(): Settings
  /** Применить настройки, пришедшие с Диска: сохранить и показать в интерфейсе. */
  applySettings(s: Settings): void
  history(): HistoryEntry[]
  applyHistory(h: HistoryEntry[]): void
  tabs(): SavedTab[]
  openUrl(url: string): void
  closeTabs(prefix: string): void
  showSettings(): void
  hasCustomWallpaper(): boolean
  state(s: SyncState): void
  historyLimit: number
  /** Все пароли и ключи доступа (с удалёнными) в открытом виде — шифрует их синхронизация. */
  passwordsExport(): VaultItem[]
  passwordsApply(items: VaultItem[]): void
}

type Group = 'bookmarks' | 'settings'

interface Local {
  deviceId: string
  deviceName: string
  account: SyncAccount | null
  options: SyncOptions
  /** Когда поле настроек в последний раз поменялось (здесь или на другом устройстве). */
  times: Record<string, number>
  /** Значение поля на момент последней отметки — по нему видно, что поле поменяли. */
  snapshot: Record<string, string>
  /** Было ли первое слияние группы: при нём избранное объединяется, а настройки берутся из аккаунта. */
  merged: Record<Group, boolean>
  lastSync: number
  historyClearedAt: number
  /** Подпись истории, которая лежит на Диске после прошлой синхронизации. */
  historySig: string
  /** modifiedTime файлов истории на Диске после прошлой синхронизации: не меняется — не качаем. */
  historyRemote: string
  tabsSig: string
  tabsPushed: number
  devices: SyncDevice[]
  deviceMods: Record<string, string>
  /** Есть ли пароли на Диске (null — ещё не смотрели). */
  vaultExists: boolean | null
  vaultRemote: string
  vaultSig: string
}

interface Secret {
  /** Свой OAuth-клиент пользователя; нет — вход встроенным ключом Masaki (BUILTIN). */
  clientId?: string
  clientSecret?: string
  project?: string
  refreshToken?: string
  /** Ключ шифрования паролей (выведен из фразы пользователя) и соль, с которой его вывели. */
  vaultKey?: string
  vaultSalt?: string
}

interface DFile {
  id: string
  name: string
  modifiedTime: string
}

interface PrefsDoc {
  v: 1
  fields: Record<string, { t: number; v: unknown }>
}

interface HistoryDoc {
  v: 1
  clearedAt: number
  entries: HistoryEntry[]
}

interface DeviceDoc {
  v: 1
  id: string
  name: string
  platform: string
  updated: number
  tabs: SavedTab[]
}

interface VaultDoc {
  v: 1
  kdf: { name: 'PBKDF2-SHA256'; iterations: number; salt: string }
  /** Зашифрованная проверочная строка: расшифровалась — ключ верный. */
  check: string
  items: Record<string, { t: number; c: string }>
}

// Для автотестов всё, что ходит в Google, можно направить на подставной сервер.
const MOCK = process.env.MASAKI_SYNC_MOCK
const AUTH_URL = MOCK ? MOCK + '/o/oauth2/v2/auth' : 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = MOCK ? MOCK + '/token' : 'https://oauth2.googleapis.com/token'
const REVOKE_URL = MOCK ? MOCK + '/revoke' : 'https://oauth2.googleapis.com/revoke'
const DRIVE = MOCK ? MOCK + '/drive/v3' : 'https://www.googleapis.com/drive/v3'
const UPLOAD = MOCK ? MOCK + '/upload/drive/v3' : 'https://www.googleapis.com/upload/drive/v3'
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
const SCOPES = ['openid', 'email', 'profile', DRIVE_SCOPE].join(' ')

/**
 * Ключ Masaki, вшитый при сборке (electron.vite.config.ts): с ним вход — одна кнопка, без своего проекта в
 * Google Cloud. У настольных программ Google client secret секретом не считает: он всё равно лежит в программе.
 * Данные при этом у каждого на своём Диске — ключ лишь называет программу. Под подставным Google настоящий
 * ключ не трогаем: тест задаёт свой через MASAKI_SYNC_CLIENT=<id>:<secret>.
 */
declare const __GOOGLE_CLIENT__: { id: string; secret: string } | null
const BUILTIN = MOCK ? mockClient() : __GOOGLE_CLIENT__

function mockClient(): { id: string; secret: string } | null {
  const [id, secret] = (process.env.MASAKI_SYNC_CLIENT ?? '').split(':')
  return id && secret ? { id, secret } : null
}

const PERIOD = 5 * 60_000
const VAULT = 'vault.json'
const VAULT_CHECK = 'masaki-vault-v1'
const KDF_ITERATIONS = 600_000
const DEVICE_TTL = 60 * 24 * 60 * 60_000

/** Поля настроек, которые ездят между устройствами. Остальное (свёрнутая панель, расширения) — своё у каждого. */
const FIELDS: Record<string, Group> = {
  favorites: 'bookmarks',
  shortcuts: 'bookmarks',
  scheme: 'settings',
  palette: 'settings',
  customColor: 'settings',
  glass: 'settings',
  background: 'settings',
  aiDefault: 'settings',
  favThemed: 'settings',
  clock: 'settings',
  'addons.glass': 'settings',
  'addons.adblock': 'settings'
}

const localFile = new JsonFile<Local>('sync.json')
let hooks: SyncHooks
let local: Local
let secret: Secret | null = null
let status: SyncState['status'] = 'off'
let error = ''
let access: { token: string; until: number } | null = null
let pendingSignIn: (() => void) | null = null
let running: Promise<void> | null = null
let again = false
let timer: NodeJS.Timeout | undefined
let due = 0
let vaultError = ''

class SignInNeeded extends Error {}

function freshLocal(): Local {
  return {
    deviceId: crypto.randomBytes(8).toString('hex'),
    deviceName: os.hostname() || 'Компьютер',
    account: null,
    options: { bookmarks: true, settings: true, history: true, tabs: true, passwords: false },
    times: {},
    snapshot: {},
    merged: { bookmarks: false, settings: false },
    lastSync: 0,
    historyClearedAt: 0,
    historySig: '',
    historyRemote: '',
    tabsSig: '',
    tabsPushed: 0,
    devices: [],
    deviceMods: {},
    vaultExists: null,
    vaultRemote: '',
    vaultSig: ''
  }
}

/** Забыть всё, что относится к прошлому входу: следующий вход начнётся с первого слияния. */
function resetBookkeeping(): void {
  const f = freshLocal()
  Object.assign(local, {
    times: f.times,
    snapshot: f.snapshot,
    merged: f.merged,
    lastSync: 0,
    historyClearedAt: 0,
    historySig: '',
    historyRemote: '',
    tabsSig: '',
    tabsPushed: 0,
    devices: [],
    deviceMods: {},
    vaultExists: null,
    vaultRemote: '',
    vaultSig: ''
  })
  vaultError = ''
}

// ---------- Ключ и токен: только зашифрованными ----------

const secretPath = (): string => path.join(app.getPath('userData'), 'sync-auth.bin')

function loadSecret(): Secret | null {
  try {
    const buf = fs.readFileSync(secretPath())
    return JSON.parse(safeStorage.decryptString(buf)) as Secret
  } catch {
    return null
  }
}

function saveSecret(): void {
  const file = secretPath()
  if (!secret) {
    fs.rmSync(file, { force: true })
    return
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, safeStorage.encryptString(JSON.stringify(secret)))
}

/** Ключ, которым входим: свой, если подключён, иначе встроенный. */
function oauthClient(): { id: string; secret: string } | null {
  return secret?.clientId ? { id: secret.clientId, secret: secret.clientSecret ?? '' } : BUILTIN
}

function save(): void {
  localFile.write(local, 300)
}

export function flushSync(): void {
  localFile.flushSync()
}

// ---------- Состояние для интерфейса ----------

function signedIn(): boolean {
  return !!(local.account && secret?.refreshToken)
}

export function getState(): SyncState {
  const client = secret?.clientId ? secret.project || '…' + secret.clientId.split('.')[0].slice(-8) : null
  return {
    client,
    builtinKey: !!BUILTIN,
    account: local.account,
    status,
    lastSync: local.lastSync,
    error,
    options: local.options,
    deviceName: local.deviceName,
    devices: local.options.tabs ? local.devices : [],
    vault: !local.options.passwords
      ? 'off'
      : secret?.vaultKey
        ? 'ready'
        : local.vaultExists === null
          ? 'checking'
          : local.vaultExists
            ? 'needs-key'
            : 'needs-new',
    vaultError
  }
}

function emit(): void {
  hooks.state(getState())
}

// ---------- Запуск и расписание ----------

export async function initSync(h: SyncHooks): Promise<void> {
  hooks = h
  const saved = (await localFile.read()) ?? {}
  local = { ...freshLocal(), ...saved, options: { ...freshLocal().options, ...(saved as Partial<Local>).options } }
  secret = loadSecret()
  status = signedIn() ? 'idle' : 'off'
  if (!secret?.refreshToken && local.account) {
    // Ключ потерян (профиль перенесли на другой компьютер — шифрование Windows там другое).
    status = 'signin'
    error = 'Войдите в Google снова'
  }
  save()
  setInterval(() => {
    if (signedIn()) void syncNow()
  }, PERIOD)
  schedule(4000)
}

/** Синхронизироваться через ms; если уже назначено раньше — так и оставить. */
function schedule(ms: number): void {
  if (!signedIn()) return
  const at = Date.now() + ms
  if (timer && due <= at) return
  clearTimeout(timer)
  due = at
  timer = setTimeout(() => {
    timer = undefined
    due = 0
    void syncNow()
  }, ms)
}

export function onSettingsChanged(): void {
  if (noteLocal()) schedule(3000)
}

export function onHistoryChanged(): void {
  schedule(120_000)
}

export function onHistoryCleared(): void {
  if (!signedIn()) return
  local.historyClearedAt = Date.now()
  save()
  schedule(1500)
}

export function onPasswordsChanged(): void {
  if (local.options.passwords && secret?.vaultKey) schedule(3000)
}

export function onTabsChanged(): void {
  if (local.options.tabs) schedule(30_000)
}

/** Вернулись в окно — подтянуть то, что успели поменять на другом устройстве. */
export function onFocus(): void {
  if (Date.now() - local.lastSync > 60_000) schedule(800)
}

// ---------- Поля настроек ----------

function readField(s: Settings, key: string): unknown {
  if (key.startsWith('addons.')) return s.addons[key.slice(7) as 'glass' | 'adblock']
  return s[key as keyof Settings]
}

function writeField(s: Settings, key: string, v: unknown): Settings {
  if (key.startsWith('addons.')) return { ...s, addons: { ...s.addons, [key.slice(7)]: v } }
  return { ...s, [key]: v }
}

const isSites = (v: unknown): v is Shortcut[] =>
  Array.isArray(v) && v.every((x) => x && typeof x.url === 'string' && typeof x.title === 'string')

/** Значение с Диска могло прийти от другой (в том числе более новой) версии Masaki — проверяем форму. */
function validField(key: string, v: unknown): boolean {
  switch (key) {
    case 'favorites':
    case 'shortcuts':
      return isSites(v)
    case 'scheme':
      return v === 'system' || v === 'light' || v === 'dark'
    case 'glass':
      return v === 's' || v === 'm' || v === 'l'
    case 'background':
      return v === 'shapes' || v === 'wallpaper' || v === 'custom'
    case 'palette':
    case 'customColor':
      return typeof v === 'string' && v.length < 64
    case 'aiDefault':
      return typeof v === 'boolean'
    default:
      return !!v && typeof v === 'object' && !Array.isArray(v)
  }
}

/** Своя картинка фона живёт только в профиле этого компьютера — без неё фон с Диска не берём. */
function canApply(key: string, v: unknown): boolean {
  return !(key === 'background' && v === 'custom' && !hooks.hasCustomWallpaper())
}

const siteKey = (u: string): string =>
  u.replace(/#.*$/, '').replace(/\/$/, '').replace(/^https?:\/\/(www\.)?/i, '').toLowerCase()

function unionSites(first: Shortcut[], second: Shortcut[]): Shortcut[] {
  const keys = new Set(first.map((x) => siteKey(x.url)))
  return [...first, ...second.filter((x) => !keys.has(siteKey(x.url)))]
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Отметить поля, которые поменяли на этом компьютере. true — есть что отправить. */
function noteLocal(): boolean {
  if (!signedIn()) return false
  const s = hooks.settings()
  const now = Date.now()
  let changed = false
  for (const key of Object.keys(FIELDS)) {
    const json = JSON.stringify(readField(s, key))
    if (local.snapshot[key] === undefined) {
      local.snapshot[key] = json
    } else if (local.snapshot[key] !== json) {
      local.snapshot[key] = json
      local.times[key] = now
      changed = true
    }
  }
  if (changed) save()
  return changed
}

// ---------- Google: вход ----------

const b64url = (b: Buffer): string => b.toString('base64url')

function decodeJwt(token: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

const form = { 'Content-Type': 'application/x-www-form-urlencoded' }

function donePage(title: string, text: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
  :root { color-scheme: light dark; --bg: #e3f1ee; --fg: #0d1f1b; --muted: #3f4946 }
  @media (prefers-color-scheme: dark) { :root { --bg: #0d1513; --fg: #dde4e1; --muted: #bfc9c5 } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
    font: 16px/1.5 'Segoe UI', system-ui, sans-serif }
  main { max-width: 440px; padding: 24px; text-align: center }
  h1 { font-size: 28px; margin: 0 0 8px } p { color: var(--muted); margin: 0 }
</style>
<main><h1>${title}</h1><p>${text}</p></main>`
}

export function setClient(id: string, clientSecret: string, project = ''): { ok: boolean; error?: string } {
  id = id.trim()
  clientSecret = clientSecret.trim()
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) return { ok: false, error: 'Это не похоже на Client ID Google — он заканчивается на .apps.googleusercontent.com' }
  if (!clientSecret) return { ok: false, error: 'Нужен и Client secret' }
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'Шифрование Windows недоступно — ключ негде хранить безопасно' }
  // Вход привязан к ключу: другой ключ — войти заново (тот же, что встроенный, — вход остаётся).
  const prev = oauthClient()
  const changed = !!prev && prev.id !== id
  if (changed && signedIn()) void signOut()
  secret = { ...(changed ? {} : (secret ?? {})), clientId: id, clientSecret, project: project.trim() }
  saveSecret()
  emit()
  return { ok: true }
}

/** JSON, который Google Cloud отдаёт кнопкой «Download JSON» у OAuth-клиента. */
export function setClientFromFile(file: string): { ok: boolean; error?: string } {
  let data: Record<string, { client_id?: string; client_secret?: string; project_id?: string }>
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { ok: false, error: 'Файл не читается как JSON' }
  }
  if (data.web) return { ok: false, error: 'Это ключ типа «Веб-приложение». Нужен тип «Приложение для компьютера» (Desktop app).' }
  const c = data.installed
  if (!c?.client_id || !c.client_secret) return { ok: false, error: 'В файле нет client_id и client_secret — это точно ключ OAuth из Google Cloud?' }
  return setClient(c.client_id, c.client_secret, c.project_id ?? '')
}

export function removeClient(): void {
  void signOut()
  // Без своего ключа остаётся встроенный, если он есть в сборке.
  secret = null
  saveSecret()
  emit()
}

export function cancelSignIn(): void {
  pendingSignIn?.()
}

/** hint — почта аккаунта Google, в который уже вошли в Masaki: Google не спрашивает, какой аккаунт выбрать. */
export async function signIn(external = false, hint = ''): Promise<{ ok: boolean; error?: string }> {
  const client = oauthClient()
  if (!client) return { ok: false, error: 'Сначала подключите ключ Google' }
  cancelSignIn()
  const start = secret
  const verifier = b64url(crypto.randomBytes(32))
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
  const state = b64url(crypto.randomBytes(16))

  // Google возвращает код входа на локальный адрес: Masaki слушает его только на время входа.
  let finish!: (r: { code?: string; error?: string }) => void
  const result = new Promise<{ code?: string; error?: string }>((resolve) => (finish = resolve))
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (u.pathname !== '/' || !u.searchParams.has('state')) {
      res.writeHead(404).end()
      return
    }
    const html = { 'Content-Type': 'text/html; charset=utf-8' }
    if (u.searchParams.get('state') !== state) {
      res.writeHead(400, html).end(donePage('Ссылка устарела', 'Начните вход заново в настройках Masaki.'))
      return
    }
    const err = u.searchParams.get('error')
    const code = u.searchParams.get('code')
    res
      .writeHead(200, html)
      .end(err ? donePage('Вход отменён', 'Синхронизацию можно включить позже в настройках Masaki.') : donePage('Готово', 'Masaki синхронизируется. Эта вкладка сейчас закроется.'))
    finish(err ? { error: err } : { code: code ?? undefined, error: code ? undefined : 'no_code' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const timeout = setTimeout(() => finish({ error: 'timeout' }), 10 * 60_000)
  pendingSignIn = () => finish({ error: 'cancelled' })
  const prevStatus = status
  status = 'waiting'
  error = ''
  emit()

  const url =
    AUTH_URL +
    '?' +
    new URLSearchParams({
      client_id: client.id,
      redirect_uri: redirect,
      response_type: 'code',
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      // Без prompt=consent Google при повторном входе не выдаёт refresh_token.
      prompt: 'consent',
      ...(hint ? { login_hint: hint } : {})
    }).toString()
  if (external) void shell.openExternal(url)
  else hooks.openUrl(url)

  const r = await result
  clearTimeout(timeout)
  pendingSignIn = null
  server.close()
  const fail = (msg: string): { ok: false; error: string } => {
    status = prevStatus === 'waiting' ? 'off' : prevStatus
    if (status === 'syncing') status = 'idle'
    error = msg
    emit()
    return { ok: false, error: msg }
  }
  if (!r.code) {
    if (r.error === 'cancelled') return fail('')
    return fail(r.error === 'access_denied' ? 'Вход отменён' : r.error === 'timeout' ? 'Время на вход вышло' : 'Google не вернул код входа')
  }
  setTimeout(() => {
    hooks.closeTabs(redirect)
    hooks.showSettings()
  }, 1200)

  try {
    const res = await net.fetch(TOKEN_URL, {
      method: 'POST',
      headers: form,
      body: new URLSearchParams({
        code: r.code,
        client_id: client.id,
        client_secret: client.secret,
        redirect_uri: redirect,
        grant_type: 'authorization_code',
        code_verifier: verifier
      }).toString()
    })
    const tok = (await res.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      scope?: string
      id_token?: string
      error?: string
      error_description?: string
    }
    if (!res.ok || !tok.access_token) return fail(`Google не выдал доступ: ${tok.error_description || tok.error || res.status}`)
    if (!String(tok.scope ?? '').split(' ').includes(DRIVE_SCOPE)) {
      void revoke(tok.refresh_token || tok.access_token)
      return fail('Нужна галочка «Просматривать и изменять данные приложения на Google Диске» — войдите снова и не снимайте её.')
    }
    if (!tok.refresh_token) return fail('Google не выдал постоянный доступ — попробуйте войти ещё раз')
    const claims = decodeJwt(tok.id_token ?? '')
    const account: SyncAccount = {
      email: String(claims.email ?? ''),
      name: String(claims.name ?? ''),
      photo: typeof claims.picture === 'string' ? claims.picture : ''
    }
    if (local.account?.email !== account.email) resetBookkeeping()
    // Новый вход — заново первое слияние: избранное объединится, настройки придут из аккаунта.
    local.merged = { bookmarks: false, settings: false }
    local.snapshot = {}
    local.account = account
    secret = { ...(start ?? {}), refreshToken: tok.refresh_token }
    saveSecret()
    access = { token: tok.access_token, until: Date.now() + (tok.expires_in ?? 3600) * 1000 }
    status = 'idle'
    error = ''
    save()
    emit()
    void syncNow()
    return { ok: true }
  } catch (e) {
    return fail('Нет связи с Google: ' + (e instanceof Error ? e.message : String(e)))
  }
}

async function revoke(token: string | undefined): Promise<void> {
  if (!token) return
  await net.fetch(REVOKE_URL, { method: 'POST', headers: form, body: 'token=' + encodeURIComponent(token) }).catch(() => undefined)
}

export async function signOut(): Promise<void> {
  const token = secret?.refreshToken
  if (secret) {
    delete secret.refreshToken
    // Другой аккаунт — другие пароли и другой ключ.
    delete secret.vaultKey
    delete secret.vaultSalt
    saveSecret()
  }
  access = null
  local.account = null
  resetBookkeeping()
  clearTimeout(timer)
  timer = undefined
  status = 'off'
  error = ''
  save()
  emit()
  await revoke(token)
}

async function accessToken(): Promise<string> {
  if (access && access.until > Date.now() + 60_000) return access.token
  const client = oauthClient()
  if (!secret?.refreshToken || !client) throw new SignInNeeded('Войдите в Google снова')
  const own = !!secret.clientId
  const res = await net.fetch(TOKEN_URL, {
    method: 'POST',
    headers: form,
    body: new URLSearchParams({
      client_id: client.id,
      client_secret: client.secret,
      refresh_token: secret.refreshToken,
      grant_type: 'refresh_token'
    }).toString()
  })
  const tok = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string }
  if (tok.error === 'invalid_grant') {
    // Отозвали доступ, сменили пароль или приложение в Google Cloud ещё в режиме «Testing» (токен живёт 7 дней).
    throw new SignInNeeded(
      'Google завершил вход в синхронизацию — войдите снова.' +
        (own ? ' Если это повторяется раз в неделю, опубликуйте приложение в Google Cloud (Audience → Publish app).' : '')
    )
  }
  if (tok.error === 'invalid_client' || tok.error === 'unauthorized_client') {
    throw new SignInNeeded(own ? 'Google не принимает ключ — подключите ключ заново' : 'Google не принимает ключ Masaki — обновите Masaki или подключите свой ключ')
  }
  if (!res.ok || !tok.access_token) throw new Error(`Google не выдал доступ (${tok.error ?? res.status})`)
  access = { token: tok.access_token, until: Date.now() + (tok.expires_in ?? 3600) * 1000 }
  return access.token
}

// ---------- Google Диск: папка приложения ----------

async function driveError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; errors?: { reason?: string }[] } }
  const msg = body.error?.message ?? ''
  const reason = body.error?.errors?.[0]?.reason ?? ''
  if (res.status === 403 && (/has not been used|is disabled/i.test(msg) || reason === 'accessNotConfigured')) {
    return secret?.clientId
      ? 'В проекте Google Cloud не включён Google Drive API: APIs & Services → Library → Google Drive API → Enable.'
      : 'Google Диск сейчас не пускает ключ Masaki — обновите Masaki или подключите свой ключ.'
  }
  if (res.status === 403 && /insufficient|scope/i.test(msg + reason)) {
    return 'Нет доступа к Диску — войдите снова и оставьте галочку доступа к данным приложения.'
  }
  if (res.status === 403 || res.status === 429) return 'Google просит подождать с синхронизацией, попробую позже.'
  return `Google Диск ответил ${res.status}${msg ? ': ' + msg : ''}`
}

async function drive(url: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const token = await accessToken()
  const res = await net.fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: 'Bearer ' + token } })
  if (res.status === 401 && retry) {
    access = null
    return drive(url, init, false)
  }
  if (!res.ok && !(init.method === 'DELETE' && res.status === 404)) throw new Error(await driveError(res))
  return res
}

async function listFiles(): Promise<DFile[]> {
  const out: DFile[] = []
  let page = ''
  do {
    const u = `${DRIVE}/files?spaces=appDataFolder&pageSize=1000&fields=nextPageToken,files(id,name,modifiedTime)${page ? '&pageToken=' + encodeURIComponent(page) : ''}`
    const data = (await (await drive(u)).json()) as { files?: DFile[]; nextPageToken?: string }
    out.push(...(data.files ?? []))
    page = data.nextPageToken ?? ''
  } while (page)
  return out
}

async function download<T>(f: DFile): Promise<T | null> {
  const text = await (await drive(`${DRIVE}/files/${f.id}?alt=media`)).text()
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

async function upload(name: string, data: unknown, id?: string): Promise<DFile> {
  const body = JSON.stringify(data)
  const fields = 'fields=id,name,modifiedTime'
  if (id) {
    const res = await drive(`${UPLOAD}/files/${id}?uploadType=media&${fields}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body
    })
    return (await res.json()) as DFile
  }
  const boundary = 'masaki' + crypto.randomBytes(8).toString('hex')
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name, parents: ['appDataFolder'] }) +
    `\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    body +
    `\r\n--${boundary}--`
  const res = await drive(`${UPLOAD}/files?uploadType=multipart&${fields}`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: multipart
  })
  return (await res.json()) as DFile
}

async function remove(id: string): Promise<void> {
  await drive(`${DRIVE}/files/${id}`, { method: 'DELETE' })
}

const newestFirst = (a: DFile, b: DFile): number => b.modifiedTime.localeCompare(a.modifiedTime)

// ---------- Один проход синхронизации ----------

export function syncNow(): Promise<void> {
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    do {
      again = false
      await cycle()
    } while (again)
  })().finally(() => {
    running = null
  })
  return running
}

async function cycle(): Promise<void> {
  if (!signedIn()) return
  status = 'syncing'
  emit()
  try {
    noteLocal()
    const files = await listFiles()
    await syncPrefs(files)
    await syncHistory(files)
    await syncDevices(files)
    await syncVault(files)
    local.lastSync = Date.now()
    status = 'idle'
    error = ''
  } catch (e) {
    if (e instanceof SignInNeeded) {
      status = 'signin'
      error = e.message
    } else {
      status = 'error'
      error = e instanceof Error ? e.message : String(e)
      if (/fetch failed|ERR_|ENOTFOUND|ECONN/i.test(error)) error = 'Нет связи с Google — попробую позже'
    }
  }
  save()
  emit()
}

async function syncPrefs(files: DFile[]): Promise<void> {
  const groups = (Object.keys(local.merged) as Group[]).filter((g) => local.options[g])
  if (!groups.length) return
  const mine = files.filter((f) => f.name === 'prefs.json').sort(newestFirst)
  // Две копии файла бывают, если два устройства создали его одновременно: сливаем все.
  const remote: PrefsDoc = { v: 1, fields: {} }
  for (const f of mine) {
    const d = await download<PrefsDoc>(f)
    for (const [k, field] of Object.entries(d?.fields ?? {})) {
      if (field && typeof field.t === 'number' && (!remote.fields[k] || field.t > remote.fields[k].t)) remote.fields[k] = field
    }
  }
  const before = JSON.stringify(remote)
  const start = hooks.settings()
  let s = start
  const now = Date.now()

  for (const [key, group] of Object.entries(FIELDS)) {
    if (!local.options[group]) continue
    const r = remote.fields[key]
    const rOk = !!r && validField(key, r.v)
    const cur = readField(s, key)
    if (rOk && !canApply(key, r.v)) {
      local.times[key] = Math.max(local.times[key] ?? 0, r.t)
      continue
    }
    if (!local.merged[group]) {
      if (group === 'bookmarks') {
        const union = rOk ? unionSites(r.v as Shortcut[], cur as Shortcut[]) : (cur as Shortcut[])
        if (!rOk || !same(union, r.v)) remote.fields[key] = { t: now, v: union }
        if (!same(union, cur)) s = writeField(s, key, union)
      } else if (rOk) {
        if (!same(r.v, cur)) s = writeField(s, key, r.v)
      } else {
        remote.fields[key] = { t: now, v: cur }
      }
      local.times[key] = remote.fields[key].t
      continue
    }
    const lt = local.times[key] ?? 0
    if (rOk && r.t > lt) {
      if (!same(r.v, cur)) s = writeField(s, key, r.v)
      local.times[key] = r.t
    } else if (!rOk || lt > r.t) {
      const t = lt || now
      remote.fields[key] = { t, v: cur }
      local.times[key] = t
    }
  }
  for (const g of groups) local.merged[g] = true

  if (s !== start) hooks.applySettings(s)
  // Снимок — уже после применения: иначе пришедшие значения посчитались бы своими изменениями.
  const applied = hooks.settings()
  for (const key of Object.keys(FIELDS)) local.snapshot[key] = JSON.stringify(readField(applied, key))

  if (JSON.stringify(remote) !== before || mine.length !== 1) {
    if (Object.keys(remote.fields).length) await upload('prefs.json', remote, mine[0]?.id)
    for (const extra of mine.slice(1)) await remove(extra.id)
  }
}

function historySig(h: HistoryEntry[], clearedAt: number): string {
  const last = h[h.length - 1]
  return `${h.length}|${h[0]?.time ?? 0}|${last?.time ?? 0}|${last?.url ?? ''}|${clearedAt}`
}

function mergeHistory(lists: HistoryEntry[][], clearedAt: number): HistoryEntry[] {
  const map = new Map<string, HistoryEntry>()
  for (const list of lists) {
    for (const e of list) {
      if (e && typeof e.url === 'string' && typeof e.time === 'number' && e.time > clearedAt) map.set(e.url + '|' + e.time, e)
    }
  }
  const sorted = [...map.values()].sort((a, b) => a.time - b.time)
  // Как и локально: подряд одна и та же страница — одна запись (у неё обновляется время).
  const out = sorted.filter((e, i) => sorted[i + 1]?.url !== e.url)
  return out.slice(-hooks.historyLimit)
}

async function syncHistory(files: DFile[]): Promise<void> {
  if (!local.options.history) return
  const mine = files.filter((f) => f.name === 'history.json').sort(newestFirst)
  const remoteMod = mine.map((f) => f.id + ':' + f.modifiedTime).join(',')
  const localH = hooks.history()
  const localSig = historySig(localH, local.historyClearedAt)
  const remoteMoved = remoteMod !== local.historyRemote
  if (!remoteMoved && localSig === local.historySig) return

  const docs: HistoryDoc[] = []
  if (remoteMoved) {
    for (const f of mine) {
      const d = await download<HistoryDoc>(f)
      if (d && Array.isArray(d.entries)) docs.push(d)
    }
  }
  const clearedAt = Math.max(local.historyClearedAt, ...docs.map((d) => Number(d.clearedAt) || 0))
  local.historyClearedAt = clearedAt
  const merged = mergeHistory([localH, ...docs.map((d) => d.entries)], clearedAt)
  const mergedSig = historySig(merged, clearedAt)
  if (mergedSig !== localSig || merged.length !== localH.length) hooks.applyHistory(merged)

  const remoteSig = remoteMoved
    ? docs.length === 1
      ? historySig(mergeHistory([docs[0].entries], Number(docs[0].clearedAt) || 0), Number(docs[0].clearedAt) || 0)
      : ''
    : local.historySig
  let mod = remoteMod
  if (mergedSig !== remoteSig || mine.length !== 1) {
    const f = await upload('history.json', { v: 1, clearedAt, entries: merged } satisfies HistoryDoc, mine[0]?.id)
    for (const extra of mine.slice(1)) await remove(extra.id)
    mod = f.id + ':' + f.modifiedTime
  }
  local.historySig = mergedSig
  local.historyRemote = mod
}

function cleanTabs(tabs: unknown): SavedTab[] {
  if (!Array.isArray(tabs)) return []
  return tabs
    .filter((t) => t && typeof t.url === 'string' && /^https?:/i.test(t.url))
    .slice(0, 100)
    .map((t) => ({
      url: String(t.url),
      title: String(t.title ?? ''),
      // Значки-картинки внутри адреса раздули бы файл — берём только короткие ссылки.
      favicon: typeof t.favicon === 'string' && /^https:/.test(t.favicon) && t.favicon.length < 400 ? t.favicon : undefined
    }))
}

async function syncDevices(files: DFile[]): Promise<void> {
  const own = `device-${local.deviceId}.json`
  const ownFile = files.find((f) => f.name === own)
  if (!local.options.tabs) {
    // Выключили — другие устройства не должны видеть устаревшие вкладки этого компьютера.
    if (ownFile) await remove(ownFile.id)
    local.devices = []
    local.tabsSig = ''
    return
  }
  const tabs = cleanTabs(hooks.tabs())
  const sig = JSON.stringify([local.deviceName, tabs.map((t) => [t.url, t.title])])
  const now = Date.now()
  if (!ownFile || sig !== local.tabsSig || now - local.tabsPushed > 30 * 60_000) {
    const doc: DeviceDoc = { v: 1, id: local.deviceId, name: local.deviceName, platform: 'windows', updated: now, tabs }
    await upload(own, doc, ownFile?.id)
    local.tabsSig = sig
    local.tabsPushed = now
  }
  const next: SyncDevice[] = []
  const mods: Record<string, string> = {}
  for (const f of files) {
    if (!/^device-[\w-]+\.json$/.test(f.name) || f.name === own) continue
    const cached = local.devices.find((d) => `device-${d.id}.json` === f.name)
    if (cached && local.deviceMods[f.name] === f.modifiedTime) {
      next.push(cached)
      mods[f.name] = f.modifiedTime
      continue
    }
    const d = await download<DeviceDoc>(f)
    if (!d || typeof d.id !== 'string') continue
    next.push({
      id: d.id,
      name: String(d.name || 'Устройство'),
      platform: String(d.platform || ''),
      updated: Number(d.updated) || 0,
      tabs: cleanTabs(d.tabs)
    })
    mods[f.name] = f.modifiedTime
  }
  local.devices = next.filter((d) => now - d.updated < DEVICE_TTL).sort((a, b) => b.updated - a.updated)
  local.deviceMods = mods
}

// ---------- Пароли: шифруются на устройстве ключом из фразы пользователя ----------

function seal(key: Buffer, aad: string, plain: string): string {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  // Id записи — часть проверки: зашифрованную запись нельзя выдать за другую.
  c.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64')
}

function unseal(key: Buffer, aad: string, sealed: string): string {
  const b = Buffer.from(sealed, 'base64')
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12))
  d.setAAD(Buffer.from(aad))
  d.setAuthTag(b.subarray(b.length - 16))
  return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8')
}

function derive(passphrase: string, salt: Buffer, iterations: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.pbkdf2(passphrase.normalize('NFKC'), salt, iterations, 32, 'sha256', (e, k) => (e ? reject(e) : resolve(k)))
  )
}

const vaultSigOf = (items: VaultItem[]): string =>
  items
    .map((i) => i.id + ':' + i.t)
    .sort()
    .join(',')

async function syncVault(files: DFile[]): Promise<void> {
  const f = files.filter((x) => x.name === VAULT).sort(newestFirst)[0]
  const existed = local.vaultExists
  local.vaultExists = !!f
  if (!local.options.passwords || !secret?.vaultKey) {
    if (existed !== local.vaultExists) emit()
    return
  }
  const key = Buffer.from(secret.vaultKey, 'base64')
  const mod = f ? f.id + ':' + f.modifiedTime : ''
  if (f && mod === local.vaultRemote && vaultSigOf(hooks.passwordsExport()) === local.vaultSig) return

  let doc = f ? await download<VaultDoc>(f) : null
  if (doc && doc.kdf?.salt !== secret.vaultSalt) {
    // На другом устройстве ключ задали заново — старый больше не подходит.
    delete secret.vaultKey
    delete secret.vaultSalt
    saveSecret()
    vaultError = 'Ключ паролей сменили на другом устройстве — введите новый'
    return
  }
  // Пароли с Диска удалили (например, «Удалить данные с Диска» на другом устройстве) — выкладываем свои заново.
  doc ??= {
    v: 1,
    kdf: { name: 'PBKDF2-SHA256', iterations: KDF_ITERATIONS, salt: secret.vaultSalt ?? '' },
    check: seal(key, 'check', VAULT_CHECK),
    items: {}
  }
  doc.items ??= {}

  const mine = new Map(hooks.passwordsExport().map((i) => [i.id, i]))
  const incoming: VaultItem[] = []
  for (const [id, it] of Object.entries(doc.items)) {
    const m = mine.get(id)
    if (m && m.t >= it.t) continue
    try {
      const plain = JSON.parse(unseal(key, id, it.c)) as Omit<VaultItem, 'id' | 't'>
      incoming.push({ ...plain, id, t: it.t } as VaultItem)
    } catch {
      // запись повреждена или зашифрована чужим ключом — пропускаем
    }
  }
  if (incoming.length) hooks.passwordsApply(incoming)

  let changed = !f
  const after = hooks.passwordsExport()
  for (const i of after) {
    const r = doc.items[i.id]
    if (r && r.t >= i.t) continue
    const { id, t, ...plain } = i
    doc.items[id] = { t, c: seal(key, id, JSON.stringify(plain)) }
    changed = true
  }
  let next = mod
  if (changed) {
    const up = await upload(VAULT, doc, f?.id)
    next = up.id + ':' + up.modifiedTime
  }
  local.vaultRemote = next
  local.vaultSig = vaultSigOf(after)
  vaultError = ''
}

export async function setVaultKey(passphrase: string): Promise<{ ok: boolean; error?: string }> {
  if (!signedIn() || !secret) return { ok: false, error: 'Сначала войдите в синхронизацию' }
  if (passphrase.length < 8) return { ok: false, error: 'Ключ — не короче 8 символов' }
  try {
    const f = (await listFiles()).filter((x) => x.name === VAULT).sort(newestFirst)[0]
    let key: Buffer
    let salt: string
    if (f) {
      const doc = await download<VaultDoc>(f)
      const it = Number(doc?.kdf?.iterations)
      if (!doc?.kdf?.salt || !doc.check || !(it >= 100_000 && it <= 10_000_000)) return { ok: false, error: 'Пароли на Диске повреждены' }
      key = await derive(passphrase, Buffer.from(doc.kdf.salt, 'base64'), it)
      try {
        if (unseal(key, 'check', doc.check) !== VAULT_CHECK) throw new Error()
      } catch {
        return { ok: false, error: 'Ключ не подходит' }
      }
      salt = doc.kdf.salt
    } else {
      const s = crypto.randomBytes(16)
      key = await derive(passphrase, s, KDF_ITERATIONS)
      salt = s.toString('base64')
      const doc: VaultDoc = { v: 1, kdf: { name: 'PBKDF2-SHA256', iterations: KDF_ITERATIONS, salt }, check: seal(key, 'check', VAULT_CHECK), items: {} }
      await upload(VAULT, doc)
    }
    secret.vaultKey = key.toString('base64')
    secret.vaultSalt = salt
    saveSecret()
    local.vaultExists = true
    local.vaultRemote = ''
    local.vaultSig = ''
    vaultError = ''
    save()
    emit()
    void syncNow()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function resetVault(): Promise<{ ok: boolean; error?: string }> {
  try {
    for (const f of (await listFiles()).filter((x) => x.name === VAULT)) await remove(f.id)
    if (secret) {
      delete secret.vaultKey
      delete secret.vaultSalt
      saveSecret()
    }
    local.vaultExists = false
    local.vaultRemote = ''
    local.vaultSig = ''
    vaultError = ''
    save()
    emit()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ---------- Действия из настроек ----------

export function setOptions(o: Partial<SyncOptions>): void {
  for (const g of ['bookmarks', 'settings'] as Group[]) {
    // Выключенная группа при следующем включении сольётся заново, как при первом входе.
    if (o[g] === false) local.merged[g] = false
  }
  if (o.history === false) {
    local.historySig = ''
    local.historyRemote = ''
  }
  if (o.passwords === true && !local.options.passwords) local.vaultExists = null
  local.options = { ...local.options, ...o }
  save()
  emit()
  schedule(500)
}

export function setDeviceName(name: string): void {
  const n = name.trim().slice(0, 40)
  if (!n || n === local.deviceName) return
  local.deviceName = n
  local.tabsSig = ''
  save()
  emit()
  schedule(1000)
}

export async function forgetDevice(id: string): Promise<void> {
  local.devices = local.devices.filter((d) => d.id !== id)
  emit()
  try {
    const f = (await listFiles()).find((x) => x.name === `device-${id}.json`)
    if (f) await remove(f.id)
  } catch {
    // устройство пропадёт из списка и так; файл удалится при следующей попытке
  }
  save()
}

/** Удалить с Диска всё, что туда положил Masaki, и выйти из синхронизации на этом компьютере. */
export async function wipe(): Promise<{ ok: boolean; error?: string }> {
  try {
    for (const f of await listFiles()) await remove(f.id)
    await signOut()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
