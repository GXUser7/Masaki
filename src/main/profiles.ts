// Профили, как в Chrome: у каждого свои входы на сайты (куки), вкладки, история, настройки, пароли,
// синхронизация и расширения. Профиль — отдельная папка данных и отдельный процесс Masaki со своим окном:
// блокировка «одной копии» у Electron — по папке данных, так что окна разных профилей живут рядом, а
// повторный запуск того же профиля просто показывает его окно. Основной профиль — сама папка Masaki,
// остальные — Profiles/<id> в ней. Список (имя, аватар аккаунта Google, цвет) — profiles.json там же.

import { app } from 'electron'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { GoogleAccount, ProfileInfo } from '../shared/types'

interface Stored {
  id: string
  name: string
  email: string
  photo: string
  color: string
  /** Имя задали руками — аккаунт Google его больше не меняет. */
  custom: boolean
  created: number
}

/** Цвета буквы профиля без аватара — те же светлые тона, что у групп вкладок. */
const COLORS = ['#7FD1A8', '#7FB3F0', '#E9C46A', '#F28B82', '#C3A6F5', '#F5A3C7', '#7DD3E0', '#F6B26B']
const ID = /^[a-f0-9]{12}$/

let base = ''
let current = 'default'
/** Окно инкогнито: временная папка данных, ничего из неё не остаётся после закрытия. */
let incognito = false
/** Папка профиля, из которого открыли инкогнито: оттуда берём вид (настройки, обои). */
let sourceDir = ''

const dirOf = (id: string): string => (id === 'default' ? base : path.join(base, 'Profiles', id))
const listFile = (): string => path.join(base, 'profiles.json')

/**
 * До готовности приложения: base — папка основного профиля; --profile=<id> переключает папку данных.
 * Только на уже созданный профиль — произвольную папку так не подсунуть.
 */
export function initProfile(baseDir: string, argv: string[]): void {
  base = baseDir
  const arg = argv.find((a) => a.startsWith('--profile='))?.slice('--profile='.length) ?? ''
  if (ID.test(arg) && fs.existsSync(dirOf(arg))) {
    current = arg
    app.setPath('userData', dirOf(arg))
  }
  // Инкогнито, как в Chrome, — отдельное окно со своими куками, которые живут, пока оно открыто. У Masaki это
  // отдельный процесс со своей папкой данных: у каждого профиля одна, поэтому все окна инкогнито профиля —
  // одно окно (повторный запуск отдаёт ссылку ему), а блокировка «одной копии» не мешает основному окну.
  if (argv.includes('--incognito')) {
    incognito = true
    sourceDir = dirOf(current)
    const dir = process.env.MASAKI_PROFILE
      ? path.join(base, 'Incognito-' + current)
      : path.join(app.getPath('temp'), 'Masaki Incognito', app.getName() + '-' + current)
    fs.mkdirSync(dir, { recursive: true })
    app.setPath('userData', dir)
  }
}

export const currentProfile = (): string => current
export const isIncognito = (): boolean => incognito

/** Свои у окна только эти файлы: что бы ни осталось в папке, всё остальное — данные прошлого инкогнито. */
const LOCKS = /^(lockfile|Singleton)/

/**
 * Окно инкогнито получило папку (блокировка «одной копии» уже у нас): стираем всё, что осталось от прошлого
 * раза (Masaki мог упасть), и берём из профиля только вид — настройки, обои, размер окна. Ни истории, ни
 * паролей, ни входов на сайты.
 */
export function prepareIncognito(): void {
  if (!incognito) return
  const dir = app.getPath('userData')
  for (const name of fs.readdirSync(dir)) {
    if (LOCKS.test(name)) continue
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true })
    } catch {
      // файл держит другая программа (антивирус) — не страшно, данных сайтов в нём уже нет
    }
  }
  try {
    for (const name of fs.readdirSync(sourceDir)) {
      const look = ['settings.json', 'favicons.json', 'window.json'].includes(name) || name.startsWith('custom-wallpaper.')
      if (look) fs.copyFileSync(path.join(sourceDir, name), path.join(dir, name))
    }
  } catch {
    // у нового профиля настроек ещё нет — будут настройки по умолчанию
  }
}

/** Закрывается окно инкогнито: удаляем файлы Masaki (вкладки, загрузки, настройки) — Chromium свои держит до выхода. */
export function wipeIncognitoFiles(): void {
  if (!incognito) return
  const dir = app.getPath('userData')
  for (const name of fs.readdirSync(dir)) {
    if (!/\.(json|tmp)$/.test(name) && !name.startsWith('custom-wallpaper.')) continue
    try {
      fs.rmSync(path.join(dir, name), { force: true })
    } catch {
      // удалится при следующем открытии инкогнито
    }
  }
}

/** Открыть окно инкогнито этого профиля (уже открыто — получит адрес новой вкладкой). */
export function openIncognito(url?: string): void {
  const args = [
    ...selfArgs(),
    ...(current === 'default' ? [] : [`--profile=${current}`]),
    '--incognito',
    ...(url && /^(https?|file):\/\//i.test(url) ? [url] : [])
  ]
  spawn(process.execPath, args, { detached: true, stdio: 'ignore', env: process.env }).unref()
}

function read(): Stored[] {
  let list: Stored[] = []
  try {
    const d = JSON.parse(fs.readFileSync(listFile(), 'utf8')) as { profiles?: Stored[] }
    if (Array.isArray(d.profiles)) list = d.profiles.filter((p) => p && (p.id === 'default' || (ID.test(p.id) && fs.existsSync(dirOf(p.id)))))
  } catch {
    // списка ещё нет — есть только основной профиль
  }
  if (!list.some((p) => p.id === 'default')) {
    list.unshift({ id: 'default', name: 'Основной', email: '', photo: '', color: COLORS[0], custom: false, created: 0 })
  }
  return list
}

/** Пишут несколько окон-процессов: атомарно, через временный файл. */
function write(list: Stored[]): void {
  const tmp = `${listFile()}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, profiles: list }, null, 1))
  fs.renameSync(tmp, listFile())
}

export function listProfiles(): ProfileInfo[] {
  return read().map((p) => ({ id: p.id, name: p.name, email: p.email, photo: p.photo, color: p.color, current: p.id === current }))
}

/** Аккаунт Google этого профиля → аватар и (если имя не меняли руками) имя в списке, как в Chrome. */
export function noteAccount(a: GoogleAccount | undefined): void {
  // Вход в Google в окне инкогнито — не аккаунт профиля.
  if (incognito) return
  const list = read()
  const me = list.find((p) => p.id === current)
  if (!me) return
  const next = {
    email: a?.email ?? '',
    photo: a?.photo ?? '',
    name: me.custom || !a ? me.name : a.name || a.email.split('@')[0]
  }
  if (me.email === next.email && me.photo === next.photo && me.name === next.name) return
  Object.assign(me, next)
  write(list)
}

/** Начало командной строки новой копии Masaki: путь к проекту в разработке и ключ песочницы, как у этой копии. */
function selfArgs(): string[] {
  return [...(app.isPackaged ? [] : [app.getAppPath()]), ...(app.commandLine.hasSwitch('no-sandbox') ? ['--no-sandbox'] : [])]
}

/** Открыть окно профиля. Уже открыт — новая копия передаст управление его окну и закроется. */
export function openProfile(id: string): void {
  if (id !== 'default' && !ID.test(id)) return
  const args = [...selfArgs(), ...(id === 'default' ? [] : [`--profile=${id}`])]
  spawn(process.execPath, args, { detached: true, stdio: 'ignore' }).unref()
}

export function createProfile(): ProfileInfo {
  const list = read()
  const id = crypto.randomBytes(6).toString('hex')
  fs.mkdirSync(dirOf(id), { recursive: true })
  const p: Stored = {
    id,
    name: `Профиль ${list.length + 1}`,
    email: '',
    photo: '',
    color: COLORS[list.length % COLORS.length],
    custom: false,
    created: Date.now()
  }
  write([...list, p])
  openProfile(id)
  return { id, name: p.name, email: '', photo: '', color: p.color, current: false }
}

export function renameProfile(id: string, name: string): void {
  name = name.trim().slice(0, 40)
  const list = read()
  const p = list.find((x) => x.id === id)
  if (!p || !name) return
  p.name = name
  p.custom = true
  write(list)
}

/**
 * Открытый профиль удалять нельзя: Chromium держит его файлы, удаление прошло бы наполовину. Признак —
 * lockfile в папке профиля: пока Masaki с этим профилем работает, Windows не даёт его удалить.
 */
export async function removeProfile(id: string): Promise<{ ok: boolean; error?: string }> {
  if (!ID.test(id) || id === current) return { ok: false, error: 'Этот профиль удалить нельзя' }
  const dir = dirOf(id)
  try {
    await fs.promises.rm(path.join(dir, 'lockfile'), { force: true })
  } catch {
    return { ok: false, error: 'Профиль открыт в другом окне — закройте его и попробуйте снова' }
  }
  try {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 })
  } catch (e) {
    return { ok: false, error: 'Не все файлы профиля удалились: ' + (e instanceof Error ? e.message : String(e)) }
  }
  write(read().filter((p) => p.id !== id))
  return { ok: true }
}
