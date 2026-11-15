// Пауза и продолжение настоящего DownloadItem: оба интерфейса, неизменность счётчика на паузе,
// целостность файла после продолжения и границы IPC. Только локальный сервер и временный профиль.
// node scripts/downloads-pause-test.mjs (после сборки)
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'test-output')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-dl-pause-'))
const profile = path.join(temp, 'profile')
const downloads = path.join(temp, 'downloads')
for (const p of [output, profile, downloads]) fs.mkdirSync(p, { recursive: true })
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ sidebarCollapsed: false, addons: { adblock: { enabled: false } } }))
const data = Buffer.alloc(8 * 1024 * 1024)
for (let i = 0; i < data.length; i++) data[i] = i % 251
const site = http.createServer((req, res) => {
  const offset = Number(/^bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0)
  res.writeHead(offset ? 206 : 200, {
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename="${req.url.slice(1)}"`,
    'content-length': data.length - offset,
    'accept-ranges': 'bytes',
    etag: '"pause-test-v1"',
    'last-modified': 'Sun, 01 Nov 2026 00:00:00 GMT',
    ...(offset ? { 'content-range': `bytes ${offset}-${data.length - 1}/${data.length}` } : {})
  })
  let sent = offset
  const timer = setInterval(() => {
    const end = Math.min(sent + 65536, data.length)
    res.write(data.subarray(sent, end))
    sent = end
    if (sent === data.length) { clearInterval(timer); res.end() }
  }, 45)
  res.once('close', () => clearInterval(timer))
})
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${site.address().port}`
let app, page
const watchdog = setTimeout(() => { app?.process().kill(); process.exit(1) }, 90_000)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, label) => {
  const end = Date.now() + 15000
  while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(100) }
  throw new Error('Не дождались: ' + label)
}
try {
  const env = { ...process.env, MASAKI_PROFILE: profile, MASAKI_DOWNLOADS: downloads, MASAKI_TEST_INACTIVE: '1', MASAKI_TEST_HEADLESS: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [root], cwd: root, env, colorScheme: null })
  page = await app.firstWindow()
  await page.waitForSelector('.stage')
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const list = () => page.evaluate(() => window.masaki.downloads.list())
  const latest = async (name) => (await list()).find((d) => d.filename === name)
  const command = (c) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('command', c), c)
  const start = (name) => app.evaluate(({ session }, u) => session.fromPartition('persist:frost').downloadURL(u), `${base}/${name}`)
  const shot = async (name) => {
    await wait(500)
    const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
    fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(b64, 'base64'))
  }
  await start('pause.bin')
  const active = await until(async () => { const d = await latest('pause.bin'); return d?.received > 0 && d }, 'начало')
  await page.locator('.side .dl-btn').click()
  const pop = page.locator('.pop.downloads .dl').filter({ hasText: 'pause.bin' })
  await pop.getByRole('button', { name: 'Приостановить загрузку', exact: true }).click()
  await until(async () => (await latest('pause.bin'))?.paused, 'пауза из списка')
  await wait(400)
  const bytes = (await latest('pause.bin')).received
  await wait(700)
  assert.equal((await latest('pause.bin')).received, bytes, 'счётчик на паузе не растёт')
  await pop.getByRole('button', { name: 'Возобновить загрузку', exact: true }).waitFor()
  await shot('downloads-pause-popover')
  const untrusted = await app.evaluate(async ({ BrowserWindow }, id) => {
    const other = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } })
    try {
      await other.loadURL('about:blank')
      return await other.webContents.executeJavaScript(`Promise.all(['dl:pause','dl:resume'].map(c=>require('electron').ipcRenderer.invoke(c,${JSON.stringify(id)})))`)
    } finally { other.destroy() }
  }, active.id)
  assert.deepEqual(untrusted, [false, false])
  assert.equal(await page.evaluate(() => window.masaki.downloads.resume('unknown')), false)
  await page.keyboard.press('Escape')
  await command({ type: 'downloads' })
  const row = page.locator('.dlp-row').filter({ hasText: 'pause.bin' })
  await row.getByRole('button', { name: 'Возобновить загрузку', exact: true }).click()
  await until(async () => { const d = await latest('pause.bin'); return !d.paused && d.received > bytes }, 'продолжение со страницы')
  await row.getByRole('button', { name: 'Приостановить загрузку', exact: true }).click()
  await until(async () => (await latest('pause.bin')).paused, 'пауза со страницы')
  await shot('downloads-pause-page')
  await page.locator('.side .dl-btn').click()
  await pop.getByRole('button', { name: 'Возобновить загрузку', exact: true }).click()
  const done = await until(async () => { const d = await latest('pause.bin'); return d.state === 'completed' && d }, 'докачивание')
  const hash = (b) => crypto.createHash('sha256').update(b).digest('hex')
  assert.equal(hash(fs.readFileSync(done.path)), hash(data), 'содержимое после двух пауз совпало целиком')
  assert.equal(done.paused, false)
  assert.equal(done.canResume, false)
  assert.equal(await page.evaluate((id) => window.masaki.downloads.pause(id), done.id), false)
  assert.equal(await page.evaluate((id) => window.masaki.downloads.resume(id), done.id), false)
  await page.keyboard.press('Escape')
  await start('cancel-paused.bin')
  const cancel = await until(async () => { const d = await latest('cancel-paused.bin'); return d?.received > 0 && d }, 'вторая загрузка')
  assert.equal(await page.evaluate((id) => window.masaki.downloads.pause(id), cancel.id), true)
  assert.equal(await page.evaluate((id) => window.masaki.downloads.cancel(id), cancel.id), true)
  await until(async () => (await latest('cancel-paused.bin')).state === 'cancelled', 'отмена паузы')
  assert.equal(await page.evaluate((id) => window.masaki.downloads.resume(id), cancel.id), false)
  assert.deepEqual(errors, [])
  console.log('OK: пауза и продолжение в обоих интерфейсах; счётчик стоит, 8 МБ совпали по SHA-256; отмена паузы и границы IPC')
} finally {
  await app?.close().catch(() => {})
  clearTimeout(watchdog)
  site.closeAllConnections()
  await new Promise((r) => site.close(r))
  fs.rmSync(temp, { recursive: true, force: true })
}
