// Автозаполнение адресов, телефонов, почты и платёжных карт — как у Chrome.
// Адреса хранятся открыто (это не секрет), номер карты — зашифрованным Windows (safeStorage, DPAPI),
// в интерфейсе видны только последние 4 цифры. В сейф синхронизации записи уходят как есть: каждая
// запись там шифруется ключом пользователя (sync.ts), отдельного шифрования не нужно.
// Подстановка: поле с autocomplete="name|email|tel|street-address|postal-code|…" показывает список,
// выбор заполняет все поля формы сразу (в карточке — номер, срок, имя держателя).

import { safeStorage, webContents } from 'electron'
import crypto from 'crypto'
import { JsonFile } from './store'
import type { AddressItem, CardItem } from '../shared/types'

export interface Address {
  id: string
  t: number
  deleted?: boolean
  name: string
  organization: string
  street: string
  city: string
  state: string
  zip: string
  country: string
  phone: string
  email: string
}

export interface Card {
  id: string
  t: number
  deleted?: boolean
  holder: string
  /** Полный номер, зашифрованный Windows (safeStorage), в base64. */
  number: string
  /** Последние 4 цифры — открыто, для списка и проверки. */
  last4: string
  expMonth: number
  expYear: number
  nick: string
}

interface Data {
  v: 1
  addresses: Address[]
  cards: Card[]
}

export interface AutofillHooks {
  ui(channel: string, payload?: unknown): void
  /** Записи поменялись — синхронизации пора отправить изменения. */
  changed(): void
}

const file = new JsonFile<Data>('autofill.json')
let data: Data = { v: 1, addresses: [], cards: [] }
let hooks: AutofillHooks

export async function initAutofill(h: AutofillHooks): Promise<void> {
  hooks = h
  const saved = await file.read()
  if (saved && Array.isArray(saved.addresses)) data = { v: 1, addresses: saved.addresses, cards: saved.cards ?? [] }
}

export function flushAutofill(): void {
  file.flushSync()
}

function persist(): void {
  file.write(data, 200)
  hooks.ui('autofill-changed')
  hooks.changed()
}

const encrypt = (n: string): string => safeStorage.encryptString(n).toString('base64')
const decrypt = (c: Card): string | null => {
  try {
    return safeStorage.decryptString(Buffer.from(c.number, 'base64'))
  } catch {
    return null
  }
}

const liveA = (): Address[] => data.addresses.filter((a) => !a.deleted)
const liveC = (): Card[] => data.cards.filter((c) => !c.deleted)

const digits = (s: string): string => s.replace(/\D/g, '')

/** Лунн — проверка номера карты: опечатку ловим до сохранения. */
export function luhn(num: string): boolean {
  const d = digits(num)
  if (d.length < 12 || d.length > 19) return false
  let sum = 0
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i])
    if (i % 2 === 1) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
  }
  return sum % 10 === 0
}

const addressItem = (a: Address): AddressItem => ({
  id: a.id,
  name: a.name,
  summary: [a.street, a.city, a.zip].filter(Boolean).join(', ') || a.name || 'адрес',
  phone: a.phone,
  email: a.email,
  organization: a.organization,
  street: a.street,
  city: a.city,
  state: a.state,
  zip: a.zip,
  country: a.country
})

const cardItem = (c: Card): CardItem => ({
  id: c.id,
  nick: c.nick,
  holder: c.holder,
  last4: c.last4,
  expMonth: c.expMonth,
  expYear: c.expYear
})

export function listAddresses(): AddressItem[] {
  return liveA().map(addressItem)
}

export function listCards(): CardItem[] {
  return liveC().map(cardItem)
}

const id = (): string => 'af' + crypto.randomBytes(9).toString('base64url')

export function saveAddress(p: Partial<Address> & { id?: string }): { ok: boolean; error?: string } {
  const clean = (v: unknown): string => String(v ?? '').trim().slice(0, 200)
  const next: Address = {
    id: p.id ?? id(),
    t: Date.now(),
    name: clean(p.name),
    organization: clean(p.organization),
    street: clean(p.street),
    city: clean(p.city),
    state: clean(p.state),
    zip: clean(p.zip),
    country: clean(p.country),
    phone: clean(p.phone),
    email: clean(p.email)
  }
  if (!next.name && !next.street && !next.phone && !next.email) return { ok: false, error: 'Пустой адрес сохранять нечего' }
  const i = data.addresses.findIndex((a) => a.id === next.id)
  if (i >= 0) Object.assign(data.addresses[i], { ...next, t: Date.now() })
  else data.addresses.push(next)
  persist()
  return { ok: true }
}

export function saveCard(p: { id?: string; holder?: unknown; number?: unknown; exp?: unknown; nick?: unknown }): { ok: boolean; error?: string } {
  const holder = String(p.holder ?? '').trim().slice(0, 200)
  const num = digits(String(p.number ?? ''))
  const exp = String(p.exp ?? '').trim()
  const m = /^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/.exec(exp)
  if (!holder && !num) return { ok: false, error: 'Пустую карту сохранять нечего' }
  let expMonth = 0
  let expYear = 0
  if (m) {
    expMonth = Math.min(12, Math.max(1, Number(m[1])))
    expYear = Number(m[2])
    if (expYear < 100) expYear += 2000
    if (expMonth < 1 || expYear < 2024 || expYear > 2100) return { ok: false, error: 'Неверный срок действия' }
  } else if (exp) return { ok: false, error: 'Срок — в виде ММ/ГГ' }
  const prev = p.id ? data.cards.find((c) => c.id === p.id) : undefined
  // Номер меняют только если ввели новый: в форме редактирования поле может остаться пустым.
  const number = num ? num : prev ? (decrypt(prev) ?? '') : ''
  if (num && !luhn(num)) return { ok: false, error: 'Номер не похож на карту (проверка Луна)' }
  const next: Card = {
    id: p.id ?? id(),
    t: Date.now(),
    holder,
    number: number ? encrypt(number) : (prev?.number ?? ''),
    last4: number ? number.slice(-4) : (prev?.last4 ?? ''),
    expMonth,
    expYear,
    nick: String(p.nick ?? '').trim().slice(0, 60)
  }
  if (!next.number && !next.holder) return { ok: false, error: 'Пустую карту сохранять нечего' }
  const i = data.cards.findIndex((c) => c.id === next.id)
  if (i >= 0) data.cards[i] = next
  else data.cards.push(next)
  persist()
  return { ok: true }
}

export function remove(kind: 'address' | 'card', recordId: string): void {
  const list = kind === 'address' ? data.addresses : data.cards
  const item = list.find((x) => x.id === recordId)
  if (!item || item.deleted) return
  item.deleted = true
  item.t = Math.max(Date.now(), item.t + 1)
  if (kind === 'card') (item as Card).number = ''
  persist()
}

/** Полный номер для оплаты: уходит на страницу только после выбора карты пользователем. */
export function cardNumber(recordId: string): string | null {
  const c = liveC().find((x) => x.id === recordId)
  return c ? decrypt(c) : null
}

export function getAddress(recordId: string): Address | null {
  return liveA().find((x) => x.id === recordId) ?? null
}

// ---------- Синхронизация: те же записи в сейфе на Диске ----------

export type PlainAutofill =
  | ({ kind: 'address' } & Address)
  | ({ kind: 'card' } & Omit<Card, 'number'> & { number: string })

export const isPlainAddress = (x: object): x is { kind: 'address' } & Address => (x as { kind?: unknown }).kind === 'address'
export const isPlainCard = (x: object): x is { kind: 'card' } & Omit<Card, 'number'> & { number: string } =>
  (x as { kind?: unknown }).kind === 'card'

export function syncExport(): PlainAutofill[] {
  return [
    ...data.addresses.map((a) => ({ kind: 'address' as const, ...a })),
    // Полный номер карты уходит на Диск уже зашифрованным ключом сейфа (sync.ts шифрует каждую запись).
    ...data.cards.map((c) => ({ kind: 'card' as const, ...c, number: c.deleted ? '' : decrypt(c) ?? '' }))
  ]
}

export function syncApply(items: PlainAutofill[]): void {
  let changed = false
  for (const r of items) {
    if (isPlainAddress(r)) {
      const a = data.addresses.find((x) => x.id === r.id)
      if (a && a.t >= r.t) continue
      const { kind: _kind, ...rest } = r
      const next: Address = rest
      if (a) Object.assign(a, next)
      else data.addresses.push(next)
      changed = true
    } else if (isPlainCard(r)) {
      const c = data.cards.find((x) => x.id === r.id)
      if (c && c.t >= r.t) continue
      const num = r.deleted ? '' : String(r.number ?? '')
      const next: Card = {
        id: r.id,
        t: r.t,
        deleted: r.deleted || undefined,
        holder: r.holder ?? '',
        number: num ? encrypt(num) : '',
        last4: num ? num.slice(-4) : (r.last4 ?? ''),
        expMonth: r.expMonth ?? 0,
        expYear: r.expYear ?? 0,
        nick: r.nick ?? ''
      }
      if (c) Object.assign(c, next)
      else data.cards.push(next)
      changed = true
    }
  }
  if (changed) persist()
}

// ---------- Подстановка в страницу ----------

/** Адрес значениями по autocomplete-атрибутам: заполнит и «name», и «fname»-подобные поля. */
export function addressValues(a: Address): Record<string, string> {
  let countryName = a.country
  if (/^[a-z]{2}$/i.test(a.country)) {
    try { countryName = new Intl.DisplayNames(['ru'], { type: 'region' }).of(a.country.toUpperCase()) ?? a.country } catch { /* своё название страны */ }
  }
  return {
    name: a.name,
    'given-name': a.name.split(' ')[0] ?? '',
    'family-name': a.name.split(' ').slice(1).join(' '),
    fname: a.name.split(' ')[0] ?? '',
    lname: a.name.split(' ').slice(1).join(' '),
    organization: a.organization,
    'organization-title': '',
    'street-address': a.street,
    'address-line1': a.street.split('\n')[0] ?? a.street,
    'address-line2': a.street.split('\n')[1] ?? '',
    'address-line3': a.street.split('\n')[2] ?? '',
    'address-level1': a.state,
    'address-level2': a.city,
    'address-level3': '',
    'postal-code': a.zip,
    country: a.country,
    'country-name': countryName,
    tel: a.phone,
    email: a.email
  }
}

export function cardValues(number: string, c: Card): Record<string, string> {
  return {
    'cc-name': c.holder,
    'cc-number': number,
    'cc-exp': c.expMonth && c.expYear ? `${String(c.expMonth).padStart(2, '0')}/${String(c.expYear).slice(-2)}` : '',
    'cc-exp-month': c.expMonth ? String(c.expMonth) : '',
    'cc-exp-year': c.expYear ? (c.expYear > 100 ? String(c.expYear) : String(2000 + c.expYear)) : '',
    'cc-csc': '',
    'cc-additional-name': '',
    'cc-family-name': c.holder.split(' ').slice(1).join(' '),
    'cc-given-name': c.holder.split(' ')[0] ?? '',
    'cc-type': ''
  }
}

/** Заполнить поля формы вкладки (wcId) значениями выбранной записи. */
export function fill(wcId: number, kind: 'address' | 'card', recordId: string, frame?: Electron.WebFrameMain): void {
  const wc = webContents.fromId(wcId)
  if (!wc || wc.isDestroyed() || wc.getType() !== 'webview') return
  let values: Record<string, string> | null = null
  if (kind === 'address') {
    const a = getAddress(recordId)
    if (a) values = addressValues(a)
  } else {
    const c = liveC().find((x) => x.id === recordId)
    const num = c ? decrypt(c) : null
    if (c && num != null) values = cardValues(num, c)
  }
  if (values) {
    if (frame) frame.send('af:fill', values)
    else wc.send('af:fill', values)
  }
}
