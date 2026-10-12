// Обновления — как у браузеров: Masaki сам смотрит выпуски на GitHub (вскоре после запуска и раз в четыре
// часа), скачивает новую версию в фоне и ставит её при выходе — или сразу, по «Обновить Masaki»
// (перезапуск, вкладки вернутся из сессии). Так обновляется Masaki, поставленный установщиком: NSIS в
// папку пользователя, без прав администратора, тихо (/S) и с запуском новой версии после.
//
// Сборка без установщика (dist/win-unpacked) и Mac только узнают о новой версии и предлагают её скачать:
// первую обновлять нечем (её собирают и подменяют руками), а на Mac без подписи Apple Squirrel.Mac
// обновление не примет — подпись ad hoc у каждой сборки своя.
//
// Обновляет только основной профиль: у других профилей свои процессы, и скачивать одно и то же в каждом
// незачем. Установщик при обновлении закрывает все окна Masaki.

import { app } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import fs from 'fs'
import path from 'path'
import type { UpdateState } from '../shared/types'
import * as profiles from './profiles'

export const RELEASES = 'https://github.com/GXUser7/Masaki/releases'
/** Тесты подставляют свой сервер выпусков (latest.yml и установщик рядом) и короткую задержку. */
const FEED = process.env.MASAKI_UPDATE_URL
const FIRST_CHECK = Number(process.env.MASAKI_UPDATE_DELAY) || 15_000
const EVERY = 4 * 60 * 60_000

/** Поставлен установщиком: рядом с exe лежит его деинсталлятор. Иначе это папка сборки — её не обновить. */
function installed(): boolean {
  if (process.platform !== 'win32') return false
  try {
    return fs.readdirSync(path.dirname(process.execPath)).some((f) => /^Uninstall .+\.exe$/i.test(f))
  } catch {
    return false
  }
}

function modeOf(): Pick<UpdateState, 'mode' | 'note'> {
  if (profiles.currentProfile() !== 'default') return { mode: 'off', note: 'Обновления проверяет и скачивает основной профиль Masaki' }
  // Разработка и автотесты на GitHub не ходят.
  if (!FEED && (!app.isPackaged || process.env.MASAKI_PROFILE)) return { mode: 'off', note: 'Сборка для разработки — обновления выключены' }
  if (process.platform === 'win32') {
    return installed()
      ? { mode: 'auto' }
      : { mode: 'notify', note: 'Эта копия запущена без установщика, обновиться сама не может — новую версию Masaki предложит скачать.' }
  }
  if (process.platform === 'darwin') {
    return { mode: 'notify', note: 'Без подписи Apple Masaki не может обновиться сам — новую версию он предложит скачать.' }
  }
  return { mode: 'off', note: `Новые версии — на ${RELEASES.replace('https://', '')}` }
}

let state: UpdateState = { mode: 'off', status: 'idle', current: app.getVersion() }
let tell: (s: UpdateState) => void = () => undefined
let manual = false

function set(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
  tell(state)
}

export const updateState = (): UpdateState => state

export function initUpdater(onState: (s: UpdateState) => void): void {
  tell = onState
  const { mode, note } = modeOf()
  state = { mode, note, status: 'idle', current: app.getVersion() }
  if (mode === 'off') return
  if (FEED) {
    autoUpdater.setFeedURL({ provider: 'generic', url: FEED })
    autoUpdater.forceDevUpdateConfig = !app.isPackaged
  }
  autoUpdater.logger = null
  autoUpdater.autoDownload = mode === 'auto'
  autoUpdater.autoInstallOnAppQuit = mode === 'auto'
  autoUpdater.allowDowngrade = false

  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: undefined }))
  autoUpdater.on('update-not-available', () => set({ status: 'latest', checkedAt: Date.now() }))
  autoUpdater.on('update-available', (info: UpdateInfo) =>
    set({ status: mode === 'auto' ? 'downloading' : 'available', version: info.version, percent: 0, checkedAt: Date.now() })
  )
  autoUpdater.on('download-progress', (p: ProgressInfo) => set({ status: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => set({ status: 'ready', version: info.version, percent: 100 }))
  autoUpdater.on('error', (e: Error) => {
    // Скачанное и готовое не пропадает из-за сбоя следующей проверки.
    if (state.status === 'ready') return
    // Фоновая проверка без сети — не новость; ошибку видно, только если проверяли руками.
    set(manual ? { status: 'error', error: shortError(e) } : { status: state.version ? 'available' : 'idle' })
  })

  setTimeout(() => void check(false), FIRST_CHECK)
  setInterval(() => void check(false), EVERY)
}

function shortError(e: Error): string {
  const m = String(e?.message ?? e).split('\n')[0]
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|net::/i.test(m)) return 'нет связи с GitHub'
  return m.slice(0, 200)
}

/** Проверить сейчас. manual — пользователь нажал «Проверить»: тогда и ошибку покажем. */
export async function check(byHand = true): Promise<void> {
  if (state.mode === 'off' || state.status === 'downloading' || state.status === 'ready') return
  manual = byHand
  try {
    await autoUpdater.checkForUpdates()
  } catch {
    // уже пришло событием error
  }
}

/** «Обновить Masaki»: поставить скачанное и запустить новую версию. Окна закроются как при выходе — сессия сохранится. */
export function install(): boolean {
  if (state.mode !== 'auto' || state.status !== 'ready') return false
  // Тест запускает новую версию сам, в своём профиле: установщик запустил бы её с окружением Windows —
  // без MASAKI_PROFILE, то есть в профиле пользователя.
  autoUpdater.quitAndInstall(true, !process.env.MASAKI_UPDATE_NO_RELAUNCH)
  return true
}
