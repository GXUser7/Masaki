// Узкая регрессия исправлений: автозаполнение, вход Google, прикладные URI и перенос в поиск.
// Все сайты и аккаунты вымышлены; ОС не запускает приложения, профиль пользователя не используется.
// node scripts/browser-compat-test.mjs [autofill|google|external|drop|dock|sidebar]
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { clickGuest, guestKeys } from './electron-input.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'test-output')
fs.mkdirSync(output, { recursive: true })
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-compat-'))
const only = process.argv.slice(2)
const selected = (name) => !only.length || only.includes(name)
const uri = 'tg://resolve?domain=masaki_test'
const site = http.createServer((req, res) => {
  if (req.url === '/redirect') { res.writeHead(302, { Location: uri }); return res.end() }
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(`<!doctype html><meta charset="utf-8"><title>Тест входа</title>
    <style>body{font:18px sans-serif;padding:40px;background:#fff;color:#111}input,button,a{display:block;margin:8px 0;padding:8px;width:280px;font:inherit}</style>
    <form action="/done"><input id="user" autocomplete="username" name="username"><input id="pass" autocomplete="current-password" type="password"><button id="go">Войти</button></form>
    <a id="external" href="${uri}">Открыть Telegram</a><a id="blank" target="_blank" href="${uri}">В новом окне</a>
    <a id="redirect" href="/redirect">Редирект в Telegram</a><button id="popup" onclick="window.open('${uri}', 'tg', 'width=500,height=500')">Через window.open</button>`)
})
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
const base = `http://localhost:${site.address().port}`
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ sidebarCollapsed: false, aiDefault: false, addons: { adblock: { enabled: false } } }))
let app
let page
let mainWindowId
const errors = []
const command = (c) => app.evaluate(({ BrowserWindow }, [id, c]) => BrowserWindow.fromId(id).webContents.send('command', c), [mainWindowId, c])
const guestId = () => page.evaluate(() => document.querySelector('webview.wv.on')?.getWebContentsId())
const inTab = async (code) => app.evaluate(({ webContents }, [id, code]) => webContents.fromId(id).executeJavaScript(code), [await guestId(), code])
async function waitFor(fn, label, ms = 10000) {
  const until = Date.now() + ms
  while (Date.now() < until) { if (await fn()) return; await new Promise((r) => setTimeout(r, 60)) }
  throw new Error('Не дождались: ' + label)
}
async function open(url) {
  await command({ type: 'open-url', url })
  await waitFor(async () => (await inTab('location.href').catch(() => '')) === url && await inTab('document.readyState') === 'complete', url)
}
async function click(selector) {
  const point = await inTab(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`)
  await clickGuest(app, await guestId(), ...point)
}
async function shot(name, settle = true) {
  if (settle) await page.waitForTimeout(650)
  const data = await app.evaluate(async ({ BrowserWindow }, id) => (await BrowserWindow.fromId(id).capturePage()).toPNG().toString('base64'), mainWindowId)
  fs.writeFileSync(path.join(output, `compat-${name}.png`), Buffer.from(data, 'base64'))
}
async function drop(selector, payload, preview) {
  const gesture = await page.evaluateHandle(([selector, payload]) => {
    const dt = new DataTransfer()
    for (const [type, value] of Object.entries(payload.text ?? {})) dt.setData(type, value)
    if (payload.file) dt.items.add(new File([Uint8Array.from(atob(payload.file), (c) => c.charCodeAt(0))], 'test.png', { type: 'image/png' }))
    const el = document.querySelector(selector)
    const enter = new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true })
    const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })
    el.dispatchEvent(enter); el.dispatchEvent(over)
    const accepted = enter.defaultPrevented && over.defaultPrevented
    return { el, dt, accepted }
  }, [selector, payload])
  try {
    const accepted = await gesture.evaluate((g) => g.accepted)
    if (preview) {
      await page.waitForSelector(`${selector} .search-drop-hint.on`)
      await page.waitForTimeout(450)
      const target = await page.locator(`${selector} .search-drop-hint`).evaluate((el) => {
        const icon = el.querySelector('svg[data-ic]').getBoundingClientRect()
        const card = el.getBoundingClientRect()
        return { icon: [icon.width, icon.height], card: [card.width, card.height],
          pointer: getComputedStyle(el).pointerEvents,
          moving: el.getAnimations({ subtree: true }).some((a) => a.playState === 'running'),
          reduced: matchMedia('(prefers-reduced-motion: reduce)').matches }
      })
      assert.ok(target.icon.every((s) => s >= 24 && s <= 30), 'лупа ограничена размером значка')
      assert.ok(target.card[1] < 240 && target.card[0] <= 344, 'подсказка не закрывает всю панель')
      assert.equal(target.pointer, 'none', 'подсказка не перехватывает перенос')
      assert.equal(target.moving, !target.reduced, 'форма M3 учитывает уменьшение движения')
      await shot(preview, false)
    }
    await gesture.evaluate(({ el, dt }) => el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })))
    if (preview) {
      await page.waitForSelector(`${selector} .search-drop-hint.on`, { state: 'detached' })
      await page.waitForTimeout(450)
      assert.equal(await page.locator(`${selector} .search-drop-hint`).isVisible(), false, 'карточка плавно уходит после отпускания')
    }
    return accepted
  } finally { await gesture.dispose() }
}

try {
  const env = { ...process.env, MASAKI_PROFILE: profile, MASAKI_TEST_HEADLESS: '1', MASAKI_TEST_INACTIVE: '1', MASAKI_TEST_PLAIN_STORAGE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const executablePath = process.env.MASAKI_COMPAT_EXE
  app = await electron.launch({ executablePath, args: executablePath ? [] : [root], cwd: root, env, colorScheme: null, timeout: 60000 })
  page = await app.firstWindow()
  mainWindowId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id)
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('.stage')
  const png = await app.evaluate(({ nativeImage, session, shell, app }) => {
    const png = nativeImage.createFromBitmap(Buffer.from([128, 210, 60, 255]), { width: 1, height: 1 }).toPNG().toString('base64')
    globalThis.__compatOpens = []
    shell.openExternal = async (url) => { globalThis.__compatOpens.push(url) }
    app.getApplicationNameForProtocol = () => 'Telegram'
    globalThis.__compatRequests = []
    globalThis.__compatNavigations = []
    app.on('web-contents-created', (_event, contents) => {
      if (contents.getType() === 'webview') contents.on('did-navigate', (_event, url) => globalThis.__compatNavigations.push({ url, id: contents.id }))
    })
    globalThis.__compatGoogleState = 'signedout'
    const handle = async (request) => {
      const url = new URL(request.url)
      globalThis.__compatRequests.push(request.url)
      if (url.pathname.includes('ListAccounts')) return new Response(JSON.stringify(['gaia.l.a', globalThis.__compatGoogleState === 'signedin' ? [[null, null, 'Тестовый аккаунт', 'alice@example.test', '', null, null, 0]] : []]))
      if (url.pathname === '/test.png') return new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } })
      if (url.pathname === '/oversize.png') return new Response('x', { headers: { 'content-length': '30000000' } })
      const first = `<script>window.firstNavigator = { ua: navigator.userAgent, uad: !!navigator.userAgentData, vendor: navigator.vendor, referrer: document.referrer }; if (opener) { opener.postMessage(firstNavigator, '*'); setTimeout(() => close(), 100) }</script>`
      if (url.origin === 'https://www.google.com' && url.pathname === '/') {
        const state = globalThis.__compatGoogleState
        return new Response(`<!doctype html><meta charset="utf-8"><title>Подставной Google</title>${first}
          <body style="font:18px sans-serif;padding:40px"><h1>Google</h1>
          ${state === 'fallback' ? '<p>На этой странице нет ссылки входа</p>' : `<script>
            window.switcherOpens = 0;
            setTimeout(() => {
              const hidden = document.createElement('a');
              hidden.href = 'https://accounts.google.com/ServiceLogin?fixture_token=hidden'; hidden.style.display = 'none'; document.body.append(hidden);
              const entry = document.createElement('a'); entry.id = 'google-entry';
              entry.href = 'https://accounts.google.com/${state === 'signedin' ? 'SignOutOptions?fixture_token=google-avatar' : 'ServiceLogin?continue=https%3A%2F%2Fwww.google.com%2F&fixture_token=site-created'}';
              entry.textContent = '${state === 'signedin' ? 'Аккаунт Google' : 'Войти'}';
              ${state === 'signedin' ? `entry.onclick = (event) => { event.preventDefault(); window.switcherOpens++; document.getElementById('google-switcher').hidden = false };` : ''}
              document.body.append(entry);
            }, 400);
          </script>`}
          <div id="google-switcher" hidden style="padding:24px;margin-top:24px;border:1px solid">
            <b>Аккаунты Google</b><p>alice@example.test</p>
            <a id="google-add" href="https://accounts.google.com/AddSession?continue=https%3A%2F%2Fwww.google.com%2F&fixture_token=google-switcher">Добавить аккаунт</a>
          </div>`, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      return new Response(`<!doctype html><meta charset="utf-8"><title>Тест Google</title>${first}<button id="g" onclick="window.open('https://accounts.google.com/o/oauth2/v2/auth?test=compat','login','width=500,height=600')">Google</button><script>addEventListener('message', e => window.popupResult = e.data)</script>`, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    session.fromPartition('persist:frost').protocol.handle('https', handle)
    session.defaultSession.protocol.handle('https', handle)
    return png
  })

  if (selected('autofill')) {
    for (const [username, password] of [['alice@example.test', 'Test-Only-Alice!'], ['bob@example.test', 'Test-Only-Bob!']]) {
      assert.equal((await page.evaluate((p) => window.masaki.passwords.save(p), { url: base, username, password })).ok, true)
    }
    await open(base + '/login')
    await click('#user')
    await page.waitForSelector('.af-menu')
    await page.locator('.af-row[role=option]', { hasText: 'alice@example.test' }).click()
    await waitFor(async () => await inTab('document.querySelector("#pass").value') === 'Test-Only-Alice!', 'заполнение пароля')
    // Сайт/Chromium возвращает фокус в пароль уже ПОСЛЕ асинхронного заполнения.
    await inTab('document.querySelector("#pass").blur(); document.querySelector("#pass").focus()')
    await page.waitForTimeout(350)
    assert.equal(await page.locator('.af-menu').count(), 0, 'повторный фокус после заполнения не должен забирать клик по «Войти»')
    await shot('autofill-filled')
    await click('#go')
    await waitFor(async () => (await inTab('location.pathname')) === '/done', 'вход первым кликом')
    await open(base + '/login')
    await click('#user'); await page.waitForSelector('.af-menu')
    await guestKeys(app, await guestId(), ['ArrowDown', 'Enter'])
    await waitFor(async () => !!await inTab('document.querySelector("#pass").value'), 'выбор клавиатурой')
    await click('#pass')
    await page.waitForSelector('.af-menu')
    await page.locator('.af-row[role=option]', { hasText: 'bob@example.test' }).click()
    await waitFor(async () => await inTab('document.querySelector("#user").value') === 'bob@example.test', 'явный повторный выбор')
    console.log('ok — автозаполнение: подстановка, повторный focus, первый клик «Войти», клавиатура, смена аккаунта')
  }
  if (selected('google')) {
    const started = await app.evaluate(() => globalThis.__compatNavigations.length)
    await page.locator('.side .achip').click()
    await page.locator('.pop button', { hasText: 'Войти в аккаунт Google' }).click()
    await waitFor(async () => (await inTab('location.hostname').catch(() => '')) === 'accounts.google.com', 'вход из боковой панели')
    assert.equal(await inTab('new URL(location.href).searchParams.get("fixture_token")'), 'site-created', 'вход использует живую ссылку, созданную сайтом после загрузки')
    assert.equal(await inTab('document.referrer'), 'https://www.google.com/', 'переход сохраняет контекст Google')
    const route = await app.evaluate((_electron, start) => globalThis.__compatNavigations.slice(start).filter((r) => {
      const url = new URL(r.url)
      return url.origin === 'https://www.google.com' && url.pathname === '/' ||
        url.origin === 'https://accounts.google.com' && /^\/(?:ServiceLogin|AddSession|SignOutOptions)$/.test(url.pathname)
    }), started)
    assert.equal(route[0].url, 'https://www.google.com/', 'меню сначала открывает сайт Google')
    assert.equal(route.length, 2, 'до формы входа только главная страница и её живая ссылка')
    assert.equal(new URL(route[1].url).searchParams.get('fixture_token'), 'site-created')
    // protocol.handle не сохраняет HTTP Referer; контекст перехода проверен выше через document.referrer.
    const first = await inTab('firstNavigator')
    assert.match(first.ua, /Firefox\/140/)
    assert.equal(first.uad, false)
    assert.equal(first.vendor, '')
    await shot('google-sidebar')

    await app.evaluate(() => { globalThis.__compatGoogleState = 'signedin' })
    await page.locator('.side .achip').click()
    await page.locator('.pop button', { hasText: 'Добавить аккаунт' }).click()
    await waitFor(async () => await inTab('location.href').catch(() => '') === 'https://www.google.com/' && await inTab('window.switcherOpens').catch(() => 0) === 1, 'родной список аккаунтов Google')
    assert.equal(await inTab('document.getElementById("google-switcher").hidden'), false)
    await shot('google-switcher')
    assert.equal(await inTab('location.hostname'), 'www.google.com', 'кнопка не обходит обработчик аватара Google прямым AddSession')
    await click('#google-add')
    await waitFor(async () => (await inTab('location.hostname').catch(() => '')) === 'accounts.google.com', 'добавление аккаунта из списка Google')
    assert.equal(await inTab('new URL(location.href).searchParams.get("fixture_token")'), 'google-switcher')
    assert.equal(await inTab('document.referrer'), 'https://www.google.com/')
    assert.match((await inTab('firstNavigator')).ua, /Firefox/)

    await app.evaluate(() => { globalThis.__compatGoogleState = 'fallback' })
    await page.locator('.side .achip').click()
    await page.locator('.pop button', { hasText: 'Войти в аккаунт Google' }).click()
    await waitFor(async () => await inTab('location.href').catch(() => '') === 'https://www.google.com/' && await inTab('document.readyState') === 'complete', 'Google без ссылки входа')
    const fallbackId = await guestId()
    const fallbackStarted = await app.evaluate(() => globalThis.__compatNavigations.length)
    await page.waitForTimeout(5500)
    assert.equal(await inTab('location.href'), 'https://www.google.com/', 'при другой разметке остаётся сам сайт Google')
    const unexpected = await app.evaluate((_electron, [start, id]) => globalThis.__compatNavigations.slice(start).filter((r) => {
      const url = new URL(r.url)
      return r.id === id && url.origin === 'https://accounts.google.com' && /^\/(?:ServiceLogin|AddSession|SignOutOptions)$/.test(url.pathname)
    }), [fallbackStarted, fallbackId])
    assert.deepEqual(unexpected, [], 'при отсутствии ссылки адрес формы входа не сочиняется')
    assert.deepEqual(await app.evaluate(() => globalThis.__compatOpens), [], 'вход не требует внешнего браузера')

    await inTab("location.href = 'https://site.test/returned'")
    await waitFor(async () => (await inTab('location.href')) === 'https://site.test/returned' && await inTab('document.readyState') === 'complete', 'уход с Google в той же вкладке')
    assert.match((await inTab('firstNavigator')).ua, /Chrome/)
    assert.equal((await inTab('firstNavigator')).uad, true)
    await open('https://site.test/')
    assert.match((await inTab('firstNavigator')).ua, /Chrome/)
    assert.equal((await inTab('firstNavigator')).uad, true)
    await click('#g')
    await waitFor(async () => !!await inTab('window.popupResult'), 'ответ window.opener')
    assert.match((await inTab('popupResult')).ua, /Firefox/)
    assert.equal((await inTab('popupResult')).uad, false)
    assert.equal(await app.evaluate(() => globalThis.__compatRequests.filter((u) => u.includes('test=compat')).length), 1, 'форма входа не должна перезагружаться')
    console.log('ok — Google: меню → сайт → живая ссылка с контекстом; родной список аккаунтов; безопасный fallback; popup/window.opener; обычные сайты видят Chrome')
  }
  if (selected('external')) {
    await open(base + '/links')
    const count = await page.locator('.side .tab').count()
    await page.evaluate(() => window.masaki.permissions.onPrompt((p) => { window.__compatPermission = p }))
    await click('#external')
    await page.waitForSelector('.perm:has-text("Telegram")')
    await shot('external')
    const promptId = await page.evaluate(() => window.__compatPermission.id)
    const foreignImage = await app.evaluate(async ({ BrowserWindow }, promptId) => {
      const foreign = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } })
      try {
        await foreign.loadURL('about:blank')
        return await foreign.webContents.executeJavaScript(`(() => {
          const ipc = require('electron').ipcRenderer
          ipc.send('permission:answer', ${JSON.stringify(promptId)}, true, false)
          return ipc.invoke('search:image', 'https://images.test/test.png')
        })()`)
      } finally { foreign.destroy() }
    }, promptId)
    assert.equal(foreignImage, null, 'чужой renderer не загружает картинку через UI API')
    assert.deepEqual(await app.evaluate(() => globalThis.__compatOpens), [], 'чужой renderer не подтверждает запуск приложения')
    await page.locator('.perm button', { hasText: 'Отмена' }).click()
    assert.deepEqual(await app.evaluate(() => globalThis.__compatOpens), [])
    for (const selector of ['#external', '#blank', '#popup', '#redirect']) {
      await click(selector)
      await page.waitForSelector('.perm:has-text("Telegram")')
      await page.locator('.perm button', { hasText: 'Открыть приложение' }).click()
      await page.waitForSelector('.perm', { state: 'detached' })
    }
    await waitFor(async () => (await app.evaluate(() => globalThis.__compatOpens)).length === 4, 'четыре передачи в ОС')
    assert.deepEqual(await app.evaluate(() => globalThis.__compatOpens), Array(4).fill(uri))
    assert.equal(await page.locator('.side .tab').count(), count, 'URI приложения не создаёт пустую вкладку')
    assert.equal(await inTab('location.pathname'), '/links')
    await click('#external')
    await page.waitForSelector('.perm')
    await inTab(`location.href = ${JSON.stringify(base + '/left')}`)
    await page.waitForSelector('.perm', { state: 'detached' })
    assert.equal((await app.evaluate(() => globalThis.__compatOpens)).length, 4)
    console.log('ok — прикладные URI: ссылка, _blank, window.open, HTTP-редирект; отмена и уход со страницы')
  }
  if (selected('drop')) {
    await open(base + '/drop')
    const count = await page.locator('.side .tab').count()
    assert.equal(await drop('.side', { text: { 'text/plain': 'выделенный текст для поиска' } }, 'drop-hover-sidebar'), true)
    await page.waitForSelector('.cmd-in input')
    assert.equal(await page.locator('.cmd-in input:not([type=file])').inputValue(), 'выделенный текст для поиска')
    await shot('drop-text')
    await page.press('.cmd-in input', 'Enter')
    await waitFor(async () => await page.locator('.side .tab').count() === count + 1, 'поиск в новой вкладке')
    await command({ type: 'toggle-sidebar' })
    await page.waitForSelector('.app.collapsed')
    await page.waitForTimeout(650)
    assert.equal(await drop('.capz', { file: png }, 'drop-hover-dock'), true)
    await page.waitForSelector('.pal-pic img')
    assert.equal(await page.locator('.cmd-in .chip.on').count(), 1)
    await shot('drop-image-dock')
    await page.press('.cmd-in input', 'Escape')
    assert.equal(await drop('.capz', { text: { 'text/html': '<img src="https://images.test/test.png">', 'text/uri-list': 'https://images.test/test.png' } }), true)
    await page.waitForSelector('.pal-pic img')
    assert.match(await page.locator('.pal-pic img').getAttribute('src'), /^data:image\//)
    await page.press('.cmd-in input', 'Escape')
    assert.equal(await drop('.capz', { text: { 'application/x-masaki-reorder': 'tile', 'text/plain': 'https://site.test/' } }), false)
    assert.equal(await page.locator('.cmd').count(), 0, 'перестановка плиток не открывает поиск')
    assert.equal(await page.evaluate(() => window.masaki.searchImage('file:///C:/Windows/win.ini')), null)
    assert.equal(await page.evaluate(() => window.masaki.searchImage('https://images.test/oversize.png')), null)
    const webp = await page.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 16
      canvas.getContext('2d').fillRect(0, 0, 16, 16)
      return window.masaki.searchImage(canvas.toDataURL('image/webp'))
    })
    assert.ok(webp, 'WebP из веб-страницы тоже принимается')
    await drop('.capz', { text: { 'text/uri-list': webp } })
    await page.waitForSelector('.pal-pic img')
    assert.match(await page.locator('.pal-pic img').getAttribute('src'), /^data:image\/png;/, 'WebP преобразуется в PNG до Lens')
    await page.press('.cmd-in input', 'Escape')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await drop('.capz', { text: { 'text/plain': 'поиск без анимации' } }, 'drop-reduced-motion')
    await page.waitForSelector('.cmd-in input')
    await page.press('.cmd-in input', 'Escape')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    console.log('ok — перенос: текст, новая вкладка, файл в док, картинка со страницы, отдельный жест перестановки, лимиты')
  }
  if (selected('dock')) {
    const settings = await page.evaluate(() => window.masaki.settings.get())
    const wallpaper = await app.evaluate(({ nativeImage }) => nativeImage.createFromBitmap(Buffer.from([0, 180, 225, 255]), { width: 1, height: 1 }).toPNG().toString('base64'))
    const wallpaperPath = path.join(profile, 'custom-wallpaper.png')
    fs.writeFileSync(wallpaperPath, Buffer.from(wallpaper, 'base64'))
    const updated = { ...settings, scheme: 'dark', palette: 'lime', background: 'custom', sidebarCollapsed: true }
    await page.evaluate((s) => window.masaki.settings.set(s), updated)
    await app.evaluate(({ BrowserWindow }, [id, settings]) => BrowserWindow.fromId(id).webContents.send('settings-changed', settings), [mainWindowId, updated])
    await open(base + '/dock')
    await page.waitForSelector('.app.collapsed')
    await page.waitForSelector('.app.wallbg')
    await inTab('document.body.style.minHeight = "3000px"')
    await page.evaluate(() => {
      const pattern = document.createElement('div')
      pattern.style.cssText = 'position:absolute;inset:0;background:repeating-linear-gradient(90deg,#202000 0 12px,#ffff00 12px 24px)'
      document.querySelector('.wall').append(pattern)
    })
    await page.waitForTimeout(900)
    await shot('dock-glass-before')
    const glassContrast = async () => {
      const r = await page.locator('.capsule').boundingBox()
      return app.evaluate(async ({ BrowserWindow }, [id, r]) => {
        const shot = await BrowserWindow.fromId(id).capturePage()
        const bitmap = shot.toBitmap()
        const width = shot.getSize().width
        const values = []
        for (let x = Math.ceil(r.x + r.width - 140); x < r.x + r.width - 60; x++) {
          values.push(bitmap[(Math.round(r.y + 8) * width + x) * 4 + 2])
        }
        return Math.max(...values) - Math.min(...values)
      }, [mainWindowId, r])
    }
    const before = await glassContrast()
    assert.ok(before < 25, `стекло не размывает полосатый фон: перепад ${before}`)
    if (process.env.MASAKI_DOCK_LEGACY_COMPARE) {
      await page.evaluate(() => { document.querySelector('.capz').style.willChange = 'transform, opacity' })
      await page.waitForTimeout(250)
      console.log('перепад с прежним слоем:', await glassContrast())
      await shot('dock-glass-legacy')
      await page.evaluate(() => document.querySelector('.capz').style.removeProperty('will-change'))
    }
    for (let i = 0; i < 6; i++) {
      await inTab(`scrollTo(0, ${i % 2 === 0 ? 500 : 0})`)
      await page.waitForSelector(i % 2 === 0 ? '.capz.small' : '.capz:not(.small)')
      await page.waitForTimeout(650)
    }
    await command({ type: 'toggle-sidebar' })
    await page.waitForSelector('.app:not(.collapsed)')
    await page.waitForTimeout(650)
    await command({ type: 'toggle-sidebar' })
    await page.waitForSelector('.app.collapsed')
    await page.waitForTimeout(700)
    await shot('dock-glass-after')
    const after = await glassContrast()
    assert.ok(after < 25, `после перетекания через стекло проступили полосы: перепад ${after}`)
    console.log(`ok — док: полосатый фон размыт до и после перетекания, перепад ${before}/${after}`)
  }
  if (selected('sidebar')) {
    // Контрастный фон остаётся только во временном профиле.
    const wallpaper = await app.evaluate(({ nativeImage }) => {
      const pixels = Buffer.alloc(64 * 64 * 4)
      for (let i = 0; i < 64 * 64; i++) {
        const offset = i * 4
        const top = i < 64 * 32
        pixels[offset] = top ? 20 : 180
        pixels[offset + 1] = top ? 160 : 50
        pixels[offset + 2] = top ? 200 : 60
        pixels[offset + 3] = 255
      }
      return nativeImage.createFromBitmap(pixels, { width: 64, height: 64 }).toPNG().toString('base64')
    })
    fs.writeFileSync(path.join(profile, 'custom-wallpaper.png'), Buffer.from(wallpaper, 'base64'))
    const stats = []
    for (const scheme of ['dark', 'light']) for (const background of ['shapes', 'custom']) {
      const updated = await page.evaluate(async ({ scheme, background }) => {
        const settings = await window.masaki.settings.get()
        const updated = { ...settings, scheme, background, sidebarCollapsed: false }
        window.masaki.settings.set(updated)
        return updated
      }, { scheme, background })
      // Такой же путь обновления renderer использует при приходе настроек из синхронизации.
      await app.evaluate(({ BrowserWindow }, [id, settings]) => BrowserWindow.fromId(id).webContents.send('settings-changed', settings), [mainWindowId, updated])
      await page.waitForSelector('.app:not(.collapsed)')
      await page.waitForSelector('.app.' + scheme + (background === 'custom' ? '.wallbg' : ':not(.wallbg)'))
      await page.waitForTimeout(800)
      const baseline = await page.locator('.side').evaluate((el) => ({ background: getComputedStyle(el).backgroundColor, backdrop: getComputedStyle(el).backdropFilter }))
      await command({ type: 'toggle-sidebar' })
      await page.waitForSelector('.app.collapsed')
      await page.waitForTimeout(650)
      const samples = page.evaluate(async () => {
        document.querySelector('.capsule .cap-side').click()
        const frames = []
        const until = performance.now() + 650
        while (performance.now() < until) {
          await new Promise(requestAnimationFrame)
          const el = document.querySelector('.side')
          const style = getComputedStyle(el)
          frames.push({ background: style.backgroundColor, backdrop: style.backdropFilter, opacity: Number(style.opacity), animation: document.querySelector('.app').classList.contains('animating') })
        }
        return frames
      })
      if (scheme === 'dark' && background === 'custom') {
        await page.waitForTimeout(200)
        await shot('sidebar-opening', false)
      }
      const frames = await samples
      assert.ok(frames.some((s) => s.animation && s.opacity > 0), 'проверены видимые кадры раскрытия')
      assert.ok(frames.every((s) => s.background === baseline.background && s.backdrop === baseline.backdrop), `фон/размытие меняются во время раскрытия: ${scheme}/${background}`)
      stats.push({ scheme, background, frames: frames.length, surface: baseline })
    }
    console.log('ok — панель прозрачна с первого кадра: тёмная/светлая тема, фигуры/обои; ' + JSON.stringify(stats))
  }
  assert.deepEqual(errors, [], 'ошибки renderer')
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible() || w.isFocused())), false)
} catch (e) {
  process.exitCode = 1
  console.error(e)
  if (app) await shot('failure').catch(() => {})
} finally {
  if (app) await app.close().catch(() => {})
  site.closeAllConnections()
  await new Promise((resolve) => site.close(resolve))
  // Удаляем только папку, которую этот тест создал через mkdtemp выше.
  assert.equal(path.dirname(profile), os.tmpdir())
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}
