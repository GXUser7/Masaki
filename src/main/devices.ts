// Доступ к устройству и вход по паролю — то, что в Chrome рисует сам браузер, а в Masaki спрашивает
// интерфейс стеклянным окном: демонстрация экрана (getDisplayMedia), выбор USB/HID/Serial/Bluetooth
// устройства и HTTP/прокси-аутентификация. Права «usb/hid/serial/bluetooth/display-capture» выдаём
// без вопросов — сам выбор устройства и есть подтверждение, а лишний вопрос только мешает.

import { app, desktopCapturer, ipcMain, screen, session, webContents, type Session, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import type { AuthAsk, DeviceAsk, DisplayAsk, DisplaySource } from '../shared/types'

interface Hooks {
  ui(channel: string, payload?: unknown): void
  /** Вопросы имеют смысл только когда окно есть; без него сразу отвечаем отказом. */
  hasWindow(): boolean
  isUi(sender: WebContents): boolean
}

let hooks: Hooks

const displayAsks = new Map<string, { origin: string; audio: boolean; wcId?: number; done: (video: { id: string; name: string } | null) => void }>()
const deviceAsks = new Map<string, { ask: DeviceAsk; done: (deviceId: string) => void }>()
const authAsks = new Map<string, { meta: { host: string; realm: string; proxy: boolean; wcId?: number }; done: (username?: string, password?: string) => void }>()

/** Последний список источников: спрашивается редко, а снимки экрана недёшевы. */
let sourcesCache: DisplaySource[] = []

const displayList = (): DisplayAsk[] => [...displayAsks.entries()].map(([id, a]) => ({ id, origin: a.origin, audio: a.audio, wcId: a.wcId, sources: sourcesCache }))
const deviceList = (): DeviceAsk[] => [...deviceAsks.values()].map((a) => a.ask)
const authList = (): AuthAsk[] => [...authAsks.entries()].map(([id, a]) => ({ id, ...a.meta }))

function askDisplay(origin: string, audio: boolean, done: (video: { id: string; name: string } | null) => void, wcId?: number): void {
  const id = 'd' + randomUUID()
  displayAsks.set(id, { origin, audio, done, wcId })
  hooks.ui('display-ask', { id, origin, audio, wcId, sources: sourcesCache })
}

function askDevice(kind: DeviceAsk['kind'], label: string, origin: string, devices: { id: string; name: string }[], done: (deviceId: string) => void, wcId?: number): void {
  // Пустой список — спрашивать не о чем: отказ сразу (страница покажет обычную ошибку).
  if (!devices.length) return done('')
  const ask: DeviceAsk = { id: 'v' + randomUUID(), kind, label, origin, devices, wcId }
  deviceAsks.set(ask.id, { ask, done })
  hooks.ui('device-ask', ask)
}

export function answerDisplay(id: string, sourceId: string | null): void {
  const a = displayAsks.get(id)
  if (!a) return
  displayAsks.delete(id)
  const src = sourceId ? sourcesCache.find((s) => s.id === sourceId) : null
  a.done(src ? { id: src.id, name: src.name } : null)
}

export function answerDevice(id: string, deviceId?: string): void {
  const a = deviceAsks.get(id)
  if (!a) return
  deviceAsks.delete(id)
  a.done(deviceId ?? '')
}

export function answerAuth(id: string, username?: string, password?: string): void {
  const a = authAsks.get(id)
  if (!a) return
  authAsks.delete(id)
  a.done(username, password)
}

/** Интерфейс перезагрузился или упал: вопросы ушли — отвечаем отказом, чтобы страницы не висели. */
export function dropDevicePending(): void {
  for (const a of [...displayAsks.values()]) a.done(null)
  displayAsks.clear()
  for (const a of [...deviceAsks.values()]) a.done('')
  deviceAsks.clear()
  for (const a of [...authAsks.values()]) a.done()
  authAsks.clear()
}

export function initDevices(partition: string, h: Hooks): void {
  hooks = h
  const ses: Session = session.fromPartition(partition)

  // Демонстрация экрана: источники собираем заранее — окно выбора покажет живые снимки.
  ses.setDisplayMediaRequestHandler((request, callback) => {
    if (!hooks.hasWindow()) return callback(null)
    desktopCapturer
      .getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true })
      .then((sources) => {
        const displays = screen.getAllDisplays()
        const primary = screen.getPrimaryDisplay().id
        let screenIndex = 0
        sourcesCache = sources.map((s) => {
          const isScreen = s.id.startsWith('screen:')
          if (isScreen) screenIndex++
          const display = isScreen ? displays.find((d) => String(d.id) === s.display_id) : undefined
          // display_id связывает снимок с монитором; порядковый номер из id источника этого не гарантирует.
          const number = display ? displays.indexOf(display) + 1 : screenIndex
          const detail = display
            ? [display.label, display.id === primary ? 'Основной' : '', `${Math.round(display.bounds.width * display.scaleFactor)} × ${Math.round(display.bounds.height * display.scaleFactor)}`].filter(Boolean).join(' · ')
            : isScreen ? 'Весь экран' : 'Окно приложения'
          return {
            id: s.id,
            name: isScreen ? `Экран ${number}` : s.name || 'Окно без названия',
            detail,
            icon: !isScreen && s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.resize({ width: 24, height: 24 }).toDataURL() : undefined,
            thumb: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
            screen: isScreen
          }
        })
        askDisplay(request.securityOrigin, request.audioRequested, (video) =>
          // Звук системы (loopback) умеет только Windows; на Mac демонстрация пойдёт без звука.
          callback(video ? { video, audio: request.audioRequested && process.platform === 'win32' ? 'loopback' : undefined } : null),
          request.frame ? webContents.fromFrame(request.frame)?.id : undefined
        )
      })
      .catch(() => callback(null))
  })

  const hostOf = (frame: Electron.WebFrameMain | null | undefined): string => {
    try {
      return new URL(frame?.origin ?? '').host
    } catch {
      return ''
    }
  }
  const hostOfContents = (wc: WebContents | undefined): string => {
    try {
      return new URL(wc?.getURL() ?? '').host
    } catch {
      return ''
    }
  }
  ses.on('select-usb-device', (event, details, callback) => {
    event.preventDefault()
    askDevice('usb', 'USB-устройства', hostOf(details.frame), details.deviceList.map((d) => ({ id: d.deviceId, name: d.productName || 'USB-устройство' })), callback, details.frame ? webContents.fromFrame(details.frame)?.id : undefined)
  })
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault()
    askDevice('hid', 'HID-устройства', hostOf(details.frame), details.deviceList.map((d) => ({ id: d.deviceId, name: d.name || 'HID-устройство' })), callback, details.frame ? webContents.fromFrame(details.frame)?.id : undefined)
  })
  ses.on('select-serial-port', (event, portList, wc, callback) => {
    event.preventDefault()
    askDevice('serial', 'Последовательные порты', hostOfContents(wc), portList.map((p) => ({ id: p.portId, name: p.displayName || p.portName || 'Порт' })), (id) => callback(id), wc.id)
  })
  // Bluetooth спрашивает само содержимое, а не сессия: вешаем на каждую вкладку и окно.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('select-bluetooth-device', (event, devices, callback) => {
      event.preventDefault()
      askDevice('bluetooth', 'Bluetooth-устройства', hostOfContents(contents), devices.map((d) => ({ id: d.deviceId, name: d.deviceName || 'Устройство' })), (id) => callback(id), contents.id)
    })
  })

  // HTTP Basic/Digest/NTLM и прокси: вместо молчаливого отказа — окно логина, как у браузеров.
  app.on('login', (event, wc, _details, authInfo, callback) => {
    // Без хоста (внутренние запросы) не спрашиваем.
    if (!authInfo.host) return
    if (!hooks.hasWindow()) return
    const meta = { host: authInfo.host + (authInfo.port ? ':' + authInfo.port : ''), realm: authInfo.realm ?? '', proxy: authInfo.isProxy, wcId: wc?.id }
    // Сайт с авторетраем может стучаться много раз в секунду: пока пользователь не ответил,
    // повторные 401 того же realm молча отклоняем — иначе окна входа плодились бы бесконечно.
    for (const a of [...authAsks.values()]) if (a.meta.host === meta.host && a.meta.realm === meta.realm && a.meta.wcId === meta.wcId) return
    event.preventDefault()
    const id = 'a' + randomUUID()
    authAsks.set(id, { meta, done: (username, password) => callback(username, password) })
    hooks.ui('auth-ask', { id, ...meta })
  })

  const owns = (sender: WebContents, wcId?: number): boolean => hooks.isUi(sender) && (wcId === undefined || webContents.fromId(wcId)?.hostWebContents === sender)
  ipcMain.handle('devices:asks', (e) => ({ display: displayList().filter((a) => owns(e.sender, a.wcId)), device: deviceList().filter((a) => owns(e.sender, a.wcId)), auth: authList().filter((a) => owns(e.sender, a.wcId)) }))
  ipcMain.on('display:answer', (e, id: unknown, sourceId: unknown) => {
    if (typeof id === 'string' && owns(e.sender, displayAsks.get(id)?.wcId)) answerDisplay(id, typeof sourceId === 'string' ? sourceId : null)
  })
  ipcMain.on('device:answer', (e, id: unknown, deviceId: unknown) => {
    if (typeof id === 'string' && owns(e.sender, deviceAsks.get(id)?.ask.wcId)) answerDevice(id, typeof deviceId === 'string' ? deviceId : undefined)
  })
  ipcMain.on('auth:answer', (e, id: unknown, username: unknown, password: unknown) => {
    if (typeof id === 'string' && owns(e.sender, authAsks.get(id)?.meta.wcId)) answerAuth(id, typeof username === 'string' ? username : undefined, typeof password === 'string' ? password : undefined)
  })
}
