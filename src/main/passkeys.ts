// Ключи доступа (passkey) Masaki. Встроенный в Electron WebAuthn ходит в Windows, а на ПК пользователя
// нет Windows Hello — создать passkey там нельзя. Поэтому у Masaki свой «аутентификатор платформы»:
// скрипт вкладки подменяет navigator.credentials.create/get (src/preload/passkey-page.ts), а ключи
// создаёт, хранит и подписывает ими главный процесс. Закрытый ключ отсюда не выходит: страница получает
// открытый ключ и подписи, интерфейс — имена аккаунтов. Сайт (origin) берётся у фрейма вкладки, а не со
// слов страницы, RP ID проверяется по списку публичных суффиксов. Каждое создание и вход подтверждает
// пользователь в интерфейсе Masaki (окно поверх вкладки или строка автозаполнения у поля входа).
//
// Хранение — profile/passkeys.json, закрытый ключ (PKCS#8) зашифрован Windows (safeStorage, DPAPI).
// Синхронизация — в том же сейфе vault.json, что и пароли (запись с kind: 'passkey').

import { safeStorage, type WebContents } from 'electron'
import crypto from 'crypto'
import { getDomain, getPublicSuffix } from 'tldts'
import { JsonFile } from './store'
import type { AutofillItem, PasskeyItem, PasskeyPrompt } from '../shared/types'

export interface Passkey {
  /** Id записи — для синхронизации и интерфейса (не путать с credential id). */
  id: string
  rpId: string
  /** Credential ID, base64url. */
  credId: string
  /** user.id от сайта, base64url. */
  userHandle: string
  userName: string
  displayName: string
  /** COSE-алгоритм: -7 (ES256), -8 (EdDSA), -257 (RS256). */
  alg: number
  /** Закрытый ключ PKCS#8 DER, зашифрованный Windows (safeStorage), base64. */
  key: string
  created: number
  used: number
  t: number
  deleted?: boolean
}

interface Data {
  v: 1
  keys: Passkey[]
}

export interface PasskeyHooks {
  ui(channel: string, payload?: unknown): void
  /** Ключи поменялись — синхронизации пора отправить изменения. */
  changed(): void
  /** Ключи уходят в шифрованный сейф на Диске (флаг BS — «есть резервная копия»). */
  backedUp(): boolean
}

const file = new JsonFile<Data>('passkeys.json')
let data: Data = { v: 1, keys: [] }
let hooks: PasskeyHooks

/** AAGUID Masaki: по нему сайты могут понять, каким менеджером создан ключ. */
const AAGUID = Buffer.from('493f1de8799e40dc83bd46bba0c307c2', 'hex')
const SUPPORTED = [-7, -8, -257]

export async function initPasskeys(h: PasskeyHooks): Promise<void> {
  hooks = h
  const saved = await file.read()
  if (saved && Array.isArray(saved.keys)) data = { v: 1, keys: saved.keys }
}

export function flushPasskeys(): void {
  file.flushSync()
}

function persist(): void {
  file.write(data, 200)
  hooks.ui('passkeys-changed')
  hooks.changed()
}

const live = (): Passkey[] => data.keys.filter((k) => !k.deleted)

// ---------- Байты ----------

const b64u = (b: Buffer): string => b.toString('base64url')
const unb64u = (s: unknown, max = 1024): Buffer | null => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) return null
  const b = Buffer.from(s, 'base64url')
  return b.length > max ? null : b
}
const sha256 = (b: Buffer | string): Buffer => crypto.createHash('sha256').update(b).digest()
const u16 = (n: number): Buffer => Buffer.from([(n >> 8) & 255, n & 255])
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  return b
}

/** Карта CBOR с порядком ключей как задан (для COSE и attestationObject он важен). */
type CborMap = { map: [string | number, Cbor][] }
type Cbor = number | string | Buffer | CborMap

function cborHead(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n])
  if (n < 256) return Buffer.from([(major << 5) | 24, n])
  if (n < 65536) return Buffer.concat([Buffer.from([(major << 5) | 25]), u16(n)])
  return Buffer.concat([Buffer.from([(major << 5) | 26]), u32(n)])
}

function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v)
  if (typeof v === 'string') {
    const s = Buffer.from(v, 'utf8')
    return Buffer.concat([cborHead(3, s.length), s])
  }
  if (Buffer.isBuffer(v)) return Buffer.concat([cborHead(2, v.length), v])
  return Buffer.concat([cborHead(5, v.map.length), ...v.map.flatMap(([k, x]) => [cbor(k), cbor(x)])])
}

// ---------- Ключи ----------

function generate(alg: number): { privateKey: crypto.KeyObject; publicKey: crypto.KeyObject } {
  if (alg === -7) return crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  if (alg === -8) return crypto.generateKeyPairSync('ed25519')
  return crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 })
}

/** Открытый ключ в формате COSE (RFC 9053), как его ждут сайты в attestedCredentialData. */
function coseKey(alg: number, pub: crypto.KeyObject): Buffer {
  const jwk = pub.export({ format: 'jwk' })
  const b = (s: string | undefined): Buffer => Buffer.from(s ?? '', 'base64url')
  if (alg === -7) return cbor({ map: [[1, 2], [3, -7], [-1, 1], [-2, b(jwk.x)], [-3, b(jwk.y)]] })
  if (alg === -8) return cbor({ map: [[1, 1], [3, -8], [-1, 6], [-2, b(jwk.x)]] })
  return cbor({ map: [[1, 3], [3, -257], [-1, b(jwk.n)], [-2, b(jwk.e)]] })
}

function sign(k: Passkey, data: Buffer): Buffer | null {
  let der: Buffer
  try {
    der = Buffer.from(safeStorage.decryptString(Buffer.from(k.key, 'base64')), 'base64')
  } catch {
    return null
  }
  const key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  if (k.alg === -8) return crypto.sign(null, data, key)
  if (k.alg === -7) return crypto.sign('sha256', data, { key, dsaEncoding: 'der' })
  return crypto.sign('sha256', data, key)
}

// ---------- Проверка сайта ----------

/** Сайт фрейма: https или http://localhost (WebAuthn работает только в защищённом контексте). */
function hostOf(origin: string): string | null {
  try {
    const u = new URL(origin)
    if (u.protocol === 'https:') return u.hostname.toLowerCase()
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname.endsWith('.localhost'))) return u.hostname.toLowerCase()
  } catch {
    // непрозрачный origin (sandbox, data:) — нет сайта
  }
  return null
}

/** RP ID — сам хост или его родительский домен, но не публичный суффикс (co.uk, github.io). */
function rpAllowed(rpId: string, host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return rpId === host || rpId === 'localhost'
  if (rpId !== host && !host.endsWith('.' + rpId)) return false
  if (getPublicSuffix(rpId, { allowPrivateDomains: true }) === rpId) return false
  return getDomain(rpId, { allowPrivateDomains: true }) !== null
}

// ---------- Запросы страниц ----------

type Fail = { ok: false; name: string; message: string }
type Result = { ok: true; cred: unknown } | Fail | { fallback: true }

interface Desc {
  id: Buffer
}
interface CreateOpts {
  rpName: string
  user: { id: Buffer; name: string; displayName: string }
  challenge: Buffer
  alg: number
  exclude: Desc[]
  crossPlatform: boolean
  credProps: boolean
}
interface GetOpts {
  challenge: Buffer
  allow: Desc[]
}

interface Req {
  key: string
  reqId: string
  wc: WebContents
  kind: 'create' | 'get'
  conditional: boolean
  origin: string
  rpId: string
  create?: CreateOpts
  get?: GetOpts
  /** Ключи сайта, подходящие под запрос входа. */
  candidates: Passkey[]
  done(r: Result): void
  timer?: NodeJS.Timeout
  prompt?: PasskeyPrompt
}

const reqs = new Map<string, Req>()
const watched = new WeakSet<WebContents>()

const fail = (name: string, message: string): Fail => ({ ok: false, name, message })
const notAllowed = (): Fail => fail('NotAllowedError', 'Запрос отклонён или истекло время ожидания.')

function finish(r: Req, res: Result): void {
  if (!reqs.has(r.key)) return
  reqs.delete(r.key)
  clearTimeout(r.timer)
  if (r.prompt) hooks.ui('passkey-prompt-close', r.prompt.id)
  r.done(res)
}

/** Уход со страницы и закрытие вкладки обрывают её запросы. */
function watch(wc: WebContents): void {
  if (watched.has(wc)) return
  watched.add(wc)
  const drop = (): void => {
    for (const r of [...reqs.values()]) if (r.wc === wc) finish(r, notAllowed())
  }
  wc.on('did-start-navigation', (d) => {
    if (d.isMainFrame && !d.isSameDocument) drop()
  })
  wc.once('destroyed', drop)
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

function descs(v: unknown): Desc[] | null {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.length > 64) return null
  const out: Desc[] = []
  for (const d of v) {
    const id = unb64u((d as { id?: unknown })?.id, 1023)
    if (!id) return null
    if ((d as { type?: unknown }).type === 'public-key') out.push({ id })
  }
  return out
}

function parseCreate(pk: Record<string, unknown>): CreateOpts | Fail {
  const user = (pk.user ?? {}) as Record<string, unknown>
  const userId = unb64u(user.id, 64)
  const challenge = unb64u(pk.challenge)
  if (!userId || !userId.length || !challenge) return fail('TypeError', 'Неверные параметры ключа доступа.')
  const params = Array.isArray(pk.pubKeyCredParams) ? (pk.pubKeyCredParams as { type?: unknown; alg?: unknown }[]).slice(0, 32) : []
  // Пустой список по стандарту значит «ES256 или RS256».
  const algs = params.length ? params.filter((p) => p?.type === 'public-key').map((p) => Number(p.alg)) : [-7, -257]
  const alg = algs.find((a) => SUPPORTED.includes(a))
  if (alg === undefined) return fail('NotSupportedError', 'Сайт просит алгоритм, которого нет у ключей Masaki.')
  const exclude = descs(pk.excludeCredentials)
  if (!exclude) return fail('TypeError', 'Неверный список ключей.')
  const sel = (pk.authenticatorSelection ?? {}) as Record<string, unknown>
  const ext = (pk.extensions ?? {}) as Record<string, unknown>
  return {
    rpName: str((pk.rp as Record<string, unknown> | undefined)?.name, 200),
    user: { id: userId, name: str(user.name, 200), displayName: str(user.displayName, 200) },
    challenge,
    alg,
    exclude,
    crossPlatform: sel.authenticatorAttachment === 'cross-platform',
    credProps: ext.credProps === true
  }
}

function parseGet(pk: Record<string, unknown>): GetOpts | Fail {
  const challenge = unb64u(pk.challenge)
  const allow = descs(pk.allowCredentials)
  if (!challenge || !allow) return fail('TypeError', 'Неверные параметры входа.')
  return { challenge, allow }
}

const clientData = (type: string, challenge: Buffer, origin: string): Buffer =>
  Buffer.from(JSON.stringify({ type, challenge: b64u(challenge), origin, crossOrigin: false }))

/** Флаги authenticatorData: UP — пользователь здесь, UV — подтвердил, BE/BS — ключ синхронизируемый. */
function flags(attested: boolean): number {
  return 0x01 | 0x04 | 0x08 | (hooks.backedUp() ? 0x10 : 0) | (attested ? 0x40 : 0)
}

function account(k: Passkey): PasskeyPrompt['accounts'][number] {
  return { id: k.id, userName: k.userName, displayName: k.displayName }
}

/**
 * Запрос страницы (op: create | get | abort). Ответ — JSON для скрипта страницы: готовые данные
 * ключа, ошибка WebAuthn или fallback — отдать запрос встроенному WebAuthn (ключ безопасности).
 */
export function request(wc: WebContents, origin: string | undefined, op: string, json: string): Promise<string> {
  return new Promise((resolve) => {
    const reply = (r: Result): void => resolve(JSON.stringify(r))
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(String(json)) as Record<string, unknown>
    } catch {
      return reply(fail('TypeError', 'Неверный запрос.'))
    }
    const reqId = str(msg.id, 64)
    const key = wc.id + ':' + reqId
    if (op === 'abort') {
      const r = reqs.get(key)
      if (r) finish(r, fail('AbortError', 'Запрос отменён.'))
      return reply(fail('AbortError', 'Запрос отменён.'))
    }
    if (op !== 'create' && op !== 'get') return reply(fail('NotSupportedError', 'Неизвестный запрос.'))
    const host = origin ? hostOf(origin) : null
    if (!origin || !host) return reply(fail('SecurityError', 'Ключи доступа работают только на защищённых сайтах.'))
    if (!safeStorage.isEncryptionAvailable()) return reply({ fallback: true })
    const pk = (msg.publicKey ?? {}) as Record<string, unknown>
    const rpRaw = op === 'create' ? (pk.rp as Record<string, unknown> | undefined)?.id : pk.rpId
    const rpId = (typeof rpRaw === 'string' && rpRaw ? rpRaw : host).toLowerCase()
    if (!rpAllowed(rpId, host)) return reply(fail('SecurityError', `Сайт ${host} не может работать с ключами для ${rpId}.`))
    const conditional = op === 'get' && msg.mediation === 'conditional'

    // Одновременно — один запрос на вкладку; новый запрос снимает ожидающий из автозаполнения.
    for (const r of [...reqs.values()]) {
      if (r.wc !== wc) continue
      if (r.conditional) finish(r, fail('AbortError', 'Запрос заменён новым.'))
      else return reply(fail('NotAllowedError', 'Уже идёт другой запрос ключа доступа.'))
    }

    const r: Req = { key, reqId, wc, kind: op, conditional, origin, rpId, candidates: [], done: reply }
    if (op === 'create') {
      const o = parseCreate(pk)
      if ('ok' in o) return reply(o)
      // Сайт просит именно ключ безопасности — это к встроенному WebAuthn.
      if (o.crossPlatform) return reply({ fallback: true })
      r.create = o
    } else {
      const o = parseGet(pk)
      if ('ok' in o) return reply(o)
      r.get = o
      const allow = new Set(o.allow.map((d) => b64u(d.id)))
      r.candidates = live()
        .filter((k) => k.rpId === rpId && (!allow.size || allow.has(k.credId)))
        .sort((a, b) => b.used - a.used || b.created - a.created)
    }
    reqs.set(key, r)
    watch(wc)
    if (conditional) return // ждёт выбора в списке у поля входа, без таймаута — как в Chrome

    const timeout = Math.min(Math.max(Number(pk.timeout) || 300_000, 30_000), 600_000)
    r.timer = setTimeout(() => finish(r, notAllowed()), timeout)
    let kind: PasskeyPrompt['kind'] = op
    if (r.create) {
      const ex = new Set(r.create.exclude.map((d) => b64u(d.id)))
      if (live().some((k) => k.rpId === rpId && ex.has(k.credId))) kind = 'exists'
    } else if (!r.candidates.length) kind = 'none'
    r.prompt = {
      id: key,
      wcId: wc.id,
      kind,
      rpId,
      user: r.create ? { name: r.create.user.name, displayName: r.create.user.displayName } : undefined,
      accounts: r.candidates.map(account),
      synced: hooks.backedUp()
    }
    hooks.ui('passkey-prompt', r.prompt)
  })
}

function doCreate(r: Req): Result {
  const o = r.create!
  const { privateKey, publicKey } = generate(o.alg)
  const credId = crypto.randomBytes(16)
  const authData = Buffer.concat([
    sha256(r.rpId),
    Buffer.from([flags(true)]),
    u32(0), // счётчик всегда 0: ключ синхронизируется, счётчик между устройствами смысла не имеет
    AAGUID,
    u16(credId.length),
    credId,
    coseKey(o.alg, publicKey)
  ])
  const attestation = cbor({ map: [['fmt', 'none'], ['attStmt', { map: [] }], ['authData', authData]] })
  const cd = clientData('webauthn.create', o.challenge, r.origin)
  const now = Date.now()
  const userHandle = b64u(o.user.id)
  // Тот же пользователь на том же сайте — новый ключ заменяет старый (так требует WebAuthn).
  for (const k of live()) {
    if (k.rpId === r.rpId && k.userHandle === userHandle) Object.assign(k, { deleted: true, key: '', userName: '', displayName: '', t: now })
  }
  const pkcs8 = (privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64')
  data.keys.push({
    id: 'pk' + crypto.randomBytes(9).toString('base64url'),
    rpId: r.rpId,
    credId: b64u(credId),
    userHandle,
    userName: o.user.name,
    displayName: o.user.displayName,
    alg: o.alg,
    key: safeStorage.encryptString(pkcs8).toString('base64'),
    created: now,
    used: now,
    t: now
  })
  persist()
  const id = b64u(credId)
  return {
    ok: true,
    cred: {
      id,
      rawId: id,
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: b64u(cd),
        attestationObject: b64u(attestation),
        authenticatorData: b64u(authData),
        publicKey: b64u(publicKey.export({ type: 'spki', format: 'der' }) as Buffer),
        publicKeyAlgorithm: o.alg,
        transports: ['hybrid', 'internal']
      },
      clientExtensionResults: o.credProps ? { credProps: { rk: true } } : {}
    }
  }
}

function doGet(r: Req, k: Passkey): Result {
  const authData = Buffer.concat([sha256(r.rpId), Buffer.from([flags(false)]), u32(0)])
  const cd = clientData('webauthn.get', r.get!.challenge, r.origin)
  const sig = sign(k, Buffer.concat([authData, sha256(cd)]))
  if (!sig) return fail('NotAllowedError', 'Ключ не расшифровался — он создан под другой учётной записью Windows.')
  k.used = Date.now()
  file.write(data, 1000)
  return {
    ok: true,
    cred: {
      id: k.credId,
      rawId: k.credId,
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: b64u(cd),
        authenticatorData: b64u(authData),
        signature: b64u(sig),
        userHandle: k.userHandle
      },
      clientExtensionResults: {}
    }
  }
}

/** Ответ пользователя в окне Masaki. other — отдать запрос встроенному WebAuthn (ключ безопасности). */
export function answer(promptId: string, action: 'ok' | 'cancel' | 'other', recordId?: string): void {
  const r = reqs.get(String(promptId))
  if (!r || r.conditional) return
  if (action === 'cancel') return finish(r, notAllowed())
  if (action === 'other') return finish(r, { fallback: true })
  if (r.prompt?.kind === 'exists') return finish(r, fail('InvalidStateError', 'Ключ доступа для этого аккаунта уже есть.'))
  if (r.prompt?.kind === 'none') return finish(r, notAllowed())
  if (r.kind === 'create') return finish(r, doCreate(r))
  const k = r.candidates.find((x) => x.id === recordId && !x.deleted)
  if (k) finish(r, doGet(r, k))
}

/** Ключи для списка автозаполнения — если страница ждёт вход по ключу (mediation: conditional). */
export function conditionalItems(wc: WebContents): AutofillItem[] {
  const r = [...reqs.values()].find((x) => x.wc === wc && x.conditional)
  if (!r) return []
  return r.candidates.filter((k) => !k.deleted).map((k) => ({ id: k.id, username: k.userName || k.displayName, host: r.rpId, passkey: true }))
}

/** Выбор ключа в списке автозаполнения у поля входа. */
export function useConditional(wc: WebContents, recordId: string): void {
  const r = [...reqs.values()].find((x) => x.wc === wc && x.conditional)
  const k = r?.candidates.find((x) => x.id === recordId && !x.deleted)
  if (!r || !k) return
  finish(r, doGet(r, k))
  if (!wc.isDestroyed()) wc.send('pk:used')
}

// ---------- Менеджер ----------

export function list(): PasskeyItem[] {
  return live()
    .map((k) => ({ id: k.id, rpId: k.rpId, userName: k.userName, displayName: k.displayName, created: k.created, used: k.used }))
    .sort((a, b) => a.rpId.localeCompare(b.rpId) || a.userName.localeCompare(b.userName))
}

export function remove(id: string): void {
  const k = data.keys.find((x) => x.id === id)
  if (!k || k.deleted) return
  Object.assign(k, { deleted: true, key: '', userName: '', displayName: '', t: Date.now() })
  persist()
}

// ---------- Для синхронизации ----------

/** Ключ для сейфа синхронизации: закрытый ключ открытым текстом, шифрует его уже ключ пользователя. */
export interface PlainPasskey {
  kind: 'passkey'
  id: string
  t: number
  deleted?: boolean
  rpId: string
  credId: string
  userHandle: string
  userName: string
  displayName: string
  alg: number
  /** Закрытый ключ PKCS#8 DER, base64url. */
  key: string
  created: number
}

export const isPlainPasskey = (x: object): x is PlainPasskey => (x as { kind?: unknown }).kind === 'passkey'

export function syncExport(): PlainPasskey[] {
  return data.keys.map((k) => {
    let key = ''
    if (!k.deleted) {
      try {
        key = Buffer.from(safeStorage.decryptString(Buffer.from(k.key, 'base64')), 'base64').toString('base64url')
      } catch {
        key = ''
      }
    }
    return {
      kind: 'passkey',
      id: k.id,
      t: k.t,
      deleted: k.deleted,
      rpId: k.rpId,
      credId: k.credId,
      userHandle: k.userHandle,
      userName: k.userName,
      displayName: k.displayName,
      alg: k.alg,
      key,
      created: k.created
    }
  })
}

export function syncApply(items: PlainPasskey[]): void {
  let changed = false
  for (const r of items) {
    const k = data.keys.find((x) => x.id === r.id)
    if (k && k.t >= r.t) continue
    if (!r.deleted && (!r.key || !SUPPORTED.includes(r.alg) || typeof r.rpId !== 'string')) continue
    const next: Passkey = {
      id: r.id,
      rpId: r.rpId,
      credId: r.credId,
      userHandle: r.userHandle,
      userName: r.deleted ? '' : r.userName,
      displayName: r.deleted ? '' : r.displayName,
      alg: r.alg,
      key: r.deleted ? '' : safeStorage.encryptString(Buffer.from(r.key, 'base64url').toString('base64')).toString('base64'),
      created: r.created || r.t,
      used: k?.used ?? 0,
      t: r.t,
      deleted: r.deleted || undefined
    }
    if (k) Object.assign(k, next)
    else data.keys.push(next)
    changed = true
  }
  if (!changed) return
  file.write(data, 200)
  hooks.ui('passkeys-changed')
}
