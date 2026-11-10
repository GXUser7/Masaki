// Узкая регрессия: ленивые вкладки, выгрузка webview и непрозрачный YouCloud.
// Только локальные страницы, отдельный профиль и скрытое окно без звука.
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { clickGuest } from './electron-input.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-tab-memory-'))
const output = path.join(root, 'test-output')
fs.mkdirSync(output, { recursive: true })
const requests = new Map()
const site = http.createServer((req, res) => {
  const route = new URL(req.url, 'http://localhost').pathname
  requests.set(route, (requests.get(route) ?? 0) + 1)
  if (route === '/clip.webm') {
    res.setHeader('content-type', 'video/webm')
    return res.end(fs.readFileSync(path.join(root, 'scripts/fixtures/clip.webm')))
  }
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(`<!doctype html><meta charset="utf-8"><title>${route.slice(1) || 'landing'}</title>
    <style>body{background:#152221;color:#e2f1e9;font:20px sans-serif;margin:40px;min-height:2600px}a,input{display:block;margin:20px;padding:14px}</style>
    <script>localStorage.setItem('boots:'+location.pathname, Number(localStorage.getItem('boots:'+location.pathname) || 0)+1)</script>
    <h1>${route}</h1><a id="middle" href="/middle">Средняя кнопка</a><a id="next" href="/second">Далее</a>
    <input id="draft"><div contenteditable id="editor">Черновик</div>
    ${route === '/iframe' ? '<iframe src="/embedded"></iframe>' : ''}
    ${route === '/video' || route === '/music' ? `<script>window.player=new Audio('/clip.webm');player.loop=true;player.muted=true;player.play();navigator.mediaSession.metadata=new MediaMetadata({title:'Музыка для теста'});navigator.mediaSession.playbackState='playing'</script>` : ''}`)
})
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
const base = `http://localhost:${site.address().port}`
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ sidebarCollapsed: false, sleepAfter: 0, addons: { adblock: { enabled: false } } }))
fs.writeFileSync(path.join(profile, 'session.json'), JSON.stringify({ active: 0, tabs: [
  { url: base + '/landing', title: 'landing' },
  { url: base + '/video', title: 'video' },
  { url: base + '/untouched', title: 'untouched' }
] }))
let app, page, mainId
const errors = []
const command = (c) => app.evaluate(({ BrowserWindow }, [id, c]) => BrowserWindow.fromId(id).webContents.send('command', c), [mainId, c])
const currentId = () => page.evaluate(() => {
  try { return document.querySelector('webview.wv.on')?.getWebContentsId() } catch { return undefined }
})
const inGuest = (id, code) => app.evaluate(({ webContents }, [id, code]) => webContents.fromId(id).executeJavaScript(code), [id, code])
const exists = (id) => app.evaluate(({ webContents }, id) => !!webContents.fromId(id), id)
async function waitFor(fn, label, timeout = 12_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error('Не дождались: ' + label)
}
async function open(route) {
  await command({ type: 'open-url', url: base + route })
  await waitFor(async () => await inGuest(await currentId(), 'location.pathname + ":" + document.readyState').catch(() => '') === route + ':complete', route)
  return currentId()
}
async function activate(title) {
  await page.locator('.tab-main').filter({ hasText: title }).first().click()
  await waitFor(async () => await inGuest(await currentId(), 'document.readyState').catch(() => '') === 'complete', title)
  return currentId()
}
async function click(id, selector, options) {
  const point = await inGuest(id, `(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2] })()`)
  await clickGuest(app, id, ...point, options)
}
async function settings(patch) {
  await page.evaluate(async (patch) => {
    const s = await window.masaki.settings.get()
    window.masaki.settings.set({ ...s, ...patch })
  }, patch)
  // Как при изменении из UI: главный процесс сообщает новое состояние интерфейсу.
  const value = await page.evaluate(() => window.masaki.settings.get())
  await app.evaluate(({ BrowserWindow }, [id, value]) => BrowserWindow.fromId(id).webContents.send('settings-changed', value), [mainId, value])
}
async function shot(name) {
  await page.waitForTimeout(650)
  const png = await app.evaluate(async ({ BrowserWindow }, id) => (await BrowserWindow.fromId(id).capturePage()).toPNG().toString('base64'), mainId)
  fs.writeFileSync(path.join(output, `tab-memory-${name}.png`), Buffer.from(png, 'base64'))
}

const watchdog = setTimeout(() => { console.error('Превышен лимит 180 секунд'); app?.process().kill(); process.exit(1) }, 180_000)
try {
  const env = { ...process.env, MASAKI_PROFILE: profile, MASAKI_TEST_HEADLESS: '1', MASAKI_TEST_INACTIVE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [root], cwd: root, env, colorScheme: null })
  page = await app.firstWindow()
  mainId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id)
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('webview.wv.on')
  await waitFor(async () => await inGuest(await currentId(), 'document.readyState').catch(() => '') === 'complete', 'старт')
  assert.equal(await page.locator('webview').count(), 1, 'при старте создаётся только активная страница')
  assert.equal(requests.get('/video') ?? 0, 0, 'восстановленный плеер не запускался')
  assert.equal(requests.get('/untouched') ?? 0, 0)
  const landing = await currentId()
  await click(landing, '#middle', { button: 'middle' })
  await waitFor(async () => await page.locator('.tab-main').count() === 4, 'фоновая вкладка от средней кнопки')
  assert.equal(await currentId(), landing)
  assert.equal(await page.locator('webview').count(), 1)
  assert.equal(requests.get('/middle') ?? 0, 0, 'средняя кнопка не загружает страницу')
  // У новой фоновой страницы ещё нет заголовка сайта — выбираем строку с доменом.
  await page.locator('.tab-main').filter({ hasText: new URL(base).host }).click()
  await waitFor(() => requests.get('/middle') === 1, 'первая загрузка фоновой вкладки')
  const middle = await currentId()
  await activate('landing')
  await activate('middle')
  assert.equal(await currentId(), middle, 'быстрое возвращение сохраняет страницу')
  assert.equal(requests.get('/middle'), 1)
  console.log('OK: восстановление и средняя кнопка загружают страницу только при выборе')

  const history = await open('/first')
  await click(history, '#next')
  await waitFor(async () => await inGuest(history, 'location.pathname') === '/second', 'переход с историей')
  await inGuest(history, 'scrollTo(0, 650)')
  await waitFor(async () => await inGuest(history, 'scrollY') === 650, 'прокрутка перед выгрузкой')
  const dirty = await open('/dirty')
  await click(dirty, '#editor')
  await inGuest(dirty, `(() => { const editor = document.querySelector('#editor'); editor.focus(); const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range) })()`)
  await app.evaluate(async ({ webContents }, id) => {
    const debug = webContents.fromId(id).debugger
    debug.attach('1.3')
    try {
      await debug.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
      await debug.sendCommand('Input.dispatchKeyEvent', { type: 'char', text: 'X' })
    } finally { debug.detach() }
  }, dirty)
  assert.ok(await inGuest(dirty, 'document.querySelector("#editor").textContent.includes("X")'), 'доверенный ввод попал в редактор')
  const framed = await open('/iframe')
  await app.evaluate(async ({ webContents }, id) => {
    const frame = webContents.fromId(id).mainFrame.frames.find((f) => f.url.endsWith('/embedded'))
    await frame.executeJavaScript('document.querySelector("input").value="черновик во фрейме"')
  }, framed)
  const rtc = await open('/call')
  await inGuest(rtc, 'window.peer=new RTCPeerConnection();true')
  const music = await open('/music')
  await waitFor(async () => await inGuest(music, '!player.paused'), 'плеер')
  const active = await open('/active')
  await command({ type: 'open-url', url: base + '/split', background: true })
  await page.locator('.tab-main').filter({ hasText: new URL(base).host }).click({ button: 'right' })
  assert.equal(requests.get('/split') ?? 0, 0, 'правая кнопка не будит фоновую вкладку')
  await page.getByText('Открыть рядом с текущей', { exact: true }).click()
  await waitFor(async () => await page.locator('webview.wv.pane').count() === 2 && requests.get('/split') === 1, 'выбор спящей вкладки во вторую половину')
  const split = await page.evaluate(() => document.querySelector('webview.wv.pane:not(.focused)').getWebContentsId())
  if (!process.argv.includes('--quick')) await page.waitForTimeout(31_000)
  assert.ok(await exists(history), 'Никогда: обычная вкладка остаётся в памяти')
  await settings({ sleepAfter: 0.001 })
  await waitFor(async () => !await exists(history), 'выгрузка webContents', 35_000)
  assert.ok(await exists(dirty), 'сохранился редактор с несохранённым вводом')
  assert.ok(await exists(framed), 'сохранилась форма в iframe')
  assert.ok(await exists(rtc), 'сохранился звонок WebRTC')
  assert.ok(await exists(music), 'сохранилась музыка')
  assert.ok(await exists(active) && await exists(split), 'обе видимые половины остаются в памяти')
  assert.equal(requests.get('/untouched') ?? 0, 0, 'непросмотренные вкладки всё ещё не загружены')
  const resumed = await activate('second')
  assert.notEqual(resumed, history, 'после выгрузки создаётся новая страница')
  await waitFor(async () => await inGuest(resumed, 'location.pathname') === '/second', 'возврат адреса')
  await waitFor(async () => await inGuest(resumed, 'scrollY') === 650, 'возврат прокрутки')
  const nav = await app.evaluate(({ webContents }, id) => {
    const h = webContents.fromId(id).navigationHistory
    return { back: h.canGoBack(), entries: h.getAllEntries().map((e) => e.url) }
  }, resumed)
  assert.ok(nav.back)
  assert.ok(nav.entries.includes(base + '/first'))
  assert.equal(await inGuest(resumed, 'Number(localStorage.getItem("boots:/second"))'), 2, 'пробуждение создаёт ровно один новый документ')
  assert.ok(requests.get('/second') <= 2, 'нет повторного сетевого запроса (страница может прийти из кэша)')
  await app.evaluate(({ webContents }, id) => webContents.fromId(id).navigationHistory.goBack(), resumed)
  await waitFor(async () => await inGuest(resumed, 'location.pathname') === '/first', 'Назад после пробуждения')
  console.log('OK: webContents уничтожен, история и прокрутка восстановлены, редактор/iframe/WebRTC/музыка защищены')

  await command({ type: 'open-url', url: 'masaki://settings' })
  await page.getByRole('radiogroup', { name: 'Выгружать неактивные вкладки из памяти', exact: true }).getByRole('radio', { name: '15 мин', exact: true }).click()
  await shot('settings')
  assert.equal((await page.evaluate(() => window.masaki.settings.get())).sleepAfter, 15)

  // Подставной YouCloud использует те же CSS-переменные и data-host, что настоящий сайт.
  await app.evaluate(({ session }) => session.fromPartition('persist:frost').protocol.handle('https', () => new Response(`<!doctype html><meta charset="utf-8"><title>YouCloud</title>
    <style>:root{--surface:#132125;background:#132125;color:#effff5;font:24px sans-serif}:root[data-host=masaki],:root[data-host=masaki] body{background:transparent}body{margin:40px}</style>
    <h1>YouCloud</h1><p>Проверка прозрачности</p>`, { headers: { 'content-type': 'text/html' } })))
  await command({ type: 'open-url', url: 'https://youcloud.inkerror67.workers.dev/' })
  await waitFor(async () => await inGuest(await currentId(), 'document.title').catch(() => '') === 'YouCloud', 'YouCloud')
  const yc = await currentId()
  assert.equal(await inGuest(yc, 'getComputedStyle(document.documentElement).backgroundColor'), 'rgba(0, 0, 0, 0)')
  await command({ type: 'open-url', url: 'masaki://addons' })
  await page.getByRole('radiogroup', { name: 'Фон YouCloud', exact: true }).getByRole('radio', { name: 'Оригинальный', exact: true }).click()
  await activate('YouCloud')
  await waitFor(async () => await inGuest(yc, 'getComputedStyle(document.documentElement).backgroundColor') === 'rgb(19, 33, 37)', 'непрозрачный YouCloud')
  assert.equal(await page.locator('webview.wv.on.clear').count(), 0)
  await shot('youcloud-opaque')
  await app.evaluate(({ webContents }, id) => webContents.fromId(id).reload(), yc)
  await waitFor(async () => await inGuest(yc, 'document.readyState').catch(() => '') === 'complete', 'перезагрузка YouCloud')
  assert.equal(await inGuest(yc, 'getComputedStyle(document.documentElement).backgroundColor'), 'rgb(19, 33, 37)', 'настройка сохраняется при перезагрузке')
  await click(yc, 'h1', { button: 'right' })
  await page.getByText('Прозрачный фон YouCloud', { exact: true }).click()
  await waitFor(async () => await inGuest(yc, 'getComputedStyle(document.documentElement).backgroundColor') === 'rgba(0, 0, 0, 0)', 'возврат прозрачности через меню')
  console.log('OK: настройка выгрузки и переключатель YouCloud, перезагрузка и контекстное меню')
  assert.deepEqual(errors, [], 'ошибки интерфейса')
  console.log('Tab memory: все проверки прошли')
} catch (error) {
  console.error(error)
  throw error
} finally {
  await app?.close().catch(() => {})
  clearTimeout(watchdog)
  await new Promise((resolve) => site.close(resolve))
  fs.rmSync(profile, { recursive: true, force: true })
}
