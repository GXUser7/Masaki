// Тест переноса из Chrome на подставной папке Chrome (настоящий профиль пользователя не трогаем):
// закладки → избранное, ярлыки, история; повторный перенос не плодит дубли; избранное ищется в палитре.
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'test-output')
fs.mkdirSync(out, { recursive: true })
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-import-'))
const chrome = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-chrome-'))
fs.cpSync(path.join(root, 'scripts', 'fixtures', 'chrome'), chrome, { recursive: true })

// История Chrome — база SQLite; время в микросекундах от 1601 года.
const chromeTime = (ms) => BigInt(ms + 11644473600000) * 1000n
const db = new DatabaseSync(path.join(chrome, 'Default', 'History'))
db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER DEFAULT 0 NOT NULL, typed_count INTEGER DEFAULT 0 NOT NULL, last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0 NOT NULL)')
const add = db.prepare('INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, ?)')
const now = Date.now()
add.run('https://news.ycombinator.com/', 'Фикстура-история: Hacker News', 12, chromeTime(now - 3600_000), 0)
add.run('https://www.rust-lang.org/ru', 'Фикстура-история: Rust', 3, chromeTime(now - 86400_000), 0)
add.run('https://tracker.example/pixel', 'скрытая', 1, chromeTime(now - 7200_000), 1)
add.run('chrome://settings/', 'Настройки Chrome', 5, chromeTime(now - 600_000), 0)
db.close()

const app = await electron.launch({
  args: [root],
  cwd: root,
  env: { ...process.env, MASAKI_TEST_HEADLESS: process.env.MASAKI_TEST_HEADLESS ?? '1', MASAKI_TEST_INACTIVE: '1', MASAKI_PROFILE: profile, MASAKI_CHROME_DIR: chrome },
  timeout: 60000
})
const page = await app.firstWindow()
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
const shot = async (name) => {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(b64, 'base64'))
  console.log('снимок', name)
}
const section = '.settings section:has(h2:text("Перенос из Chrome"))'

let failed = false
try {
  await page.waitForSelector('.ntp', { timeout: 30000 })
  await page.waitForTimeout(1000)

  console.log('шаг раздел в настройках')
  await page.keyboard.press('Control+Comma')
  await page.waitForSelector(section + ' .set-row')
  await page.locator(section).scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  await shot('30-import-settings')
  const profiles = await page.$$eval(section + ' .seg button', (b) => b.map((x) => x.textContent?.trim()))
  console.log('профили:', profiles.join(', '))
  if (profiles.length !== 2) throw new Error('Не видно двух профилей Chrome')

  console.log('шаг перенос')
  await page.click(section + ' button.tonal:has-text("Перенести")')
  await page.waitForSelector(section + ' .ci-done', { timeout: 15000 })
  const first = await page.textContent(section + ' .ci-done')
  console.log(first)
  if (!/в избранное — 9/.test(first) || !/ярлыков — 1/.test(first) || !/страниц истории — 2/.test(first)) throw new Error('Перенеслось не то: ' + first)

  console.log('шаг повторный перенос без дублей')
  await page.click(section + ' button.tonal:has-text("Перенести")')
  await page.waitForFunction(() => /в избранное — 0/.test(document.querySelector('.ci-done')?.textContent ?? ''), null, { timeout: 15000 })
  const second = await page.textContent(section + ' .ci-done')
  console.log(second)
  if (!/страниц истории — 0/.test(second)) throw new Error('Повторный перенос задвоил историю: ' + second)

  console.log('шаг избранное в панели')
  const before = await page.$$eval('.favs .fvt', (b) => b.length)
  const moreLabel = await page.textContent('.fvt-more')
  await page.click('.fvt-more')
  await page.waitForTimeout(500)
  const after = await page.$$eval('.favs .fvt:not(.fvt-more)', (b) => b.length)
  console.log(`плиток: свёрнуто ${before} (${moreLabel?.trim()}), раскрыто ${after}`)
  if (before !== 8 || after !== 13) throw new Error('Раскрытие избранного работает не так')
  await shot('31-import-favorites')

  console.log('шаг палитра')
  await page.keyboard.press('Control+KeyK')
  await page.waitForSelector('.cmd input')
  await page.keyboard.type('Фикстура')
  await page.waitForTimeout(600)
  const rows = await page.$$eval('.cmd .row small', (r) => r.map((x) => x.textContent))
  console.log('строки палитры:', rows.join(' | '))
  if (!rows.some((r) => r?.startsWith('Избранное'))) throw new Error('Закладка не ищется в палитре')
  if (!rows.some((r) => r === 'news.ycombinator.com')) throw new Error('История Chrome не ищется в палитре')
  await shot('32-import-palette')
} catch (e) {
  failed = true
  console.error('ОШИБКА:', e.message)
  await shot('99-import-failure').catch(() => {})
} finally {
  fs.writeFileSync(path.join(out, 'import-console.log'), logs.join('\n'))
  await app.close().catch(() => {})
  fs.rmSync(profile, { recursive: true, force: true })
  fs.rmSync(chrome, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
