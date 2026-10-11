// Тест «Управления для ИИ» и браузера по умолчанию. Masaki запускается сам (не через Playwright —
// тот добавил бы свой порт отладки), с включённым портом 9222 и ссылкой в командной строке, как его
// запускает Windows. Агент подключается к порту так же, как chrome-devtools-mcp, и управляет вкладкой.
// Регистрация в Windows пишется под именем MasakiTest (MASAKI_REG_NAME) и в конце удаляется.
// Запуск: npm run test:system. Снимки — test-output/system-*.png.
import { chromium } from 'playwright'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'test-output')
fs.mkdirSync(out, { recursive: true })
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'Electron.app/Contents/MacOS/Electron')
const PORT = 9222
const REG_NAME = 'MasakiTest'
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-system-'))
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ aiControl: true }))
const first = path.join(root, 'scripts', 'fixtures', 'light.html')
const second = path.join(root, 'scripts', 'fixtures', 'dark.html')
const failures = []
const procs = []

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
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() > until) throw new Error('не дождались: ' + what)
    await new Promise((r) => setTimeout(r, 300))
  }
}

const env = { ...process.env, MASAKI_PROFILE: profile, MASAKI_TEST_INACTIVE: '1', MASAKI_REG_NAME: REG_NAME }
const launch = (file) => {
  const p = spawn(electron, [root, file], { env, stdio: 'ignore' })
  procs.push(p)
  return p
}
const targets = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())

/** Соединение CDP с одной целью: send(method, params) → result. */
async function cdp(url) {
  const ws = new WebSocket(url)
  const waiting = new Map()
  let id = 0
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    const done = waiting.get(msg.id)
    if (!done) return
    waiting.delete(msg.id)
    if (msg.error) done.reject(new Error(msg.error.message))
    else done.resolve(msg.result)
  }
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  return {
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        waiting.set(++id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      }),
    close: () => ws.close()
  }
}
const regQuery = (key, value) => {
  try {
    return execFileSync('reg', ['query', `HKCU\\${key}`, ...(value ? ['/v', value] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}
function regCleanup() {
  for (const k of [`Software\\Clients\\StartMenuInternet\\${REG_NAME}`, `Software\\Classes\\${REG_NAME}URL`, `Software\\Classes\\${REG_NAME}HTML`]) {
    try {
      execFileSync('reg', ['delete', `HKCU\\${k}`, '/f'], { stdio: 'ignore' })
    } catch {}
  }
  try {
    execFileSync('reg', ['delete', 'HKCU\\Software\\RegisteredApplications', '/v', REG_NAME, '/f'], { stdio: 'ignore' })
  } catch {}
  for (const ext of ['.htm', '.html', '.shtml', '.xht', '.xhtml', '.pdf', '.svg', '.webp']) {
    try {
      execFileSync('reg', ['delete', `HKCU\\Software\\Classes\\${ext}\\OpenWithProgids`, '/v', `${REG_NAME}HTML`, '/f'], { stdio: 'ignore' })
    } catch {}
  }
}

let browser = null
try {
  if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) {
    throw new Error(`порт ${PORT} уже занят (открыт Masaki с «Управлением для ИИ» или другой браузер с отладкой) — закройте его`)
  }

  console.log('Запуск с портом для ИИ и ссылкой в командной строке')
  launch(first)
  const version = await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(), `порт ${PORT}`)
  check(/^Chrome\//.test(version.Browser), `порт ${PORT} открыт (${version.Browser})`)
  const firstUrl = pathToFileURL(first).href
  await waitFor(async () => (await targets()).some((t) => t.type === 'webview' && t.url === firstUrl), 'вкладка из командной строки')
  check(true, 'ссылка из командной строки открылась вкладкой при первом запуске')

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  const ctx = browser.contexts()[0]
  const ui = ctx.pages().find((p) => p.url().includes('/renderer/index.html'))
  check(!!ui, 'агент видит интерфейс Masaki')
  const st = await ui.evaluate(() => window.masaki.system.aiControl())
  check(st.port === PORT && st.listening, 'Masaki знает, что порт открыл он')

  // Управление вкладкой — как это делает chrome-devtools-mcp: прямо по CDP цели webview. Playwright тут
  // не годится: к целям webview, открытым до подключения, он не цепляется.
  const target = (await targets()).find((t) => t.type === 'webview' && t.url === firstUrl)
  const tab = await cdp(target.webSocketDebuggerUrl)
  await tab.send('Runtime.evaluate', {
    expression: `document.body.insertAdjacentHTML('beforeend', '<input id="agent-input" style="font-size:28px">'); document.getElementById('agent-input').focus()`
  })
  await tab.send('Input.insertText', { text: 'Привет от агента' })
  const typed = await tab.send('Runtime.evaluate', { expression: `document.getElementById('agent-input').value`, returnByValue: true })
  check(typed.result.value === 'Привет от агента', 'агент печатает во вкладке')
  const shot = await tab.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(out, 'system-01-agent-tab.png'), Buffer.from(shot.data, 'base64'))
  console.log('  снимок system-01-agent-tab')
  tab.close()

  console.log('Вторая копия Masaki передаёт ссылку открытому окну')
  launch(second)
  const secondUrl = pathToFileURL(second).href
  await waitFor(async () => (await targets()).some((t) => t.type === 'webview' && t.url === secondUrl), 'вкладка от второй копии')
  check(true, 'ссылка от второй копии открылась вкладкой')

  console.log('Настройки: управление для ИИ и браузер по умолчанию')
  // Через меню, как человек: Ctrl+, по CDP ушёл бы во вкладку, где фокус.
  await ui.click('button.ib[aria-label="Меню"] >> nth=0')
  await ui.click('.mi:has-text("Настройки")')
  await ui.waitForSelector('.settings')
  const section = ui.locator('section', { has: ui.locator('h2', { hasText: 'Браузер по умолчанию' }) })
  await section.scrollIntoViewIfNeeded()
  await ui.evaluate(() => {
    const h = [...document.querySelectorAll('.settings h2')].find((x) => x.textContent === 'Браузер по умолчанию')
    h?.closest('section')?.scrollIntoView({ block: 'start' })
  })
  await ui.waitForTimeout(500)
  check((await ui.locator('text=Разрешить ИИ-агентам управлять Masaki').count()) === 1, 'в настройках есть «Управление для ИИ»')
  check((await ui.locator(`text=Агент подключается к http://127.0.0.1:${PORT}`).count()) === 1, 'настройки показывают, что порт открыт')
  await ui.screenshot({ path: path.join(out, 'system-02-settings.png') })
  console.log('  снимок system-02-settings')

  await section.locator('button:has-text("Сделать основным")').click()
  const caps = `Software\\Clients\\StartMenuInternet\\${REG_NAME}\\Capabilities`
  await waitFor(async () => regQuery(`${caps}\\URLAssociations`, 'https').includes(`${REG_NAME}URL`), 'запись в реестре', 10000)
  check(true, 'https связан с MasakiTestURL')
  check(regQuery('Software\\RegisteredApplications', REG_NAME).includes(caps), 'Masaki в списке программ Windows (RegisteredApplications)')
  check(regQuery(`${caps}\\FileAssociations`, '.html').includes(`${REG_NAME}HTML`), '.html связан с MasakiTestHTML')
  const cmd = regQuery(`Software\\Classes\\${REG_NAME}URL\\shell\\open\\command`)
  check(cmd.includes(`"${electron}" "%1"`), 'команда открытия ссылки — exe с адресом')

  // Выключаем: после перезапуска порт закрыт (сам перезапуск не проверяем — он перезапустил бы без теста).
  await ui.click('button[role="switch"][aria-label="Управление для ИИ"]')
  await ui.waitForTimeout(400)
  check((await ui.locator('text=Порт закроется после перезапуска Masaki').count()) === 1, 'выключение просит перезапуск')
  await ui.screenshot({ path: path.join(out, 'system-03-settings-off.png') })
  console.log('  снимок system-03-settings-off')
} catch (e) {
  failures.push(e.message)
  console.error('ОШИБКА:', e.message)
} finally {
  await browser?.close().catch(() => {})
  for (const p of procs) p.kill()
  regCleanup()
  check(!regQuery(`Software\\Clients\\StartMenuInternet\\${REG_NAME}`), 'тестовая регистрация удалена')
  await new Promise((r) => setTimeout(r, 1500))
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
}

if (failures.length) {
  console.log(`\nПровалов: ${failures.length}`)
  process.exit(1)
}
console.log('\nВсё прошло')
