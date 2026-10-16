// Разрешения сайтов: камера и микрофон — разные решения, http и https одного хоста независимы,
// старые записи permissions.json переносятся, неоднозначное «media» сайт спрашивает заново.
// Сайты отдаёт перехват протоколов в тестовой сессии, камера и микрофон — подставные Chromium:
// настоящие устройства, интернет и профиль пользователя не используются. Запуск: npm run test:permissions.
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'test-output')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-permissions-'))
const profile = path.join(temp, 'profile')
for (const dir of [out, profile]) fs.mkdirSync(dir, { recursive: true })
const permissionsFile = path.join(profile, 'permissions.json')
// Формат по 0.5.1: хост без схемы, камера и микрофон — одно право media.
fs.writeFileSync(permissionsFile, JSON.stringify({
  'legacy.masaki.test|geolocation': true,
  'legacy.masaki.test|media': true,
  'localhost:5190|notifications': false,
  '[::1]:8080|geolocation': true,
  'Этот файл|geolocation': false
}))
const logs = []
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

const command = (c) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('command', c), c)
const activeId = () => win.evaluate(() => document.querySelector('webview.wv.on')?.getWebContentsId())
async function inTab(code) {
  const id = await activeId()
  return app.evaluate(({ webContents }, [id, code]) => webContents.fromId(id).executeJavaScript(code), [id, code])
}
async function open(url) {
  await command({ type: 'open-url', url })
  await waitFor(async () => (await inTab('location.href').catch(() => '')) === url &&
    (await inTab('document.readyState')) === 'complete', 'загрузка ' + url)
  await win.waitForTimeout(300)
}
async function shot(name) {
  await win.waitForTimeout(350)
  const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(b64, 'base64'))
}
const list = () => win.evaluate(() => window.masaki.permissions.list())
const decisions = async () => Object.fromEntries((await list()).map((p) => [p.origin + '|' + p.permission, p.allow]))

/** Запрос getUserMedia без ожидания: ответ сайта зависит от плашки. */
const media = (constraints) => inTab(`window.__media = 'wait'
  navigator.mediaDevices.getUserMedia(${JSON.stringify(constraints)}).then(
    (s) => { s.getTracks().forEach((t) => t.stop()); window.__media = 'ok' },
    (e) => { window.__media = e.name })
  1`)
const mediaResult = () => waitFor(async () => {
  const r = await inTab('window.__media')
  return r !== 'wait' && r
}, 'ответ getUserMedia')
async function prompt() {
  await win.waitForSelector('.perm', { timeout: 8000 })
  return { site: await win.locator('.perm-t b').innerText(), text: await win.locator('.perm-t').innerText() }
}
async function answer(button) {
  await win.click(`.perm-btn.${button}`)
  await win.waitForSelector('.perm', { state: 'detached', timeout: 5000 })
}
async function noPrompt(what) {
  await win.waitForTimeout(600)
  assert.equal(await win.locator('.perm').count(), 0, 'лишний вопрос: ' + what)
}

try {
  app = await electron.launch({
    args: [root], cwd: root, colorScheme: null,
    env: { ...process.env, MASAKI_TEST_HEADLESS: process.env.MASAKI_TEST_HEADLESS ?? '1', MASAKI_TEST_INACTIVE: '1', MASAKI_PROFILE: profile },
    timeout: 60000
  })
  win = await app.firstWindow()
  win.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
  win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  await win.waitForSelector('.stage', { timeout: 30000 })
  await app.evaluate(({ session }) => {
    const fixture = '<!doctype html><meta charset="utf-8"><title>Тест разрешений</title><h1>Локальная тестовая страница</h1>'
    for (const scheme of ['http', 'https']) {
      session.fromPartition('persist:frost').protocol.handle(scheme, () => new Response(fixture, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
      }))
    }
  })

  // 1. Перенос старых записей: схема по правилам Chromium, media — спросить заново, файл переписан.
  assert.deepEqual(await decisions(), {
    'https://legacy.masaki.test|geolocation': true,
    'http://localhost:5190|notifications': false,
    'http://[::1]:8080|geolocation': true,
    'file://|geolocation': false
  })
  const sites = Object.fromEntries((await list()).map((p) => [p.origin, p.site]))
  assert.equal(sites['https://legacy.masaki.test'], 'legacy.masaki.test')
  assert.equal(sites['http://localhost:5190'], 'http://localhost:5190')
  assert.equal(sites['file://'], 'Этот файл')
  await waitFor(() => !Object.keys(JSON.parse(fs.readFileSync(permissionsFile, 'utf8'))).some((k) => k.endsWith('|media')), 'перезапись permissions.json')
  console.log('ok — старые решения перенесены, неоднозначное media удалено')

  // 2. Сохранённый микрофон не открывает камеру.
  await open('https://legacy.masaki.test/')
  await media({ audio: true })
  let p = await prompt()
  assert.equal(p.site, 'legacy.masaki.test')
  assert.match(p.text, /микрофон/)
  assert.doesNotMatch(p.text, /камер/)
  await shot('permissions-01-mic')
  await answer('primary')
  assert.equal(await mediaResult(), 'ok')

  await media({ video: true })
  p = await prompt()
  assert.match(p.text, /камеру/, 'разрешённый микрофон выдал камеру без вопроса')
  assert.doesNotMatch(p.text, /микрофон/)
  await shot('permissions-02-camera')
  await answer('ghost')
  assert.equal(await mediaResult(), 'NotAllowedError')

  await media({ audio: true })
  assert.equal(await mediaResult(), 'ok')
  await noPrompt('микрофон уже разрешён')
  // Камера запрещена — запрос «камера и микрофон» целиком отклоняется без вопроса.
  await media({ audio: true, video: true })
  assert.equal(await mediaResult(), 'NotAllowedError')
  await noPrompt('камера уже запрещена')
  assert.deepEqual(await inTab(`Promise.all(['microphone', 'camera'].map((name) => navigator.permissions.query({ name }).then((s) => s.state)))`), ['granted', 'denied'])
  const after = await decisions()
  assert.equal(after['https://legacy.masaki.test|microphone'], true)
  assert.equal(after['https://legacy.masaki.test|camera'], false)
  console.log('ok — камера и микрофон решаются отдельно; запрет камеры отклоняет общий запрос')

  // 3. Оба права сразу: один вопрос, «Разрешить» запоминает оба.
  await open('https://both.masaki.test/')
  await media({ audio: true, video: true })
  p = await prompt()
  assert.match(p.text, /камеру и микрофон/)
  await answer('primary')
  assert.equal(await mediaResult(), 'ok')
  const both = await decisions()
  assert.equal(both['https://both.masaki.test|camera'], true)
  assert.equal(both['https://both.masaki.test|microphone'], true)

  // 4. http и https одного хоста — разные сайты (localhost — защищённый контекст и без TLS).
  await open('https://localhost/')
  await media({ audio: true })
  p = await prompt()
  assert.equal(p.site, 'localhost')
  await answer('primary')
  assert.equal(await mediaResult(), 'ok')
  await open('http://localhost/')
  await media({ audio: true })
  p = await prompt()
  assert.equal(p.site, 'http://localhost', 'решение https досталось http того же хоста')
  await shot('permissions-03-http')
  await answer('tonal-b')
  assert.equal(await mediaResult(), 'ok')
  const schemes = await decisions()
  assert.equal(schemes['https://localhost|microphone'], true)
  assert.equal(schemes['http://localhost|microphone'], undefined, '«Только сейчас» не запоминается')
  console.log('ok — http и https одного хоста решаются отдельно, «Только сейчас» не запоминается')

  // 5. Сброс из настроек: сайт снова спрашивает.
  await win.evaluate(() => window.masaki.permissions.forget('https://legacy.masaki.test', 'microphone'))
  await open('https://legacy.masaki.test/again')
  await media({ audio: true })
  p = await prompt()
  assert.match(p.text, /микрофон/)
  await answer('ghost')
  assert.equal(await mediaResult(), 'NotAllowedError')
  console.log('ok — сброшенное решение спрашивается снова')
} catch (e) {
  process.exitCode = 1
  console.error(e)
  if (app && win) await shot('permissions-99-failure').catch(() => {})
} finally {
  fs.writeFileSync(path.join(out, 'permissions-console.log'), logs.join('\n'))
  if (app) await app.close().catch(() => {})
}

// 6. Выход сохранил решения на диск (flushSync) в новом формате.
if (!process.exitCode) {
  try {
    const saved = JSON.parse(fs.readFileSync(permissionsFile, 'utf8'))
    assert.equal(saved['https://legacy.masaki.test|microphone'], false)
    assert.equal(saved['https://legacy.masaki.test|camera'], false)
    assert.equal(saved['https://localhost|microphone'], true)
    assert.ok(Object.keys(saved).every((k) => k.includes('://')), 'на диске остались ключи без схемы')
    console.log('ok — после выхода permissions.json в новом формате')
  } catch (e) {
    process.exitCode = 1
    console.error(e)
  }
}
// Папка создана mkdtemp выше: очистка ограничена временными данными именно этого теста.
fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
