// Тест менеджера паролей: перенос скачанного CSV, автозаполнение, предложение сохранить/обновить,
// вход в два шага, «никогда», защита от подстановки на чужом сайте и шифрованная синхронизация
// паролей между двумя профилями через подставной Google. Все пароли тут выдуманные.
// Запуск: npm run test:passwords. Снимки — test-output/pw-*.png.
import { _electron as electron } from 'playwright'
import { clickGuest as clickGuestInput, guestKeys } from './electron-input.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { transformWithEsbuild } from 'vite'
import { startMockGoogle } from './mock-google.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Проверяем настоящий модуль без сети и профиля: Electron и хранилище заменены только на границе. */
async function testAutofillBoundaries() {
  const require = createRequire(import.meta.url)
  const filename = path.join(root, 'src/main/passwords.ts')
  const source = (await transformWithEsbuild(fs.readFileSync(filename, 'utf8'), filename, { format: 'cjs', target: 'es2022' })).code
  const cases = [
    ['https://login.example.com', 'https://app.example.com', true, 'поддомены одного сайта'],
    ['https://example.co.uk', 'https://accounts.example.co.uk', true, 'многочастный публичный суффикс'],
    ['https://alice.github.io', 'https://bob.github.io', false, 'разные сайты github.io'],
    ['https://alice.github.io', 'https://login.alice.github.io', true, 'поддомен своего сайта github.io'],
    ['https://alice.blogspot.com', 'https://bob.blogspot.com', false, 'разные сайты blogspot.com'],
    ['https://alice.pages.dev', 'https://bob.pages.dev', false, 'разные сайты pages.dev'],
    ['https://a.co.uk', 'https://b.co.uk', false, 'разные домены co.uk'],
    ['https://example.com', 'http://example.com', false, 'HTTPS-пароль на HTTP того же хоста'],
    ['https://login.example.com', 'http://app.example.com', false, 'HTTPS-пароль на HTTP поддомена'],
    ['http://login.example.com', 'https://app.example.com', true, 'HTTP-пароль после перехода на HTTPS'],
    ['http://login.example.com', 'http://app.example.com', true, 'HTTP-пароль на поддомене своего сайта'],
    ['https://example.com', 'https://attackerexample.com', false, 'похожее имя чужого домена'],
    ['https://example.com', 'https://example.com.attacker.test', false, 'домен сайта в чужом поддомене'],
    ['http://localhost:1000', 'http://localhost:1000', true, 'точный origin localhost'],
    ['http://localhost:1000', 'http://localhost:2000', false, 'разные порты localhost'],
    ['http://a.localhost:1000', 'http://b.localhost:1000', false, 'разные локальные хосты'],
    ['http://a.localhost:1000', 'http://login.a.localhost:1000', false, 'локальные поддомены независимы'],
    ['http://127.0.0.1:1000', 'http://127.0.0.1:1000', true, 'точный origin IPv4'],
    ['http://127.0.0.1:1000', 'http://127.0.0.1:2000', false, 'разные порты IPv4'],
    ['http://127.0.0.1:1000', 'http://127.0.0.2:1000', false, 'разные адреса IPv4'],
    ['http://[::1]:1000', 'http://[::1]:1000', true, 'точный origin IPv6'],
    ['http://[::1]:1000', 'http://[::1]:2000', false, 'разные порты IPv6'],
    ['http://intranet:1000', 'http://intranet:2000', false, 'разные локальные службы без домена']
  ]
  for (const [saved, target, allowed, label] of cases) {
    const module = { exports: {} }
    vm.runInNewContext(source, {
      module,
      exports: module.exports,
      Buffer,
      URL,
      setTimeout,
      clearTimeout,
      require: (id) => {
        if (id === 'electron') return {
          safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
          webContents: { getAllWebContents: () => [] },
          clipboard: {}
        }
        if (id === './store') return { JsonFile: class { async read() { return null } write() {} flushSync() {} } }
        return require(id)
      }
    }, { filename })
    const passwords = module.exports
    await passwords.initPasswords({ ui() {}, changed() {} })
    assert.equal(passwords.save({ url: saved, username: 'boundary-user', password: 'Boundary-Test-Only!' }).ok, true, label)
    const id = passwords.list()[0].id
    assert.equal(passwords.matchesFor(target).some((item) => item.id === id), allowed, `предложение: ${label}`)
    const messages = []
    passwords.fill({ isDestroyed: () => false, mainFrame: { origin: target }, send: (...args) => messages.push(args) }, id)
    assert.equal(messages.length, allowed ? 1 : 0, `отправка пароля: ${label}`)
    if (allowed) assert.equal(messages[0][1].password, 'Boundary-Test-Only!', label)
  }
  console.log(`  ok — границы автозаполнения: ${cases.length} сценария, проверены список и отправка пароля`)
}

await testAutofillBoundaries()
// Быстрый отдельный запуск без Electron: node scripts/passwords-test.mjs --boundaries-only.
if (process.argv.includes('--boundaries-only')) process.exit(0)

const out = path.join(root, 'test-output')
fs.mkdirSync(out, { recursive: true })
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const profiles = [tmp('masaki-pw-a-'), tmp('masaki-pw-b-')]
const downloads = tmp('masaki-pw-dl-')
const mock = await startMockGoogle()
const logs = []
const failures = []

function check(cond, msg) {
  if (cond) console.log('  ok —', msg)
  else {
    console.log('  ПРОВАЛ —', msg)
    failures.push(msg)
  }
}

// ---------- Сайт с формами входа ----------
const page = (body) => `<!doctype html><meta charset="utf-8"><title>Вход</title>
<style>body{font:16px sans-serif;padding:40px;background:#fff;color:#111}input,button{display:block;margin:10px 0;font:inherit;padding:8px;width:280px}</style>
${body}
<script>for (const i of document.querySelectorAll('input')) i.addEventListener('input', () => (document.body.dataset[i.id] = i.value))</script>`
let csvBody = ''
const site = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  const html = (b) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(page(b))
  }
  if (u.pathname === '/login')
    return html(`<form method="post" action="/done"><input id="user" name="username" autocomplete="username" placeholder="Логин"><input id="pass" type="password" name="password" autocomplete="current-password" placeholder="Пароль"><button id="go">Войти</button></form>`)
  if (u.pathname === '/signup')
    return html(`<form method="post" action="/done"><input id="email" type="email" name="email" placeholder="Почта"><input id="p1" type="password" autocomplete="new-password"><input id="p2" type="password" autocomplete="new-password"><button>Создать аккаунт</button></form>`)
  if (u.pathname === '/two-step')
    return html(`<form action="/two-step/pass" method="get"><input id="email" type="email" name="identifier" placeholder="Почта"><button id="next">Далее</button></form>`)
  if (u.pathname === '/two-step/pass') return html(`<form method="post" action="/done"><input id="pass" type="password" name="password"><button id="go">Войти</button></form>`)
  if (u.pathname === '/done') return html('<h1>Готово</h1>')
  if (u.pathname === '/export') {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="Google Passwords.csv"' })
    return res.end(csvBody)
  }
  res.writeHead(404)
  res.end()
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const port = site.address().port
const SITE = `http://127.0.0.1:${port}`
const OTHER = `http://localhost:${port}` // другой origin на том же сервере
csvBody = [
  'name,url,username,password,note',
  `Тестовый сайт,${SITE}/login,alice@example.com,Al1ce-Secret!,`,
  `Тестовый сайт,${SITE}/login,bob@example.com,B0b-Secret!,второй аккаунт`,
  'GitHub,https://github.com/login,octo,"pa,ss""word","заметка, с запятой"',
  'Приложение,android://hash@com.example.app/,x,y,'
].join('\r\n')

// ---------- Masaki ----------
async function launch(profile, tag) {
  const app = await electron.launch({
    args: [root],
    cwd: root,
    env: { ...process.env, MASAKI_TEST_HEADLESS: process.env.MASAKI_TEST_HEADLESS ?? '1', MASAKI_TEST_INACTIVE: '1', MASAKI_PROFILE: profile, MASAKI_SYNC_MOCK: mock.url, MASAKI_DOWNLOADS: downloads },
    timeout: 60000
  })
  const win = await app.firstWindow()
  win.on('console', (m) => logs.push(`[${tag} ${m.type()}] ${m.text()}`))
  win.on('pageerror', (e) => logs.push(`[${tag} pageerror] ${e.message}`))
  await win.waitForSelector('.stage', { timeout: 30000 })
  await win.waitForTimeout(500)
  return { app, win }
}

const command = (app, c) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('command', c), c)

async function waitFor(fn, what, ms = 15000) {
  const until = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > until) throw new Error('не дождались: ' + what)
    await new Promise((r) => setTimeout(r, 250))
  }
}

async function shot(app, name) {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(b64, 'base64'))
  console.log('  снимок', name)
}

/** Выполнить код в активной вкладке. */
async function inTab(m, code) {
  const id = await m.win.evaluate(() => document.querySelector('webview.wv.on')?.getWebContentsId())
  return m.app.evaluate(({ webContents }, [id, code]) => webContents.fromId(id).executeJavaScript(code), [id, code])
}

async function open(m, url) {
  await command(m.app, { type: 'open-url', url })
  await waitFor(async () => (await inTab(m, 'location.href').catch(() => '')) === url && (await inTab(m, 'document.readyState')) === 'complete', 'загрузка ' + url)
  await m.win.waitForTimeout(400)
}

/** Настоящий клик мышью по элементу внутри вкладки. */
async function clickIn(m, selector) {
  const r = await inTab(m, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  const wcId = await m.win.evaluate(() => document.querySelector('webview.wv.on').getWebContentsId())
  await clickGuestInput(m.app, wcId, r.x, r.y)
}

const list = (m) => m.win.evaluate(() => window.masaki.passwords.list())
const syncState = (m) => m.win.evaluate(() => window.masaki.sync.state())

async function signIn(m) {
  await m.win.evaluate(() => window.masaki.sync.setClient('masaki-test.apps.googleusercontent.com', 'test-secret'))
  await command(m.app, { type: 'settings' })
  await m.win.waitForSelector('.sy-cta')
  await m.win.click('.sy-cta')
  await waitFor(async () => {
    const s = await syncState(m)
    return s.account && s.lastSync > 0 && s.status === 'idle'
  }, 'вход в синхронизацию', 20000)
  await m.win.waitForTimeout(1600)
}

let current = null
try {
  // ---------- A: перенос CSV ----------
  console.log('A: перенос скачанного экспорта Google')
  const A = (current = await launch(profiles[0], 'A'))
  await command(A.app, { type: 'open-url', url: `${SITE}/export` })
  await A.win.waitForSelector('.pw-bar:has-text("Перенести")', { timeout: 15000 })
  await A.win.waitForTimeout(500)
  await A.win.waitForTimeout(700) // дождаться анимации появления
  await shot(A.app, 'pw-01-csv-found')
  const dlFile = path.join(downloads, 'Google Passwords.csv')
  check((await A.win.locator('webview').count()) === 0, 'вкладка, открытая ради скачивания, закрылась сама')
  check(fs.existsSync(dlFile), 'файл экспорта скачался в папку загрузок теста')
  await A.win.click('.pw-bar .perm-btn.primary')
  await A.win.waitForSelector('.pw-bar:has-text("Готово")')
  await shot(A.app, 'pw-01b-imported')
  await A.win.click('.pw-bar button:has-text("Закрыть")')
  const items = await list(A)
  check(items.length === 3, `перенесено 3 пароля (без android://), есть ${items.length}`)
  check(!fs.existsSync(dlFile), 'файл с открытыми паролями удалён')
  const gh = items.find((i) => i.host === 'github.com')
  check(gh && (await A.win.evaluate((id) => window.masaki.passwords.reveal(id), gh.id)) === 'pa,ss"word', 'кавычки и запятые в CSV разобраны верно')
  const storeFile = path.join(profiles[0], 'passwords.json')
  await waitFor(() => fs.existsSync(storeFile), 'запись passwords.json')
  const store = fs.readFileSync(storeFile, 'utf8')
  check(!store.includes('Al1ce-Secret!') && !store.includes('B0b-Secret!'), 'в профиле пароли лежат зашифрованными')

  // ---------- A: страница паролей ----------
  await command(A.app, { type: 'palette', withUrl: false })
  await A.win.waitForSelector('.cmd')
  await A.win.keyboard.type('masaki://passwords')
  await A.win.keyboard.press('Enter')
  await A.win.waitForSelector('.pw-page .pw-row')
  await A.win.locator('.pw-row', { hasText: 'alice@example.com' }).locator('button[aria-label="Показать пароль"]').click()
  await A.win.waitForSelector('.pw-dots.on')
  check((await A.win.locator('.pw-dots.on').textContent()) === 'Al1ce-Secret!', 'пароль показывается по кнопке')
  await shot(A.app, 'pw-02-page')

  // ---------- A: автозаполнение ----------
  console.log('A: автозаполнение')
  await open(A, `${SITE}/login`)
  await clickIn(A, '#user')
  await A.win.waitForSelector('.af-menu', { timeout: 8000 }).catch(async (e) => {
    console.log('  фокус во вкладке:', await inTab(A, 'document.activeElement?.id'), '· hasFocus:', await inTab(A, 'document.hasFocus()'))
    throw e
  })
  check((await A.win.locator('.af-row[role=option]').count()) === 2, 'в списке оба аккаунта сайта')
  await A.win.waitForTimeout(700) // дождаться анимации появления
  await shot(A.app, 'pw-03-autofill')
  await A.win.locator('.af-row', { hasText: 'bob@example.com' }).click()
  await waitFor(async () => (await inTab(A, 'document.querySelector("#pass").value')) === 'B0b-Secret!', 'пароль вписан')
  check((await inTab(A, 'document.querySelector("#user").value')) === 'bob@example.com', 'логин вписан')
  check((await inTab(A, 'document.body.dataset.pass')) === 'B0b-Secret!', 'страница получила событие input (React-формы увидят значение)')
  check((await A.win.locator('.af-menu').count()) === 0, 'список закрылся после выбора')

  // Стрелки и Enter: строку ведёт страница (фокус остаётся в поле), Enter подставляет её и форму не отправляет.
  await open(A, `${SITE}/login`)
  await clickIn(A, '#user')
  await A.win.waitForSelector('.af-menu')
  const wcA = await A.win.evaluate(() => document.querySelector('webview.wv.on').getWebContentsId())
  // Порядок — по свежести использования (bob только что подставляли), поэтому берём его из самого списка.
  const order = await A.win.locator('.af-row[role=option] b').allInnerTexts()
  const secrets = { 'alice@example.com': 'Al1ce-Secret!', 'bob@example.com': 'B0b-Secret!' }
  await guestKeys(A.app, wcA, ['ArrowDown'])
  await A.win.waitForSelector(`.af-row.on:has-text("${order[0]}")`, { timeout: 5000 })
  // Вниз до конца и по кругу, затем вверх — вторая строка.
  await guestKeys(A.app, wcA, ['ArrowDown', 'ArrowDown', 'ArrowUp'])
  await A.win.waitForSelector(`.af-row.on:has-text("${order[1]}")`, { timeout: 5000 })
  await shot(A.app, 'pw-03b-keyboard')
  await guestKeys(A.app, wcA, ['Enter'])
  await waitFor(async () => (await inTab(A, 'document.querySelector("#pass").value')) === secrets[order[1]], 'пароль вписан по Enter')
  check((await inTab(A, 'location.pathname')) === '/login', 'Enter на выбранной строке не отправил форму')
  check((await A.win.locator('.af-menu').count()) === 0, 'список закрылся после Enter')

  // Длинный список у поля внизу: открывается вверх, не уходит за край страницы (под док) и прокручивается.
  const fake = (channel, args) =>
    A.win.evaluate(([channel, args]) => document.querySelector('webview.wv.on').dispatchEvent(Object.assign(new Event('ipc-message'), { channel, args })), [channel, args])
  const wvH = await A.win.evaluate(() => document.querySelector('webview.wv.on').getBoundingClientRect().height)
  const dpr = await A.win.evaluate(() => devicePixelRatio)
  await fake('pw:show', [{ rect: { x: 40, y: wvH - 200, w: 320, h: 40 }, dpr, role: 'username', items: Array.from({ length: 14 }, (_, i) => ({ id: 'fake-' + i, username: `user${i}@example.com`, host: 'example.com' })) }])
  await A.win.waitForSelector('.af-menu')
  const box = await A.win.evaluate(() => {
    const m = document.querySelector('.af-menu')
    const w = document.querySelector('webview.wv.on').getBoundingClientRect()
    const r = m.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, pageTop: w.top, pageBottom: w.bottom, scrolls: m.scrollHeight > m.clientHeight + 4 }
  })
  check(box.top >= box.pageTop - 1 && box.bottom <= box.pageBottom + 1 && box.scrolls, 'длинный список в пределах страницы и прокручивается: ' + JSON.stringify(box))
  await fake('pw:sel', [13])
  await A.win.waitForTimeout(250)
  check(
    await A.win.evaluate(() => {
      const m = document.querySelector('.af-menu').getBoundingClientRect()
      const r = document.querySelector('.af-row.on').getBoundingClientRect()
      return r.top >= m.top - 1 && r.bottom <= m.bottom + 1
    }),
    'строка, выбранная стрелками, прокручена в вид'
  )
  await shot(A.app, 'pw-03c-long-list')
  await fake('pw:hide', [])

  // Чужой сайт: даже прямой запрос интерфейса не вписывает пароль.
  await open(A, `${OTHER}/login`)
  const wcOther = await A.win.evaluate(() => document.querySelector('webview.wv.on').getWebContentsId())
  await A.win.evaluate(([wc, id]) => window.masaki.passwords.fill(wc, id), [wcOther, items.find((i) => i.username === 'alice@example.com').id])
  await A.win.waitForTimeout(600)
  check((await inTab(A, 'document.querySelector("#pass").value')) === '', 'на другом сайте пароль не подставляется')
  await clickIn(A, '#user')
  await A.win.waitForTimeout(800)
  check((await A.win.locator('.af-menu').count()) === 0, 'на другом сайте список аккаунтов не показывается')

  // «Никогда» для другого сайта.
  await inTab(A, `document.querySelector('#user').value = 'eve'; document.querySelector('#pass').value = 'Eve-Secret!'; document.querySelector('form').requestSubmit()`)
  await A.win.waitForSelector('.pw-bar:has-text("Сохранить пароль")')
  await A.win.click('.pw-bar button:has-text("Никогда")')
  await open(A, `${OTHER}/login`)
  await inTab(A, `document.querySelector('#user').value = 'eve2'; document.querySelector('#pass').value = 'Eve2-Secret!'; document.querySelector('form').requestSubmit()`)
  await A.win.waitForTimeout(1200)
  check((await A.win.locator('.pw-bar').count()) === 0, '«Никогда для сайта» запомнилось')

  // ---------- A: предложение сохранить ----------
  console.log('A: сохранить, обновить, вход в два шага')
  await open(A, `${SITE}/signup`)
  await inTab(A, `document.querySelector('#email').value = 'carol@example.com'; document.querySelector('#p1').value = 'C4rol-New!'; document.querySelector('#p2').value = 'C4rol-New!'; document.querySelector('form').requestSubmit()`)
  await A.win.waitForSelector('.pw-bar:has-text("Сохранить пароль")', { timeout: 8000 })
  check((await A.win.locator('.pw-bar').textContent()).includes('carol@example.com'), 'в предложении верный логин')
  await A.win.waitForTimeout(700) // дождаться анимации появления
  await shot(A.app, 'pw-04-offer')
  await A.win.click('.pw-bar .perm-btn.primary')
  await waitFor(async () => (await list(A)).some((i) => i.username === 'carol@example.com'), 'новый пароль сохранён')
  check(true, 'новый пароль сохранён')

  await open(A, `${SITE}/login`)
  await inTab(A, `document.querySelector('#user').value = 'alice@example.com'; document.querySelector('#pass').value = 'Al1ce-Changed!'; document.querySelector('#go').click()`)
  await A.win.waitForSelector('.pw-bar:has-text("Обновить пароль")', { timeout: 8000 })
  await A.win.click('.pw-bar .perm-btn.primary')
  await A.win.waitForTimeout(300)
  const alice = (await list(A)).find((i) => i.username === 'alice@example.com')
  check((await A.win.evaluate((id) => window.masaki.passwords.reveal(id), alice.id)) === 'Al1ce-Changed!', 'пароль обновлён')

  await open(A, `${SITE}/two-step`)
  await inTab(A, `document.querySelector('#email').value = 'dave@example.com'; document.querySelector('#next').click()`)
  await waitFor(async () => (await inTab(A, 'location.pathname').catch(() => '')) === '/two-step/pass', 'второй шаг входа')
  await A.win.waitForTimeout(400)
  await inTab(A, `document.querySelector('#pass').value = 'D4ve-Secret!'; document.querySelector('#go').click()`)
  await A.win.waitForSelector('.pw-bar:has-text("Сохранить пароль")', { timeout: 8000 })
  check((await A.win.locator('.pw-bar').textContent()).includes('dave@example.com'), 'логин с первого шага подхвачен')
  await A.win.click('.pw-bar .perm-btn.primary')
  await A.win.waitForTimeout(300)

  // ---------- A: синхронизация паролей ----------
  console.log('A: шифрованная синхронизация паролей')
  await signIn(A)
  check((await syncState(A)).vault === 'off', 'пароли по умолчанию не синхронизируются')
  await A.win.click('button[aria-label="Синхронизировать пароли"]')
  await A.win.waitForSelector('.sy-vault:has-text("Придумайте ключ")', { timeout: 10000 })
  await A.win.fill('input[aria-label="Ключ шифрования паролей"]', 'кот-в-сапогах-42')
  await A.win.fill('input[aria-label="Ключ ещё раз"]', 'кот-в-сапогах-42')
  await A.win.locator('.sy-vault').scrollIntoViewIfNeeded()
  await shot(A.app, 'pw-05-vault-new')
  await A.win.click('.sy-vault button:has-text("Включить")')
  await waitFor(async () => (await syncState(A)).vault === 'ready', 'ключ принят', 20000)
  await waitFor(() => Object.keys(mock.file('vault.json')?.items ?? {}).length >= 5, 'пароли на Диске', 15000)
  const vaultRaw = JSON.stringify(mock.file('vault.json'))
  check(!/Al1ce|B0b|C4rol|D4ve|alice@|example\.com|127\.0\.0\.1/.test(vaultRaw), 'на Диске ни паролей, ни логинов, ни сайтов в открытом виде')
  const aCount = (await list(A)).length
  await A.app.close()
  current = null

  // ---------- B: подключение по ключу ----------
  console.log('B: пароли приходят после ввода ключа')
  const B = (current = await launch(profiles[1], 'B'))
  await signIn(B)
  await B.win.click('button[aria-label="Синхронизировать пароли"]')
  await B.win.waitForSelector('.sy-vault:has-text("Введите ключ")', { timeout: 10000 })
  await B.win.fill('input[aria-label="Ключ шифрования паролей"]', 'не-тот-ключ-123')
  await B.win.click('.sy-vault button:has-text("Подключить")')
  await B.win.waitForSelector('.sy-vault .err-text:has-text("не подходит")', { timeout: 15000 })
  check(true, 'чужой ключ не подходит')
  await B.win.locator('.sy-vault').scrollIntoViewIfNeeded()
  await shot(B.app, 'pw-06-vault-wrong-key')
  await B.win.fill('input[aria-label="Ключ шифрования паролей"]', 'кот-в-сапогах-42')
  await B.win.click('.sy-vault button:has-text("Подключить")')
  await waitFor(async () => (await list(B)).length === aCount, `на B пришли все ${aCount} паролей`, 20000)
  check(true, `на B пришли все ${aCount} паролей`)
  const carol = (await list(B)).find((i) => i.username === 'carol@example.com')
  check((await B.win.evaluate((id) => window.masaki.passwords.reveal(id), carol.id)) === 'C4rol-New!', 'пароль на B расшифрован верно')
  await B.win.evaluate((id) => window.masaki.passwords.remove(id), carol.id)
  await B.win.evaluate(() => window.masaki.sync.syncNow())
  await B.app.close()
  current = null

  console.log('A: удаление с B дошло')
  const A2 = (current = await launch(profiles[0], 'A2'))
  await waitFor(async () => !(await list(A2)).some((i) => i.username === 'carol@example.com'), 'удаление с B на A', 20000)
  check(true, 'удалённый на B пароль пропал и на A')
  await A2.app.close()
  current = null
} catch (e) {
  failures.push(e.message)
  console.error('ОШИБКА:', e.message)
  if (current) await shot(current.app, 'pw-99-failure').catch(() => {})
} finally {
  fs.writeFileSync(path.join(out, 'pw-console.log'), logs.join('\n'))
  if (current) await current.app.close().catch(() => {})
  await mock.close()
  site.close()
  for (const p of [...profiles, downloads]) {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    } catch {
      console.log('  не удалось удалить временную папку', p)
    }
  }
}
console.log(failures.length ? `\nПРОВАЛОВ: ${failures.length}` : '\nВсё прошло')
process.exit(failures.length ? 1 : 0)
