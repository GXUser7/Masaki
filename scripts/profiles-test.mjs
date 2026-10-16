// Тест профилей (как в Chrome) и статуса в Discord.
// Профили: новый профиль из меню аккаунта открывается своим окном-процессом со своей папкой данных,
// открытый профиль не удалить, куки у профилей раздельные, имя видно в других окнах, удаление чистит папку.
// Discord: подставной канал discord-ipc (MASAKI_DISCORD_PIPE) и подставной YouCloud на localhost:5190 —
// статус «Слушает» с треком и обложкой, на паузе снимается, выключение аддона снимает его тоже.
// Запуск: npm run test:profiles. Снимки — test-output/profiles-*.png.
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'test-output')
fs.mkdirSync(out, { recursive: true })
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-profiles-'))
const PIPE = process.platform === 'win32' ? `\\\\?\\pipe\\masaki-test-discord-${process.pid}` : path.join(os.tmpdir(), `masaki-test-discord-${process.pid}`)
const env = { ...process.env, MASAKI_PROFILE: base, MASAKI_TEST_HEADLESS: process.env.MASAKI_TEST_HEADLESS ?? '1', MASAKI_TEST_INACTIVE: '1', MASAKI_DISCORD_PIPE: PIPE, MASAKI_DISCORD_APP_ID: '1234567890' }
const failures = []
const apps = []

function check(cond, msg) {
  if (cond) console.log('  ok —', msg)
  else {
    console.log('  ПРОВАЛ —', msg)
    failures.push(msg)
  }
}

async function waitFor(fn, what, ms = 30000) {
  const until = Date.now() + ms
  for (;;) {
    const v = await Promise.resolve()
      .then(fn)
      .catch(() => null)
    if (v) return v
    if (Date.now() > until) throw new Error('не дождались: ' + what)
    await new Promise((r) => setTimeout(r, 300))
  }
}

async function launch(args = []) {
  const app = await electron.launch({ args: [root, ...args], cwd: root, env, colorScheme: null, timeout: 60000 })
  apps.push(app)
  const page = await app.firstWindow()
  await page.waitForSelector('.stage', { timeout: 30000 })
  await page.waitForTimeout(600)
  return { app, page }
}

async function shot(app, name) {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(b64, 'base64'))
  console.log('  снимок', name)
}

/** Процессы Masaki (electron.exe) профиля — их Playwright не запускал, ищем по командной строке. */
function profilePids(id) {
  if (process.platform !== 'win32') return []
  const ps = `Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" | Where-Object { $_.CommandLine -like '*--profile=${id}*' } | ForEach-Object { $_.ProcessId }`
  return execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).split(/\s+/).filter(Boolean).map(Number)
}

// ---------- Подставной Discord ----------
const activities = []
let handshake = null
const discord = net.createServer((s) => {
  let buf = Buffer.alloc(0)
  s.on('data', (d) => {
    buf = Buffer.concat([buf, d])
    while (buf.length >= 8) {
      const op = buf.readUInt32LE(0)
      const len = buf.readUInt32LE(4)
      if (buf.length < 8 + len) break
      const msg = JSON.parse(buf.subarray(8, 8 + len).toString('utf8'))
      buf = buf.subarray(8 + len)
      const reply = (o) => {
        const j = Buffer.from(JSON.stringify(o))
        const h = Buffer.alloc(8)
        h.writeUInt32LE(1, 0)
        h.writeUInt32LE(j.length, 4)
        s.write(Buffer.concat([h, j]))
      }
      if (op === 0) {
        handshake = msg
        reply({ cmd: 'DISPATCH', evt: 'READY', data: { v: 1, user: { id: '1', username: 'test' } } })
      } else if (op === 1 && msg.cmd === 'SET_ACTIVITY') {
        activities.push(msg.args.activity ?? null)
        reply({ cmd: 'SET_ACTIVITY', nonce: msg.nonce, data: msg.args.activity ?? null })
      }
    }
  })
  s.on('error', () => {})
})
await new Promise((r) => discord.listen(PIPE, r))

// ---------- Подставной YouCloud ----------
const fixtures = path.join(root, 'scripts', 'fixtures')
const site = http.createServer((req, res) => {
  if (req.url === '/clip.webm') {
    res.writeHead(200, { 'Content-Type': 'video/webm' })
    fs.createReadStream(path.join(fixtures, 'clip.webm')).pipe(res)
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  fs.createReadStream(path.join(fixtures, 'youcloud-fake.html')).pipe(res)
})
const siteUp = await new Promise((resolve) => {
  site.once('error', () => resolve(false))
  site.listen(5190, '127.0.0.1', () => resolve(true))
})

let profileId = ''
try {
  console.log('Основной профиль: создаём второй из меню аккаунта')
  const A = await launch()
  const list1 = await A.page.evaluate(() => window.masaki.profiles.list())
  check(list1.length === 1 && list1[0].id === 'default' && list1[0].current, 'сначала один профиль — основной')
  await A.page.click('.achip')
  await A.page.waitForSelector('.pop.accounts')
  await A.page.click('.pop.accounts button.mi:has-text("Новый профиль")')
  const list2 = await waitFor(async () => {
    const l = await A.page.evaluate(() => window.masaki.profiles.list())
    return l.length === 2 ? l : null
  }, 'второй профиль в списке')
  profileId = list2.find((p) => p.id !== 'default').id
  const dir = path.join(base, 'Profiles', profileId)
  check(fs.existsSync(dir), `папка профиля Profiles/${profileId}`)
  // Свой процесс со своей папкой: Chromium кладёт туда lockfile, пока профиль открыт.
  await waitFor(() => fs.existsSync(path.join(dir, 'lockfile')), 'окно нового профиля', 40000)
  check(profilePids(profileId).length > 0, 'новый профиль открылся отдельным процессом')
  const busy = await A.page.evaluate((id) => window.masaki.profiles.remove(id), profileId)
  check(!busy.ok && /открыт/.test(busy.error ?? ''), 'открытый профиль удалить нельзя')
  check(fs.existsSync(dir), 'папка открытого профиля цела')
  for (const pid of profilePids(profileId)) {
    try {
      process.kill(pid)
    } catch {}
  }
  await waitFor(() => profilePids(profileId).length === 0, 'закрытие окна профиля')
  await new Promise((r) => setTimeout(r, 1000))

  console.log('Куки и данные у профилей раздельные')
  await A.app.evaluate(({ session }) =>
    session.fromPartition('persist:frost').cookies.set({ url: 'https://example.com', name: 'masaki_profile', value: 'default', expirationDate: Date.now() / 1000 + 3600 })
  )
  const B = await launch([`--profile=${profileId}`])
  const bData = await B.app.evaluate(({ app }) => app.getPath('userData'))
  check(path.resolve(bData) === path.resolve(dir), 'второе окно работает в папке своего профиля')
  const bCookies = await B.app.evaluate(({ session }) => session.fromPartition('persist:frost').cookies.get({ name: 'masaki_profile' }))
  check(bCookies.length === 0, 'куки основного профиля во втором не видны')
  const bList = await B.page.evaluate(() => window.masaki.profiles.list())
  check(bList.find((p) => p.current)?.id === profileId, 'второе окно знает, что оно — второй профиль')
  await B.page.evaluate((id) => window.masaki.profiles.rename(id, 'Работа'), profileId)
  await B.page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
  await B.page.click('.achip')
  await B.page.waitForSelector('.pop.accounts .pf-row')
  await B.page.waitForTimeout(400)
  check((await B.page.title()) === 'Работа — Masaki', 'заголовок окна — имя профиля')
  check((await B.page.locator('.achip small:has-text("Работа")').count()) === 1, 'на кнопке аккаунта видно имя профиля')
  await shot(B.app, 'profiles-01-second-window')
  await B.app.close()
  apps.splice(apps.indexOf(B.app), 1)

  await A.page.click('.pop-scrim').catch(() => {})
  await A.page.click('.achip')
  await A.page.waitForSelector('.pop.accounts .pf-row')
  await A.page.waitForTimeout(400)
  check((await A.page.locator('.pf-row .acc-t b:has-text("Работа")').count()) === 1, 'основное окно видит новое имя профиля')
  await shot(A.app, 'profiles-02-menu')
  await A.page.click(`.pf-row button[aria-label="Удалить «Работа»"]`)
  await A.page.click('.pf-confirm button:has-text("Удалить")')
  await waitFor(() => !fs.existsSync(dir), 'удаление папки профиля', 15000)
  check(true, 'закрытый профиль удалился вместе с папкой')
  const list3 = await A.page.evaluate(() => window.masaki.profiles.list())
  check(list3.length === 1, 'в списке снова один профиль')
  await A.page.click('.pop-scrim').catch(() => {})

  console.log('Статус в Discord')
  if (!siteUp) {
    console.log('  пропуск — порт 5190 занят (запущен дев-сервер YouCloud)')
  } else {
    await A.page.evaluate(async () => {
      const s = await window.masaki.settings.get()
      return s
    })
    // Включаем аддон на странице «Аддоны», как пользователь.
    await A.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('command', { type: 'addons' }))
    await A.page.waitForSelector('.addons-page')
    await A.page.click('button[role="switch"][aria-label="Статус в Discord"]')
    await A.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send('command', { type: 'open-url', url: 'http://localhost:5190/' })
    )
    const act = await waitFor(() => activities.findLast((a) => a?.details === 'Тестовый трек'), 'статус в Discord', 40000)
    check(handshake?.client_id === '1234567890', 'Masaki представился приложением Discord')
    check(act.type === 2, 'тип статуса — «Слушает»')
    check(act.state === 'Masaki Band', 'исполнитель в статусе')
    check(act.assets?.large_image === 'https://example.com/cover.jpg', 'обложка трека в статусе')
    check(act.assets?.large_text === 'Альбом для Discord', 'альбом в подсказке обложки')
    check(!!act.timestamps?.start && !!act.timestamps?.end, 'полоска времени трека')
    check(act.buttons?.[0]?.url?.startsWith('https://youcloud.'), 'кнопка «Открыть YouCloud»')
    await A.page.waitForTimeout(500)
    await shot(A.app, 'profiles-03-youcloud-playing')

    const before = activities.length
    await A.app.evaluate(async ({ webContents }) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('http://localhost:5190'))
      await wc.executeJavaScript('player.pause()')
    })
    await waitFor(() => activities.length > before && activities.at(-1) === null, 'снятие статуса на паузе', 20000)
    check(true, 'на паузе статус снят')

    await A.app.evaluate(async ({ webContents }) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('http://localhost:5190'))
      await wc.executeJavaScript('player.play()')
    })
    await waitFor(() => activities.at(-1)?.details === 'Тестовый трек', 'статус после паузы', 20000)
    check(true, 'продолжили играть — статус вернулся')
    await A.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('command', { type: 'addons' }))
    await A.page.waitForSelector('.addons-page')
    await A.page.click('button[role="switch"][aria-label="Статус в Discord"]')
    await waitFor(() => activities.at(-1) === null, 'снятие статуса при выключении', 10000)
    check(true, 'выключили аддон — статус снят')
  }
} catch (e) {
  failures.push(e.message)
  console.error('ОШИБКА:', e.message)
  if (apps[0]) await shot(apps[0], 'profiles-99-failure').catch(() => {})
} finally {
  for (const a of apps) await a.close().catch(() => {})
  if (profileId) for (const pid of profilePids(profileId)) {
    try {
      process.kill(pid)
    } catch {}
  }
  discord.close()
  site.close()
  await new Promise((r) => setTimeout(r, 1000))
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
}

if (failures.length) {
  console.log(`\nПровалов: ${failures.length}`)
  process.exit(1)
}
console.log('\nВсё прошло')
