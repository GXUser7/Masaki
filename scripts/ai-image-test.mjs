// AI Mode с картинкой из палитры: вставка Ctrl+V, миниатюра, отправка в Lens POST'ом и переход в AI Mode.
// К Google тест не ходит: https тестовой сессии отдаёт локальный обработчик — «Lens» принимает картинку
// и отвечает переходом на результаты, как настоящий, а «AI Mode» показывает, с каким адресом его открыли.
// Запуск: npm run test:ai-image. Снимки — test-output/ai-image-*.png.
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'test-output')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-ai-image-'))
fs.mkdirSync(out, { recursive: true })
const logs = []
let app
let win

/** Картинка PNG w×h одного цвета — чтобы проверить, что до «Lens» дошла именно она. */
function png(w, h, [r, g, b]) {
  const crc = (buf) => {
    let c = ~0
    for (const x of buf) {
      c ^= x
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
    return ~c >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => [r, g, b][i % 3])])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

async function waitFor(fn, what, ms = 15000) {
  const until = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() >= until) throw new Error('Не дождались: ' + what)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
async function shot(name) {
  await win.waitForTimeout(350)
  const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(b64, 'base64'))
}
const activeUrl = () => win.evaluate(() => document.querySelector('webview.wv.on')?.getURL?.() ?? '')
const requests = () => app.evaluate(() => globalThis.__lensLog)

/** Вставка картинки в поле палитры — как Ctrl+V скриншота: файл в clipboardData. */
async function pasteImage(bytes) {
  await win.evaluate((b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const dt = new DataTransfer()
    dt.items.add(new File([bin], 'screenshot.png', { type: 'image/png' }))
    document.querySelector('.cmd-in input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, bytes.toString('base64'))
}

try {
  app = await electron.launch({
    args: [root],
    cwd: root,
    colorScheme: null,
    env: { ...process.env, MASAKI_TEST_HEADLESS: process.env.MASAKI_TEST_HEADLESS ?? '1', MASAKI_TEST_INACTIVE: '1', MASAKI_PROFILE: path.join(temp, 'profile') },
    timeout: 60000
  })
  win = await app.firstWindow()
  win.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
  win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  await win.waitForSelector('.ntp', { timeout: 30000 })
  await app.evaluate(({ session }) => {
    globalThis.__lensLog = []
    session.fromPartition('persist:frost').protocol.handle('https', async (req) => {
      const url = new URL(req.url)
      if (url.hostname === 'lens.google.com' && url.pathname === '/v3/upload') {
        const body = Buffer.from(await req.arrayBuffer())
        const type = req.headers.get('content-type') ?? ''
        const boundary = /boundary=(.+)$/.exec(type)?.[1] ?? ''
        // Тело multipart: заголовки части, пустая строка, байты картинки, разделитель.
        const head = body.indexOf('\r\n\r\n')
        const part = body.subarray(head + 4, body.lastIndexOf(Buffer.from('\r\n--' + boundary)))
        globalThis.__lensLog.push({ method: req.method, multipart: type.startsWith('multipart/form-data'), field: body.subarray(0, head).toString().includes('name="encoded_image"'), size: part.length, png: part.subarray(1, 4).toString() === 'PNG', jpeg: part[0] === 0xff && part[1] === 0xd8 })
        return new Response(null, { status: 302, headers: { location: 'https://www.google.com/search?vsrid=TEST-VSRID&vsint=TEST&udm=26&lns_mode=un&source=lns.web.gisbubb&lns_surface=26' } })
      }
      globalThis.__lensLog.push({ method: req.method, url: req.url })
      const title = url.searchParams.get('udm') === '50' ? 'AI Mode' : 'Lens'
      return new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1><p>${url.searchParams.get('q') ?? ''}</p>`, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
      })
    })
  })

  // 1. С новой вкладки: палитра, вставка картинки — миниатюра и сразу AI Mode.
  await win.click('.fakebox')
  await win.waitForSelector('.cmd-in input')
  await win.keyboard.type('Что на картинке?')
  await pasteImage(png(64, 48, [233, 30, 99]))
  await win.waitForSelector('.pal-pic img')
  assert.equal(await win.locator('.cmd-in .chip.on').count(), 1, 'с картинкой палитра должна перейти в AI Mode')
  assert.match(await win.locator('.row.on').innerText(), /о картинке/)
  await shot('ai-image-01-palette')
  // Backspace в пустом поле убирает картинку, вставка возвращает.
  await win.fill('.cmd-in input', '')
  await win.press('.cmd-in input', 'Backspace')
  assert.equal(await win.locator('.pal-pic').count(), 0, 'Backspace в пустом поле должен убрать картинку')
  await pasteImage(png(64, 48, [233, 30, 99]))
  await win.waitForSelector('.pal-pic img')
  await win.keyboard.type('Что на картинке?')
  await win.press('.cmd-in input', 'Enter')

  await waitFor(async () => (await activeUrl()).includes('udm=50'), 'переход в AI Mode')
  const ai = new URL(await activeUrl())
  assert.equal(ai.hostname, 'www.google.com')
  assert.equal(ai.searchParams.get('vsrid'), 'TEST-VSRID', 'AI Mode должен открыться с картинкой из ответа Lens')
  assert.equal(ai.searchParams.get('q'), 'Что на картинке?')
  const log = await requests()
  const upload = log.find((r) => 'multipart' in r)
  assert.ok(upload && upload.method === 'POST' && upload.multipart && upload.field && upload.png && upload.size > 50, 'картинка должна уйти в Lens POST’ом: ' + JSON.stringify(upload))
  // Результаты Lens (udm=26) не грузим: переход сразу заменяется на AI Mode.
  assert.equal(log.filter((r) => r.url?.includes('udm=26')).length, 0, 'лишний заход на результаты Lens')
  assert.equal(await win.locator('.side .tab').count(), 1, 'новая вкладка должна была занять себя, а не открыть ещё одну')
  await shot('ai-image-02-ai-mode')
  console.log('ok — вставка, миниатюра, POST в Lens и переход в AI Mode с вопросом')

  // 2. Перетаскивание большой картинки в палитру из открытой страницы: уходит уменьшенной (JPEG ≤ 1600 px).
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('command', { type: 'palette', withUrl: true }))
  await win.waitForSelector('.cmd-in input')
  await win.evaluate((b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const dt = new DataTransfer()
    dt.items.add(new File([bin], 'big.png', { type: 'image/png' }))
    document.querySelector('.cmd').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, png(2400, 1200, [26, 115, 232]).toString('base64'))
  await win.waitForSelector('.pal-pic img')
  await win.fill('.cmd-in input', '')
  await win.press('.cmd-in input', 'Enter')
  await waitFor(async () => (await requests()).filter((r) => 'multipart' in r).length === 2, 'вторая отправка в Lens')
  const big = (await requests()).filter((r) => 'multipart' in r)[1]
  assert.ok(big.jpeg && !big.png, 'большая картинка должна уйти уменьшенным JPEG: ' + JSON.stringify(big))
  await waitFor(async () => {
    const u = new URL(await activeUrl())
    return u.searchParams.get('udm') === '50' && u.searchParams.get('q') === ''
  }, 'AI Mode без вопроса — о самой картинке')
  console.log('ok — перетаскивание; большая картинка уходит уменьшенной; без вопроса — AI Mode о картинке')

  // 3. Посторонний renderer не может отправить картинку из чужой вкладки.
  const wcId = await win.evaluate(() => document.querySelector('webview.wv.on').getWebContentsId())
  const foreign = await app.evaluate(async ({ BrowserWindow }, id) => {
    const other = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } })
    try {
      await other.loadURL('about:blank')
      return await other.webContents.executeJavaScript(`require('electron').ipcRenderer.invoke('ai:image', ${id}, 'x', 'data:image/png;base64,AAAA')`)
    } finally {
      other.destroy()
    }
  }, wcId)
  assert.equal(foreign, false)
  console.log('ok — посторонний renderer отклонён')
} catch (e) {
  process.exitCode = 1
  console.error(e)
  if (app && win) await shot('ai-image-99-failure').catch(() => {})
} finally {
  fs.writeFileSync(path.join(out, 'ai-image-console.log'), logs.join('\n'))
  if (app) await app.close().catch(() => {})
  // Папка создана mkdtemp выше: очистка ограничена временными данными именно этого теста.
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}
