// «Войти через Google» на сайтах (Pinterest и др.): FedCM выключен — Google Identity Services ведёт вход
// всплывающим окном; окно входа видит Firefox ESR и в заголовках, и в navigator (иначе Google пишет
// «браузер небезопасен»), а window.opener у него работает — ответ доходит до сайта.
// Сайт и accounts.google.com — подставные (protocol.handle), к Google тест не ходит.
// Запуск: npx electron-vite build && node scripts/google-signin-test.mjs
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { clickGuest } from './electron-input.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-gsi-'))
const app = await electron.launch({
  args: [root],
  cwd: root,
  env: { ...process.env, MASAKI_TEST_HEADLESS: process.env.MASAKI_TEST_HEADLESS ?? '1', MASAKI_TEST_INACTIVE: '1', MASAKI_PROFILE: profile },
  colorScheme: null,
  timeout: 60000
})
const page = await app.firstWindow()

let failed = false
try {
  await page.waitForSelector('.tab, .dk-tab', { timeout: 20000 })
  await page.waitForTimeout(1200)
  await app.evaluate(({ session }) => {
    session.fromPartition('persist:frost').protocol.handle('https', async (req) => {
      const url = new URL(req.url)
      const html = (body) => new Response('<!doctype html><meta charset="utf-8">' + body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
      if (url.hostname === 'accounts.google.com') {
        const header = JSON.stringify(req.headers.get('user-agent') ?? '')
        return html(`<title>Вход Google</title><script>
          opener.postMessage({ ua: navigator.userAgent, uad: !!navigator.userAgentData, header: ${header} }, '*')
          setTimeout(() => close(), 200)
        </script>`)
      }
      return html(`<title>Сайт</title><body style="font:20px sans-serif;padding:40px">
        <button id="g" style="font:20px sans-serif">Продолжить с Google</button>
        <script>
          document.body.dataset.fedcm = String('IdentityCredential' in window)
          document.getElementById('g').onclick = () => window.open('https://accounts.google.com/o/oauth2/v2/auth?client_id=test', 'g_auth', 'width=500,height=600')
          addEventListener('message', (e) => { if (e.origin === 'https://accounts.google.com') document.title = 'ответ ' + JSON.stringify(e.data) })
        </script>`)
    })
  })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('command', { type: 'open-url', url: 'https://site.test/' }))
  await page.waitForSelector('webview.wv.on')
  await page.waitForFunction(() => !document.querySelector('.fav.loading'), null, { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(800)
  const id = await page.evaluate(() => document.querySelector('webview.wv.on').getWebContentsId())
  const inTab = (code) => app.evaluate(({ webContents }, [id, code]) => webContents.fromId(id).executeJavaScript(code), [id, code])

  if ((await inTab('document.body.dataset.fedcm')) !== 'false') throw new Error('FedCM включён — Google поведёт вход через него, а окна выбора аккаунта у Electron нет')
  console.log('FedCM выключен: ок')

  const b = await inTab(`(() => { const r = document.getElementById('g').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 } })()`)
  await clickGuest(app, id, b.x, b.y)
  let title = ''
  for (let i = 0; i < 50 && !title.startsWith('ответ'); i++) {
    await page.waitForTimeout(200)
    title = await inTab('document.title')
  }
  if (!title.startsWith('ответ')) throw new Error('окно входа не ответило сайту (window.opener): ' + title)
  const got = JSON.parse(title.slice('ответ '.length))
  // Заголовок здесь не проверить: запросы, которые отдаёт protocol.handle, идут мимо onBeforeSendHeaders
  // (даже во вкладке). Заголовок ставит та же сессия, что и вкладкам, — для окна это не отдельный путь.
  if (!got.ua.includes('Firefox')) throw new Error('navigator.userAgent в окне входа — не Firefox: ' + got.ua)
  if (got.uad) throw new Error('в окне входа видно navigator.userAgentData (признак Chromium)')
  console.log('окно входа: Firefox в navigator, без userAgentData, ответ дошёл до сайта: ок')
  let windows = 2
  for (let i = 0; i < 25 && windows > 1; i++) {
    await page.waitForTimeout(200)
    windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  }
  if (windows !== 1) throw new Error('окно входа не закрылось само: окон ' + windows)
  console.log('окно входа закрылось: ок')
} catch (e) {
  failed = true
  console.error('ОШИБКА:', e.message)
} finally {
  await app.close().catch(() => {})
  fs.rmSync(profile, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
