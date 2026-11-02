// Окно инкогнито: отдельный процесс с временной папкой, тёмное и графитовое, без истории и сессии;
// куки не попадают в обычный профиль и стираются при закрытии; «Открыть в окне инкогнито» из обычного
// окна передаёт адрес уже открытому инкогнито (через запуск второй копии).
// Запуск: npx electron-vite build && node scripts/incognito-test.mjs
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'test-output')
fs.mkdirSync(out, { recursive: true })
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-incog-'))
const incogDir = path.join(profile, 'Incognito-default')
const env = { ...process.env, MASAKI_TEST_HEADLESS: process.env.MASAKI_TEST_HEADLESS ?? '1', MASAKI_TEST_INACTIVE: '1', MASAKI_PROFILE: profile }

// Свой сайт на 127.0.0.1: ставит куку, чтобы проверить, куда она попала.
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1')
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...(u.pathname === '/set' ? { 'set-cookie': 'secret=incognito; Path=/; Max-Age=3600' } : {})
  })
  res.end(`<meta charset="utf-8"><title>Сайт ${u.pathname}</title><body style="font:20px sans-serif;padding:40px">Страница ${u.pathname}</body>`)
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const site = `http://127.0.0.1:${srv.address().port}`

async function launch(args) {
  const app = await electron.launch({ args: [root, ...args], cwd: root, env, colorScheme: null, timeout: 60000 })
  const page = await app.firstWindow()
  await page.waitForSelector('.tab, .dk-tab', { timeout: 20000 })
  await page.waitForTimeout(1200)
  return { app, page }
}
async function shot(app, name) {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(b64, 'base64'))
  console.log('снимок', name)
}
const cookies = (app) => app.evaluate(({ session }) => session.fromPartition('persist:frost').cookies.get({}).then((c) => c.map((x) => x.name + '=' + x.value)))
const tabUrls = (page) => page.evaluate(() => [...document.querySelectorAll('webview')].map((w) => w.getAttribute('src')))
const waitFor = async (what, fn, ms = 10000) => {
  for (let t = 0; t < ms; t += 200) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('не дождались: ' + what)
}

let failed = false
const opened = []
try {
  // 1. Обычное окно: своя тема (светлая) и избранное, которое инкогнито должно унаследовать.
  let main = await launch([])
  opened.push(main.app)
  const cur = await main.page.evaluate(() => window.masaki.settings.get())
  await main.page.evaluate(
    (s) => window.masaki.settings.set(s),
    { ...cur, scheme: 'light', palette: 'mint', favorites: [{ title: 'Мой сайт', url: site + '/fav' }] }
  )
  await main.page.waitForTimeout(600)
  await main.app.close()
  opened.pop()

  // 2. Окно инкогнито со ссылкой из командной строки.
  const incog = await launch(['--incognito', site + '/set'])
  opened.push(incog.app)
  const ui = await incog.page.evaluate(() => ({
    flag: window.masaki.incognito,
    cls: document.querySelector('.app')?.className ?? '',
    brand: document.querySelector('.brand')?.textContent ?? '',
    title: document.title
  }))
  if (!ui.flag || !ui.cls.includes('incognito') || !ui.brand.includes('Инкогнито')) throw new Error('окно не похоже на инкогнито: ' + JSON.stringify(ui))
  if (ui.title !== 'Инкогнито — Masaki') throw new Error('заголовок окна: ' + ui.title)
  const dir = await incog.app.evaluate(({ app }) => app.getPath('userData'))
  if (path.resolve(dir) !== path.resolve(incogDir)) throw new Error('папка инкогнито не та: ' + dir)
  const s = await incog.page.evaluate(() => window.masaki.settings.get())
  if (s.scheme !== 'dark' || s.palette !== 'graphite') throw new Error('инкогнито не тёмное графитовое: ' + s.scheme + ' ' + s.palette)
  if (!s.favorites.some((f) => f.url === site + '/fav')) throw new Error('избранное профиля не перешло в инкогнито')
  await waitFor('страница из командной строки', async () => (await tabUrls(incog.page)).includes(site + '/set'))
  await incog.page.waitForFunction(() => !document.querySelector('.fav.loading'), null, { timeout: 15000 }).catch(() => {})
  await incog.page.waitForTimeout(800)
  if (!(await cookies(incog.app)).includes('secret=incognito')) throw new Error('кука сайта в инкогнито не поставилась')
  if ((await incog.page.evaluate(() => window.masaki.history.list())).length) throw new Error('инкогнито записало историю')
  await shot(incog.app, 'incog-01-page')
  console.log('окно инкогнито: ок')

  // Новая вкладка — с пояснением; свёрнутая панель — метка в капсуле дока.
  await incog.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('command', { type: 'new-tab' }))
  await incog.page.waitForSelector('.ntp-incog')
  await incog.page.waitForTimeout(700)
  await shot(incog.app, 'incog-02-newtab')
  await incog.page.click('.side-top .ib[aria-label^="Свернуть панель"]')
  await incog.page.waitForSelector('.cap-incog')
  await incog.page.waitForTimeout(1200)
  await shot(incog.app, 'incog-03-dock')
  await incog.page.click('.capsule .cap-side')
  await incog.page.waitForTimeout(800)

  // 3. Обычное окно рядом: куки инкогнито у него нет, «Открыть в окне инкогнито» уходит в открытое окно.
  main = await launch([])
  opened.push(main.app)
  if ((await cookies(main.app)).some((c) => c.startsWith('secret='))) throw new Error('кука инкогнито попала в обычный профиль')
  if ((await main.page.evaluate(() => window.masaki.settings.get())).scheme !== 'light') throw new Error('инкогнито поменяло настройки профиля')
  await main.page.evaluate((url) => window.masaki.openIncognito(url), site + '/second')
  await waitFor('вторая ссылка во вкладке инкогнито', async () => (await tabUrls(incog.page)).includes(site + '/second'), 20000)
  console.log('ссылка из обычного окна — в открытое инкогнито: ок')

  // 4. Закрыли инкогнито — данные сайтов и файлы Masaki стёрты.
  await incog.app.close()
  opened.splice(opened.indexOf(incog.app), 1)
  const left = fs.existsSync(incogDir) ? fs.readdirSync(incogDir).filter((f) => f.endsWith('.json')) : []
  if (left.length) throw new Error('после закрытия инкогнито остались файлы: ' + left.join(', '))
  const again = await launch(['--incognito'])
  opened.push(again.app)
  if ((await cookies(again.app)).some((c) => c.startsWith('secret='))) throw new Error('кука пережила закрытие инкогнито')
  if ((await tabUrls(again.page)).some((u) => u && u.startsWith(site))) throw new Error('инкогнито восстановило вкладки прошлого раза')
  console.log('после закрытия ничего не осталось: ок')
  await again.app.close()
  opened.splice(opened.indexOf(again.app), 1)

  const history = JSON.parse(fs.existsSync(path.join(profile, 'history.json')) ? fs.readFileSync(path.join(profile, 'history.json'), 'utf8') : '[]')
  if (history.some((h) => h.url.startsWith(site))) throw new Error('адрес из инкогнито попал в историю профиля')
  console.log('история профиля чистая: ок')
} catch (e) {
  failed = true
  console.error('ОШИБКА:', e.message)
} finally {
  for (const a of opened) await a.close().catch(() => {})
  srv.close()
  fs.rmSync(profile, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
