// Masaki в списке браузеров Windows («Приложения по умолчанию»). Windows 10/11 не дают программе самой
// стать браузером по умолчанию — выбирает пользователь в Параметрах. Программа лишь сообщает, что умеет
// открывать http/https и .html: так делает установщик Chrome, только здесь всё в HKCU, без прав администратора.

import { app, shell } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { DefaultBrowserState } from '../shared/types'

// Имя для тестов другое, чтобы они не трогали настоящую регистрацию и не открывали Параметры.
const TEST_NAME = process.env.MASAKI_REG_NAME
const NAME = TEST_NAME || 'Masaki'
const CLIENT = `Software\\Clients\\StartMenuInternet\\${NAME}`
const PROG_URL = `${NAME}URL`
const PROG_HTML = `${NAME}HTML`
const FILES = ['.htm', '.html', '.shtml', '.xht', '.xhtml', '.pdf', '.svg', '.webp']

function reg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('reg', args, { windowsHide: true }, (err, out) => (err ? reject(err) : resolve(String(out))))
  )
}

/** Значение из `reg query`: строка вида «    ProgId    REG_SZ    MasakiURL». */
async function regValue(key: string, name: string | null): Promise<string | null> {
  try {
    const out = await reg(['query', `HKCU\\${key}`, ...(name ? ['/v', name] : ['/ve'])])
    const m = out.match(/REG_\w+\s+(.*)$/m)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

/** Строка .reg: обратные косые и кавычки экранируются. */
const q = (s: string): string => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'

function registryScript(exe: string): string {
  const icon = `${exe},0`
  const out = ['Windows Registry Editor Version 5.00', '']
  const key = (k: string, values: Record<string, string>): void => {
    out.push(`[HKEY_CURRENT_USER\\${k}]`)
    for (const [n, v] of Object.entries(values)) out.push(`${n === '@' ? '@' : q(n)}=${q(v)}`)
    out.push('')
  }
  key(CLIENT, { '@': NAME })
  key(`${CLIENT}\\DefaultIcon`, { '@': icon })
  key(`${CLIENT}\\shell\\open\\command`, { '@': `"${exe}"` })
  key(`${CLIENT}\\Capabilities`, {
    ApplicationName: NAME,
    ApplicationDescription: 'Браузер на Chromium — матовое стекло и Material 3 Expressive',
    ApplicationIcon: icon
  })
  key(`${CLIENT}\\Capabilities\\StartMenu`, { StartMenuInternet: NAME })
  key(`${CLIENT}\\Capabilities\\URLAssociations`, { http: PROG_URL, https: PROG_URL })
  key(`${CLIENT}\\Capabilities\\FileAssociations`, Object.fromEntries(FILES.map((e) => [e, PROG_HTML])))
  key('Software\\RegisteredApplications', { [NAME]: `${CLIENT}\\Capabilities` })
  for (const [prog, title, isUrl] of [
    [PROG_URL, `${NAME} URL`, true],
    [PROG_HTML, `Документ ${NAME}`, false]
  ] as const) {
    key(`Software\\Classes\\${prog}`, { '@': title, ...(isUrl ? { 'URL Protocol': '' } : {}) })
    key(`Software\\Classes\\${prog}\\Application`, { ApplicationName: NAME, ApplicationIcon: icon })
    key(`Software\\Classes\\${prog}\\DefaultIcon`, { '@': icon })
    key(`Software\\Classes\\${prog}\\shell\\open\\command`, { '@': `"${exe}" "%1"` })
  }
  // «Открыть с помощью» для файлов страниц.
  for (const ext of FILES) key(`Software\\Classes\\${ext}\\OpenWithProgids`, { [PROG_HTML]: '' })
  return out.join('\r\n')
}

async function register(): Promise<void> {
  // reg import понимает UTF-16 с BOM — так в .reg не ломаются русские буквы и пути.
  const file = path.join(app.getPath('temp'), `masaki-browser-${process.pid}.reg`)
  fs.writeFileSync(file, '﻿' + registryScript(process.execPath), 'utf16le')
  try {
    await reg(['import', file])
  } finally {
    fs.rmSync(file, { force: true })
  }
}

const canRegister = (): boolean => process.platform === 'win32' && (app.isPackaged || !!TEST_NAME)

async function registeredExe(): Promise<string | null> {
  return regValue(`${CLIENT}\\shell\\open\\command`, null)
}

/**
 * При запуске собранного Masaki: зарегистрироваться, если ещё нет или папку перенесли (путь в
 * реестре устарел). Так Masaki сразу есть в списке браузеров, как после установщика.
 */
export async function refreshRegistration(): Promise<void> {
  if (!canRegister() || process.env.MASAKI_PROFILE) return
  if ((await registeredExe()) === `"${process.execPath}"`) return
  await register().catch((e) => console.error('Не удалось зарегистрировать Masaki как браузер', e))
}

export async function defaultBrowserState(): Promise<DefaultBrowserState> {
  if (process.platform !== 'win32') return { supported: false, registered: false, isDefault: false }
  const registered = (await registeredExe()) !== null
  // Windows 11 24H2 хранит выбор в UserChoiceLatest, раньше — в UserChoice.
  const base = 'Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https'
  const prog = (await regValue(`${base}\\UserChoiceLatest`, 'ProgId')) ?? (await regValue(`${base}\\UserChoice`, 'ProgId'))
  return { supported: true, registered, isDefault: prog === PROG_URL }
}

/** Зарегистрироваться (если надо) и открыть страницу Masaki в «Приложениях по умолчанию». */
export async function makeDefault(): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'win32') return { ok: false, error: 'Только для Windows' }
  if (!canRegister()) return { ok: false, error: 'Работает у собранного Masaki (npm run pack), а не в режиме разработки' }
  try {
    await register()
  } catch (e) {
    return { ok: false, error: 'Windows не дал записать регистрацию: ' + (e instanceof Error ? e.message : String(e)) }
  }
  if (!TEST_NAME) await shell.openExternal(`ms-settings:defaultapps?registeredAppUser=${encodeURIComponent(NAME)}`)
  return { ok: true }
}
