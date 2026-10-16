// Загрузки на локальном медленном сервере: отмена через интерфейс действительно рвёт поток,
// соседняя загрузка доходит целиком, завершённые объекты нельзя отменить повторно.
// Запуск: npm run test:downloads. Профиль, файлы и окна полностью изолированы от пользователя.
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'test-output')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-downloads-'))
const profile = path.join(temp, 'profile')
const downloads = path.join(temp, 'downloads')
for (const dir of [out, profile, downloads]) fs.mkdirSync(dir, { recursive: true })
const streams = new Map()
const logs = []
const chunk = Buffer.alloc(32 * 1024, 0x5a)
const site = http.createServer((req, res) => {
  const filename = req.url.slice(1)
  if (!['cancel.bin', 'complete.bin', 'slow-a.bin', 'slow-b.bin'].includes(filename)) {
    res.writeHead(404)
    return res.end()
  }
  const total = (filename === 'complete.bin' ? 2 : 16) * 1024 * 1024
  const stream = { sent: 0, total, closed: false }
  streams.set(filename, stream)
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename="${filename}"`,
    'content-length': total,
    'cache-control': 'no-store'
  })
  const timer = setInterval(() => {
    stream.sent += chunk.length
    res.write(chunk)
    if (stream.sent >= total) {
      clearInterval(timer)
      res.end()
    }
  }, 100)
  res.once('close', () => {
    stream.closed = true
    clearInterval(timer)
  })
})
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${site.address().port}`
let app
let win

async function waitFor(fn, what, ms = 15000) {
  const until = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() >= until) throw new Error('Не дождались: ' + what)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

const latest = (filename) => win.evaluate((name) => window.__downloadEvents.findLast((d) => d.filename === name), filename)
const row = (filename) => win.locator('.dl').filter({ has: win.getByText(filename, { exact: true }) })
async function shot(name) {
  // CSS-переход поповера должен успеть нарисовать первый кадр после появления в DOM.
  await win.waitForTimeout(400)
  const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(b64, 'base64'))
}

async function launch() {
  app = await electron.launch({
    args: [root],
    cwd: root,
    env: { ...process.env, MASAKI_TEST_INACTIVE: '1', MASAKI_TEST_HEADLESS: process.env.MASAKI_TEST_HEADLESS ?? '1', MASAKI_PROFILE: profile, MASAKI_DOWNLOADS: downloads },
    colorScheme: null,
    timeout: 60000
  })
  win = await app.firstWindow()
  win.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
  win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  await win.waitForSelector('.stage', { timeout: 30000 })
}
const command = (c) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('command', c), c)
const pageRow = (filename) => win.locator('.dlp-row').filter({ has: win.getByText(filename, { exact: true }) })

try {
  await launch()
  await win.evaluate(() => {
    window.__downloadEvents = []
    window.masaki.downloads.onUpdate((d) => window.__downloadEvents.push(d))
  })
  await app.evaluate(({ session }, base) => {
    for (const name of ['cancel.bin', 'complete.bin']) session.fromPartition('persist:frost').downloadURL(`${base}/${name}`)
  }, base)
  const active = await waitFor(async () => {
    const d = await latest('cancel.bin')
    return d?.state === 'progressing' && d.canCancel && d.received > 0 && d
  }, 'начало медленной загрузки')
  // Окно загрузок само не открывается (просьба пользователя) — открываем кнопкой, как человек.
  assert.equal(await win.locator('.pop.downloads').count(), 0, 'окно загрузок открылось само')
  await win.click('.side .dl-btn')
  await row('cancel.bin').getByRole('button', { name: 'Отменить загрузку', exact: true }).waitFor()
  assert.equal(await row('cancel.bin').getByRole('button', { name: 'Показать в папке' }).count(), 0)
  await shot('downloads-01-active')

  // Даже другой локальный renderer не получает права отменять загрузки основного окна.
  const untrusted = await app.evaluate(async ({ BrowserWindow }, id) => {
    const other = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } })
    try {
      await other.loadURL('about:blank')
      return await other.webContents.executeJavaScript(`require('electron').ipcRenderer.invoke('dl:cancel', ${JSON.stringify(id)})`)
    } finally {
      other.destroy()
    }
  }, active.id)
  assert.equal(untrusted, false)
  assert.equal((await latest('cancel.bin')).state, 'progressing')
  assert.equal(await win.evaluate(() => window.masaki.downloads.cancel('unknown-download')), false)

  await row('cancel.bin').getByRole('button', { name: 'Отменить загрузку', exact: true }).click()
  const cancelled = await waitFor(async () => {
    const d = await latest('cancel.bin')
    return d?.state === 'cancelled' && d
  }, 'отмена загрузки')
  assert.equal(cancelled.canCancel, false)
  await waitFor(() => streams.get('cancel.bin')?.closed, 'закрытие потока на сервере')
  assert.ok(streams.get('cancel.bin').sent < streams.get('cancel.bin').total)
  assert.equal(await row('cancel.bin').getByRole('button', { name: 'Отменить загрузку', exact: true }).count(), 0)
  assert.equal(await row('cancel.bin').getByRole('button', { name: 'Показать в папке' }).count(), 0)
  assert.equal(await row('cancel.bin').locator('.dl-main').isDisabled(), true)
  assert.equal(await win.evaluate((id) => window.masaki.downloads.cancel(id), cancelled.id), false)
  console.log('ok — кнопка отменяет поток; отменённый файл нельзя открыть или отменить снова')
  console.log('ok — неизвестный id и посторонний renderer не могут отменять загрузки')

  const completed = await waitFor(async () => {
    const d = await latest('complete.bin')
    return d?.state === 'completed' && d
  }, 'завершение соседней загрузки')
  assert.equal(completed.canCancel, false)
  assert.equal(fs.readFileSync(completed.path).equals(Buffer.alloc(2 * 1024 * 1024, 0x5a)), true)
  assert.equal(await row('complete.bin').getByRole('button', { name: 'Отменить загрузку', exact: true }).count(), 0)
  assert.equal(await row('complete.bin').getByRole('button', { name: 'Показать в папке' }).count(), 1)
  assert.equal(await row('complete.bin').locator('.dl-main').isDisabled(), false)
  assert.equal(await win.evaluate((id) => window.masaki.downloads.cancel(id), completed.id), false)
  await shot('downloads-02-cancelled-and-completed')
  console.log('ok — соседняя загрузка завершается целиком, доступны обычные действия с файлом')

  // Настоящий DownloadItem в interrupted ещё жив: это не то же самое, что terminal done.
  const partial = path.join(temp, 'interrupted.bin')
  fs.writeFileSync(partial, chunk)
  await app.evaluate(({ session }, [base, partial, offset]) => {
    session.fromPartition('persist:frost').createInterruptedDownload({
      path: partial,
      urlChain: [`${base}/interrupted.bin`],
      mimeType: 'application/octet-stream',
      offset,
      length: offset * 2
    })
  }, [base, partial, chunk.length])
  await waitFor(async () => {
    const d = await latest('interrupted.bin')
    return d?.state === 'interrupted' && d.canCancel
  }, 'прерванный DownloadItem')
  await row('interrupted.bin').getByRole('button', { name: 'Отменить загрузку', exact: true }).click()
  await waitFor(async () => {
    const d = await latest('interrupted.bin')
    return d?.state === 'cancelled' && !d.canCancel
  }, 'отмена прерванной загрузки')
  console.log('ok — прерванную загрузку можно отменить до terminal done')

  // Док: кнопка загрузок у «трёх точек», загрузка на месте плеера (ничего не играет), список над ней.
  // Новая загрузка сама открывает список — закрываем, чтобы он не перекрывал щелчки.
  const closePop = async () => {
    if (await win.$('.pop-scrim')) await win.click('.pop-scrim', { position: { x: 4, y: 4 } })
  }
  await closePop()
  await win.click('.side-top .ib[aria-label^="Свернуть панель"]')
  await win.waitForSelector('.capz .capsule .cap-dl')
  await app.evaluate(({ session }, base) => {
    for (const name of ['slow-a.bin', 'slow-b.bin']) session.fromPartition('persist:frost').downloadURL(`${base}/${name}`)
  }, base)
  await waitFor(async () => {
    const [a, b] = [await latest('slow-a.bin'), await latest('slow-b.bin')]
    return a?.state === 'progressing' && a.received > 0 && b?.state === 'progressing' && b.received > 0
  }, 'две медленные загрузки')
  await win.waitForSelector('.dk-right .dk-dl')
  await closePop()
  // Самая свежая — последняя начатая; про остальные сказано числом.
  assert.match(await win.locator('.dk-dl-main').getAttribute('aria-label'), /slow-b\.bin.*ещё 1/)
  await shot('downloads-03-dock-island')
  // Список выезжает и с клавиатуры (наведение в скрытом окне не проверить: курсор там настоящий).
  await win.focus('.dk-dl-main')
  await win.waitForSelector('.dk-dl-list .dk-dl-row >> nth=1')
  assert.equal(await win.locator('.dk-dl-row').count(), 2)
  await shot('downloads-04-dock-list')
  // Кнопка в капсуле: окно загрузок над ней, а не где придётся.
  await win.click('.capz .cap-dl')
  await win.waitForSelector('.pop.downloads')
  await win.waitForTimeout(500)
  const place = await win.evaluate(() => {
    const p = document.querySelector('.pop.downloads').getBoundingClientRect()
    const b = document.querySelector('.capz .cap-dl').getBoundingClientRect()
    return { left: p.left, right: p.right, bottom: p.bottom, button: b.left + b.width / 2, dock: document.querySelector('.capz').getBoundingClientRect().top }
  })
  assert.ok(place.bottom <= place.dock && place.left <= place.button && place.right >= place.button, 'окно загрузок не над кнопкой: ' + JSON.stringify(place))
  await shot('downloads-05-dock-popover')
  await win.click('.pop-scrim', { position: { x: 4, y: 4 } })
  for (const name of ['slow-a.bin', 'slow-b.bin']) await win.evaluate((id) => window.masaki.downloads.cancel(id), (await latest(name)).id)
  await waitFor(async () => (await win.$$('.dk-right .dk-dl')).length === 0, 'остров загрузки уходит, когда загрузок нет')
  console.log('ok — в доке кнопка загрузок, загрузка на месте плеера, список и окно над своей кнопкой')

  // Страница загрузок (Ctrl+J): вся история, файлы, удалённые с диска, поиск, фильтры, «скачать снова».
  await command({ type: 'downloads' })
  await win.waitForSelector('.dlp')
  await pageRow('complete.bin').waitFor()
  assert.equal(await pageRow('cancel.bin').getByText('Отменено').count(), 1)
  assert.equal(await pageRow('complete.bin').locator('.dlp-main').isDisabled(), false)
  fs.rmSync(completed.path)
  // Вернулись в окно после проводника — отметка обновляется сама.
  await win.evaluate(() => window.dispatchEvent(new Event('focus')))
  await pageRow('complete.bin').getByText('Удалён с диска').waitFor()
  assert.equal(await pageRow('complete.bin').locator('.dlp-main').isDisabled(), true)
  await shot('downloads-06-page')
  await win.fill('.dlp-search input', 'complete')
  await waitFor(async () => (await win.locator('.dlp-row').count()) === 1, 'поиск по названию')
  await win.fill('.dlp-search input', 'нет-такого')
  await win.waitForSelector('.dlp-empty')
  await win.fill('.dlp-search input', '')
  await win.click('.dlp-chip:has-text("Удалённые")')
  await waitFor(async () => (await win.locator('.dlp-row').count()) === 1, 'фильтр «Удалённые»')
  await win.click('.dlp-chip:has-text("Все")')
  console.log('ok — страница загрузок: удалённый файл помечен, поиск и фильтры работают')
  await pageRow('complete.bin').getByRole('button', { name: 'Скачать снова' }).click()
  await waitFor(async () => {
    const d = await latest('complete.bin')
    return d?.state === 'completed' && d.id !== completed.id
  }, 'повторная загрузка')
  await pageRow('complete.bin').locator('.dlp-main:not([disabled])').waitFor()
  assert.equal(await pageRow('complete.bin').count(), 1, 'прежняя запись должна уступить место новой')
  assert.equal(fs.readFileSync(path.join(downloads, 'complete.bin')).length, 2 * 1024 * 1024)
  console.log('ok — «Скачать снова» скачивает файл заново на прежнее место')

  // История — в профиле: после перезапуска список тот же.
  await app.close()
  await launch()
  await command({ type: 'downloads' })
  await win.waitForSelector('.dlp')
  for (const name of ['complete.bin', 'cancel.bin', 'slow-a.bin', 'interrupted.bin']) await pageRow(name).waitFor()
  assert.equal(await pageRow('complete.bin').locator('.dlp-main').isDisabled(), false)
  await shot('downloads-07-page-after-restart')
  console.log('ok — история загрузок переживает перезапуск')
} catch (e) {
  process.exitCode = 1
  console.error(e)
  if (app && win) await shot('downloads-99-failure').catch(() => {})
} finally {
  fs.writeFileSync(path.join(out, 'downloads-console.log'), logs.join('\n'))
  if (app) await app.close().catch(() => {})
  site.closeAllConnections()
  await new Promise((resolve) => site.close(resolve))
  // Путь создан mkdtemp выше: очистка ограничена временной папкой именно этого теста.
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}
