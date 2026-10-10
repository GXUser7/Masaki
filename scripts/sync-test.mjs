// Тест синхронизации на подставном Google (scripts/mock-google.mjs): два профиля Masaki по очереди
// входят в один «аккаунт» и обмениваются избранным, оформлением, историей и вкладками.
// Запуск: npm run test:sync. Снимки — test-output/sync-*.png.
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockGoogle } from './mock-google.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'test-output')
fs.mkdirSync(out, { recursive: true })
const mock = await startMockGoogle()
const profiles = [0, 1].map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-sync-')))
const logs = []
const failures = []

function check(cond, msg) {
  if (cond) console.log('  ok —', msg)
  else {
    console.log('  ПРОВАЛ —', msg)
    failures.push(msg)
  }
}

async function launch(profile, tag) {
  const app = await electron.launch({
    args: [root],
    cwd: root,
    env: { ...process.env, MASAKI_TEST_INACTIVE: '1', MASAKI_PROFILE: profile, MASAKI_SYNC_MOCK: mock.url },
    timeout: 60000
  })
  const page = await app.firstWindow()
  page.on('console', (m) => logs.push(`[${tag} ${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => logs.push(`[${tag} pageerror] ${e.message}`))
  // Вкладки восстанавливаются из прошлой сессии, поэтому ждём саму страницу, а не новую вкладку.
  await page.waitForSelector('.stage', { timeout: 30000 })
  await page.waitForTimeout(500)
  return { app, page }
}

const command = (app, c) =>
  app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('command', c), c)
const state = (page) => page.evaluate(() => window.masaki.sync.state())
const mainSettings = (page) => page.evaluate(() => window.masaki.settings.get())

async function waitFor(fn, what, ms = 20000) {
  const until = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > until) throw new Error('не дождались: ' + what)
    await new Promise((r) => setTimeout(r, 300))
  }
}

async function shot(app, name) {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(b64, 'base64'))
  console.log('  снимок', name)
}

async function openSettings(app, page) {
  await command(app, { type: 'settings' })
  await page.waitForSelector('.sy-section')
  await page.waitForTimeout(500)
}

async function addFavorite(page, title, url) {
  const sec = page.locator('section', { has: page.locator('h2', { hasText: 'Избранное в боковой панели' }) })
  await sec.locator('input[aria-label="Название"]').fill(title)
  await sec.locator('input[aria-label="Адрес"]').fill(url)
  await sec.locator('button:has-text("Добавить")').click()
}

async function connectAndSignIn(app, page, shotName) {
  const r = await page.evaluate(() => window.masaki.sync.setClient('masaki-test.apps.googleusercontent.com', 'test-secret'))
  check(r.ok, 'ключ принят')
  await page.waitForSelector('.sy-cta')
  if (shotName) await shot(app, shotName)
  await page.click('.sy-cta')
  // Вкладка входа: подставной Google сразу «разрешает» и возвращает на локальный адрес Masaki.
  await waitFor(async () => {
    const s = await state(page)
    return s.account && s.lastSync > 0 && s.status === 'idle'
  }, 'вход и первая синхронизация')
  await page.waitForTimeout(1800) // вкладка «Готово» закрывается, возвращаемся в настройки
}

let current = null
try {
  // ---------- Компьютер A ----------
  console.log('Компьютер A: ключ, вход, первые данные')
  let A = (current = await launch(profiles[0], 'A'))
  await openSettings(A.app, A.page)
  await shot(A.app, 'sync-01-no-key')
  await A.page.click('.swatches .swatch:nth-child(3)')
  const paletteName = await A.page.locator('.swatch-name').textContent()
  await addFavorite(A.page, 'Только на A', `${mock.url}/page/Fav-A`)
  await A.page.waitForTimeout(300)
  const aPalette = (await mainSettings(A.page)).palette
  await connectAndSignIn(A.app, A.page, 'sync-02-key-ready')
  await shot(A.app, 'sync-03-signed-in')
  const prefs1 = mock.file('prefs.json')
  check(prefs1?.fields.palette?.v === aPalette, `палитра A на Диске (${aPalette})`)
  check(prefs1?.fields.favorites?.v.some((f) => f.title === 'Только на A'), 'избранное A на Диске')
  check(!JSON.stringify(prefs1).includes('sidebarCollapsed'), 'свёрнутость панели не синхронизируется')

  await command(A.app, { type: 'open-url', url: `${mock.url}/page/Masaki-Remote-Tab` })
  await A.page.waitForTimeout(2500)
  await A.page.evaluate(() => window.masaki.sync.syncNow())
  const devFile = mock.names().find((n) => n.startsWith('device-'))
  check(!!devFile && mock.file(devFile).tabs.some((t) => t.url.endsWith('/page/Masaki-Remote-Tab')), 'вкладки A на Диске')
  check(mock.file('history.json')?.entries.some((e) => e.url.endsWith('/page/Masaki-Remote-Tab')), 'история A на Диске')
  await A.app.close()
  current = null

  // ---------- Компьютер B ----------
  console.log('Компьютер B: своё избранное, вход, слияние')
  const B = (current = await launch(profiles[1], 'B'))
  await openSettings(B.app, B.page)
  await addFavorite(B.page, 'Только на B', `${mock.url}/page/Fav-B`)
  await B.page.waitForTimeout(300)
  await connectAndSignIn(B.app, B.page)
  const bSettings = await mainSettings(B.page)
  check(bSettings.palette === aPalette, 'палитра пришла из аккаунта')
  check(bSettings.favorites.some((f) => f.title === 'Только на A') && bSettings.favorites.some((f) => f.title === 'Только на B'), 'избранное объединилось')
  check((await B.page.locator('.swatch-name').textContent()) === paletteName, 'интерфейс B показывает пришедшую палитру')
  check((await B.page.locator('.sc-item:has-text("Только на A")').count()) > 0, 'интерфейс B показывает пришедшее избранное')
  const bHistory = await B.page.evaluate(() => window.masaki.history.list())
  check(bHistory.some((e) => e.url.endsWith('/page/Masaki-Remote-Tab')), 'история A пришла на B')
  const bState = await state(B.page)
  check(bState.devices.length === 1 && bState.devices[0].tabs.some((t) => t.url.endsWith('/page/Masaki-Remote-Tab')), 'B видит вкладки A')
  await B.page.locator('.sy-section').scrollIntoViewIfNeeded()
  await B.page.locator('.sy-devs').scrollIntoViewIfNeeded()
  await B.page.waitForTimeout(300)
  await shot(B.app, 'sync-04-devices')

  await command(B.app, { type: 'palette', withUrl: false })
  await B.page.waitForSelector('.cmd')
  await B.page.keyboard.type('Remote-Tab', { delay: 20 })
  await B.page.waitForTimeout(700)
  check((await B.page.locator('.row:has-text("На устройстве")').count()) > 0, 'палитра находит вкладку с другого устройства')
  await shot(B.app, 'sync-05-palette-remote')
  await B.page.keyboard.press('Escape')

  await B.page.click('.achip')
  await B.page.waitForSelector('.pop.accounts')
  await B.page.waitForTimeout(400)
  await shot(B.app, 'sync-06-accounts-menu')
  await B.page.click('.pop-scrim')

  await B.page.click('.seg button:has-text("Светлая")')
  await waitFor(() => mock.file('prefs.json')?.fields.scheme?.v === 'light', 'тема B на Диске', 15000)
  check(true, 'светлая тема B ушла на Диск')
  await B.app.close()
  current = null

  // ---------- Снова A ----------
  console.log('Компьютер A: подхватывает изменения B, очистка истории, отзыв доступа')
  A = current = await launch(profiles[0], 'A2')
  await waitFor(async () => (await mainSettings(A.page)).scheme === 'light', 'тема с B на A', 20000)
  const aSettings = await mainSettings(A.page)
  check(aSettings.favorites.some((f) => f.title === 'Только на B'), 'избранное B пришло на A')
  check((await A.page.locator('.app.light').count()) > 0, 'интерфейс A перекрасился в светлую тему без перезапуска')
  await openSettings(A.app, A.page)
  await shot(A.app, 'sync-07-a-light')

  await A.page.evaluate(() => window.masaki.history.clear())
  await A.page.waitForTimeout(200)
  await A.page.evaluate(() => window.masaki.sync.syncNow())
  const hist = mock.file('history.json')
  check(hist && hist.entries.length === 0 && hist.clearedAt > 0, 'очистка истории ушла на Диск')

  mock.revokeAll()
  await A.page.evaluate(() => window.masaki.sync.syncNow())
  await waitFor(async () => (await state(A.page)).status === 'signin', 'просьба войти снова')
  await A.page.waitForTimeout(400)
  await shot(A.app, 'sync-08-signin-again')

  await A.page.click('button:has-text("Выйти из синхронизации")')
  await waitFor(async () => !(await state(A.page)).account, 'выход')
  check(mock.log.includes('POST /revoke'), 'при выходе токен отозван')
  await A.page.waitForTimeout(400)
  await shot(A.app, 'sync-09-signed-out')
  const authFile = path.join(profiles[0], 'sync-auth.bin')
  check(fs.existsSync(authFile) && !fs.readFileSync(authFile).includes(Buffer.from('test-secret')), 'ключ в профиле лежит зашифрованным')
  await A.app.close()
  current = null
} catch (e) {
  failures.push(e.message)
  console.error('ОШИБКА:', e.message)
  if (current) await shot(current.app, 'sync-99-failure').catch(() => {})
} finally {
  fs.writeFileSync(path.join(out, 'sync-console.log'), logs.join('\n'))
  if (current) await current.app.close().catch(() => {})
  await mock.close()
  for (const p of profiles) {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    } catch {
      console.log('  не удалось удалить временный профиль', p)
    }
  }
}
console.log(failures.length ? `\nПРОВАЛОВ: ${failures.length}` : '\nВсё прошло')
process.exit(failures.length ? 1 : 0)
