// Снимки новых интерфейсов для отчёта: история, папки в панели, сведения о сайте,
// демо экрана, менеджер паролей (генератор/проверка/адреса/карты).
// node scripts/visual-screens.mjs (после сборки)
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-visual-'))
const output = path.join(root, 'test-output')
fs.mkdirSync(output, { recursive: true })

const site = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  if (req.url === '/display') {
    return res.end(`<!doctype html><meta charset="utf-8"><title>демо</title><body style="background:#173029;color:#e2f1e9;font:20px sans-serif;margin:40px"><h1>демо</h1><button id="go">показать</button><script>
      document.getElementById('go').onclick = () => navigator.mediaDevices.getDisplayMedia({ video: true }).catch(() => {})
    </script></body>`)
  }
  res.end('<!doctype html><meta charset="utf-8"><title>Пример сайта</title><body style="background:#173029;color:#e2f1e9;font:20px sans-serif;margin:40px"><h1>Пример сайта</h1></body>')
})
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
const base = `http://localhost:${site.address().port}`

// Папки в избранном: как после переноса из Chrome
fs.writeFileSync(
  path.join(profile, 'settings.json'),
  JSON.stringify({
    sidebarCollapsed: false,
    sleepAfter: 0,
    favorites: [
      { title: 'YouTube', url: 'https://youtube.com' },
      { title: 'GitHub', url: 'https://github.com' },
      { title: 'Хабр', url: 'https://habr.com', folder: 'Чтение' },
      { title: 'Lenta', url: 'https://lenta.ru', folder: 'Чтение' },
      { title: 'Gmail', url: 'https://mail.google.com' }
    ]
  })
)

let app, page, mainId
const shotOf = async (name) => {
  await page.waitForTimeout(700)
  const png = await app.evaluate(async ({ BrowserWindow }, id) => (await BrowserWindow.fromId(id).capturePage()).toPNG().toString('base64'), mainId)
  fs.writeFileSync(path.join(output, `visual-${name}.png`), Buffer.from(png, 'base64'))
  console.log('снимок', name)
}
const watchdog = setTimeout(() => { console.error('Лимит 120 секунд'); app?.process().kill(); process.exit(1) }, 120_000)

try {
  const env = { ...process.env, MASAKI_PROFILE: profile, MASAKI_TEST_HEADLESS: '1', MASAKI_TEST_INACTIVE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [root], cwd: root, env, colorScheme: null })
  page = await app.firstWindow()
  mainId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id)
  await page.waitForSelector('.tablist', { timeout: 20000 })
  const open = (url) => app.evaluate(({ BrowserWindow }, [id, u]) => BrowserWindow.fromId(id).webContents.send('command', { type: 'open-url', url: u }), [mainId, url])
  const cmd = (c) => app.evaluate(({ BrowserWindow }, [id, cc]) => BrowserWindow.fromId(id).webContents.send('command', cc), [mainId, c])

  // 1. История
  await open(base + '/один')
  await page.waitForSelector('webview.wv.on', { timeout: 15000 })
  await page.waitForTimeout(1200)
  await open(base + '/два')
  await page.waitForTimeout(1500)
  await cmd({ type: 'history' })
  await page.waitForSelector('.dlp-head', { timeout: 15000 })
  await shotOf('history')

  // 2. Папки в панели (уже на экране слева)
  await shotOf('folders')

  // 3. Сведения о сайте
  await open(base + '/')
  await page.waitForTimeout(1400)
  await page.locator('.abar .a-lock').first().click()
  await page.waitForSelector('.site-info', { timeout: 8000 })
  await shotOf('site-info')
  await page.keyboard.press('Escape')

  // 4. Демонстрация экрана
  await open(base + '/display')
  await page.waitForTimeout(1500)
  const wc = await page.evaluate(() => document.querySelector('webview.wv.on')?.getWebContentsId())
  if (wc) {
    const run = (code) => app.evaluate(({ webContents }, [id, code]) => webContents.fromId(id).executeJavaScript(code, true), [wc, code])
    await run(`document.getElementById('go').click()`)
    await page.waitForSelector('.ds-card', { timeout: 8000 })
    await shotOf('display')
    await page.evaluate(() => document.querySelector('.ds-card .perm-btn')?.click())
  }

  // 5. Менеджер паролей: адреса и карты
  await page.evaluate(() => {
    void window.masaki.passwords.save({ url: 'https://github.com', username: 'tester', password: 'parol-silnyi-2026' })
    void window.masaki.autofill.saveAddress({ name: 'Тест Тестов', street: 'ул. Примерная, 1', city: 'Москва', zip: '101000', phone: '+7 900 000-00-00' })
    void window.masaki.autofill.saveCard({ holder: 'TEST TESTOV', number: '4242 4242 4242 4242', exp: '12/29', nick: 'Тестовая' })
  })
  await cmd({ type: 'settings' })
  await page.waitForTimeout(400)
  await page.evaluate(() => window.masaki ? null : null)
  await cmd({ type: 'addons' })
  await page.waitForTimeout(400)
  // страница паролей — командой палитры через main
  await cmd({ type: 'palette', withUrl: false })
  await page.waitForSelector('.cmd', { timeout: 8000 })
  await page.keyboard.type('>пароли')
  await page.waitForTimeout(300)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(900)
  await page.evaluate(() => window.scrollTo(0, 0))
  await shotOf('passwords')
} catch (e) {
  console.error('ОШИБКА:', e.message)
  process.exitCode = 1
} finally {
  await app?.close().catch(() => {})
  clearTimeout(watchdog)
  await new Promise((resolve) => site.close(resolve))
  fs.rmSync(profile, { recursive: true, force: true })
}