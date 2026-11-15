// Конечные сценарии аудита: заполнение iframe и форм, сохранность редактора, папки, приложения.
// node scripts/review-ui-test.mjs forms|folders|apps (после сборки). Только временный профиль/localhost.
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { clickGuest } from './electron-input.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv[2]; assert.ok(['forms', 'folders', 'apps'].includes(mode))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-review-ui-'))
const out = path.join(root, 'test-output'); fs.mkdirSync(out, { recursive: true })
const login = '<form><input id="user" autocomplete="username"><input id="pass" type="password"></form>'
const keyScript = `<script>window.createKey=()=>{window.pkOut='pending';navigator.credentials.create({publicKey:{challenge:new Uint8Array([1,2,3]),rp:{name:'Test'},user:{id:new Uint8Array([1]),name:'tester',displayName:'Test'},pubKeyCredParams:[{type:'public-key',alg:-7}],extensions:{prf:{}}}}).then(c=>window.pkOut=c.toJSON(),e=>window.pkOut=e.name)}</script>`
let base, cross
const site = http.createServer((req, res) => {
  if (req.url === '/auth' && req.headers.authorization !== 'Basic ' + Buffer.from('tester:secret').toString('base64')) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="Review"' }); return res.end('auth')
  }
  res.setHeader('content-type', 'text/html; charset=utf-8')
  let body = login + keyScript
  if (req.url === '/email') body = login.replace('autocomplete="username"', 'autocomplete="email"')
  if (req.url === '/cross') body = '<input id="parent" value="Parent"><iframe src="' + cross + '/frame"></iframe>'
  if (req.url === '/checkout') body = '<form><input id="given" autocomplete="section-a shipping given-name"><input id="family" autocomplete="section-a shipping family-name"><textarea id="street" autocomplete="section-a shipping street-address"></textarea><select id="country" autocomplete="section-a shipping country"><option value="">Выбрать</option><option value="RU">Россия</option></select><input id="billing" autocomplete="section-b billing given-name"></form>'
  res.end('<!doctype html><meta charset="utf-8"><title>Тест</title><style>body{background:#173029;color:#eee;font:18px sans-serif;margin:30px}input,select,textarea{display:block;margin:12px;padding:6px}iframe{margin:120px;width:500px;height:220px}</style>' + body)
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
base = `http://localhost:${site.address().port}`; cross = `http://127.0.0.1:${site.address().port}`
const favorites = [
  ...Array.from({ length: 4 }, (_, i) => ({ title: 'Folder ' + i, url: base.replace('localhost', `site${i}.localhost`) + '/folder-' + i, folder: 'Чтение' })),
  { title: 'Root', url: base + '/root' }, { title: 'Other', url: base + '/other' }
]
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ sidebarCollapsed: false, sleepAfter: 0, favorites, addons: { adblock: { enabled: false } } }))
const icons = Object.fromEntries(['localhost', ...Array.from({ length: 4 }, (_, i) => `site${i}.localhost`)].map((host, i) => [host, 'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="6" fill="${['#00695e','#386a20','#0061a4','#9c1c2c','#65558f'][i]}"/><text x="16" y="23" text-anchor="middle" font-family="Arial" font-size="24" fill="white">${i}</text></svg>`).toString('base64')]))
fs.writeFileSync(path.join(profile, 'favicons.json'), JSON.stringify(icons))
let app, page, mainId
const errors = []
const watchdog = setTimeout(() => { app?.process().kill(); process.exit(1) }, 100000)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, label) => { const end = Date.now() + 12000; while (Date.now() < end) { const r = await fn(); if (r) return r; await wait(80) } throw new Error(label) }
const launch = async (appOnly = false) => {
  const env = { ...process.env, MASAKI_PROFILE: profile, MASAKI_TEST_HEADLESS: '1', MASAKI_TEST_INACTIVE: '1' }; delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [root, ...(appOnly ? ['--app=' + base + '/login'] : [])], cwd: root, env, colorScheme: null })
  page = await app.firstWindow(); page.on('pageerror', (e) => errors.push(e.message))
  page.setDefaultTimeout(12000)
  await page.waitForSelector('.stage'); mainId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id)
  await app.evaluate(({app})=>{
    process._reviewLogs=[]
    app.on('web-contents-created',(_e,wc)=>{
      wc.on('console-message',(_e,d)=>process._reviewLogs.push({console:d?.message ?? d}))
      wc.on('preload-error',(_e,p,error)=>process._reviewLogs.push({preload:p,error:error.message}))
      wc.on('ipc-message',(_e,ch)=>process._reviewLogs.push({ipc:ch,origin:_e.senderFrame?.origin}))
    })
  })
  await until(() => page.evaluate(() => !!window.masaki && document.querySelectorAll('webview').length > 0 || !!document.querySelector('.tablist')), 'boot')
}
const command = (c) => app.evaluate(({ BrowserWindow }, [id, c]) => BrowserWindow.fromId(id).webContents.send('command', c), [mainId, c])
const wcId = (p = page) => p.evaluate(() => document.querySelector('webview.wv.on')?.getWebContentsId())
const guest = async (code, p = page) => app.evaluate(({ webContents }, [id, code]) => webContents.fromId(id).executeJavaScript(code, true), [await wcId(p), code])
const open = async (url) => { await command({ type: 'open-url', url }); await until(async () => { try { return await guest('location.href') === url } catch { return false } }, 'open ' + url); await until(async () => await guest('document.readyState') === 'complete', 'ready') }
const shot = async (name, p = page) => {
  await wait(550)
  const id = await p.evaluate(() => window.masaki.appUrl)
  const b64 = await app.evaluate(async ({ BrowserWindow }, [mainId, appUrl]) => {
    const w = appUrl ? BrowserWindow.getAllWindows().find((w) => w.id !== mainId) ?? BrowserWindow.fromId(mainId) : BrowserWindow.fromId(mainId)
    return (await w.capturePage()).toPNG().toString('base64')
  }, [mainId, id])
  fs.writeFileSync(path.join(out, `review-fixed-${name}.png`), Buffer.from(b64, 'base64'))
}
try {
  await launch(mode === 'apps')
  if (mode === 'forms') {
    await page.evaluate((u) => window.masaki.passwords.save({ url: u, username: 'tester', password: 'Secret-Test-123' }), base)
    await page.evaluate((u) => window.masaki.passwords.save({ url: u, username: 'frame-user', password: 'Frame-Secret-123' }), cross)
    await open(base + '/email'); await guest('document.getElementById("user").focus()')
    await page.locator('.af-menu .af-row').first().waitFor()
    await page.locator('.af-menu .af-row').first().dispatchEvent('mousedown')
    await until(async () => await guest('document.getElementById("pass").value') === 'Secret-Test-123', 'email fill')
    await open(base + '/cross')
    await guest('window.addEventListener("message",e=>window.lastFormMessage={data:e.data,source:!!e.source,match:[...document.querySelectorAll("iframe")].some(f=>f.contentWindow===e.source)});null')
    const frame = async (code) => app.evaluate(({ webContents }, [id, code]) => webContents.fromId(id).mainFrame.framesInSubtree.find((f) => f.url.endsWith('/frame')).executeJavaScript(code, true), [await wcId(), code])
    await until(async () => { try { return await frame('document.readyState') === 'complete' } catch { return false } }, 'frame ready')
    const outer = await guest('document.querySelector("iframe").getBoundingClientRect().toJSON()')
    const inner = JSON.parse(await frame('JSON.stringify(document.getElementById("user").getBoundingClientRect().toJSON())'))
    await clickGuest(app, await wcId(), outer.x + 2 + inner.x + inner.width / 2, outer.y + 2 + inner.y + inner.height / 2)
    // У скрытого окна OOPIF не получает нативный hit-test; фокус и его событие подаём самому фрейму.
    await frame('document.getElementById("user").focus();document.getElementById("user").dispatchEvent(new FocusEvent("focusin",{bubbles:true}));null')
    try { await page.locator('.af-menu .af-row').first().waitFor() } catch (e) {
      console.log('FRAME MESSAGE', await guest('window.lastFormMessage'))
      console.log('FRAME STATE', await frame('JSON.stringify({active:document.activeElement?.id,hasFocus:document.hasFocus(),url:location.href,secure:isSecureContext})'))
      console.log('FRAME ERRORS', await app.evaluate(({webContents},id)=>webContents.fromId(id).mainFrame.framesInSubtree.map(f=>({url:f.url,origin:f.origin})),await wcId()))
      console.log('PRELOAD LOGS', await app.evaluate(()=>process._reviewLogs))
      throw e
    }
    await shot('iframe')
    const pos = await page.locator('.af-menu').boundingBox(); assert.ok(pos.y > 200 && pos.x > 430, 'геометрия учитывает iframe')
    await page.locator('.af-menu .af-row').first().dispatchEvent('mousedown')
    await until(async () => await frame('document.getElementById("pass").value') === 'Frame-Secret-123', 'cross-origin password fill')
    assert.equal(await guest('document.getElementById("parent").value'), 'Parent')
    await page.evaluate(() => window.masaki.autofill.saveAddress({ name: 'Test Name', street: 'Street 1\nFlat 2', city: 'City', country: 'RU', phone: '123', zip: '12345' }))
    await open(base + '/checkout'); await guest('document.getElementById("given").focus()')
    await page.locator('.af-menu .af-row').first().waitFor(); await page.locator('.af-menu .af-row').first().dispatchEvent('mousedown')
    await until(async () => await guest('document.getElementById("street").value') === 'Street 1\nFlat 2', 'textarea')
    assert.equal(await guest('document.getElementById("given").value'), 'Test')
    assert.equal(await guest('document.getElementById("family").value'), 'Name')
    assert.equal(await guest('document.getElementById("country").value'), 'RU')
    assert.equal(await guest('document.getElementById("billing").value'), '')
    await command({ type: 'open-url', url: 'masaki://passwords' }); await page.getByRole('button', { name: 'Изменить адрес', exact: true }).click()
    assert.equal(await page.getByRole('textbox', { name: 'Улица, дом, квартира', exact: true }).inputValue(), 'Street 1\nFlat 2')
    assert.equal(await page.getByRole('textbox', { name: 'Город', exact: true }).inputValue(), 'City')
    await page.locator('.pw-edit').getByRole('button', { name: 'Сохранить', exact: true }).click()
    await page.getByRole('button', { name: 'Удалить адрес', exact: true }).click()
    await until(() => page.getByRole('button', { name: 'Удалить адрес', exact: true }).count().then((n) => n === 0), 'reactive delete')
    await page.getByRole('button', { name: 'Адрес', exact: true }).click()
    await page.getByRole('textbox', { name: 'Имя и фамилия', exact: true }).fill('New Address')
    await page.locator('.pw-edit').getByRole('button', { name: 'Сохранить', exact: true }).click()
    await page.getByRole('button', { name: 'Удалить адрес', exact: true }).waitFor()
    await command({ type: 'history' })
    await page.getByRole('heading', { name: 'История', exact: true }).waitFor()
    assert.equal(await page.locator('.dlp-main').first().getAttribute('title'), base + '/checkout', 'свежий визит сверху')
    console.log('OK: email, заполнение cross-origin iframe, координаты, textarea/select/секции и редактор адреса')
  } else if (mode === 'folders') {
    const tiles = page.locator('.side .favs > .fvt')
    assert.equal(await tiles.count(), 3, 'папка занимает одну ячейку')
    const folder = page.getByRole('button', { name: 'Папка «Чтение», закладок: 4', exact: true })
    assert.equal(await folder.locator('.fav-folder-cover .fav').count(), 4)
    await until(() => folder.locator('.fav-folder-cover img').evaluateAll((nodes) => nodes.length === 4 && nodes.every((n) => n.naturalWidth > 0)), 'четыре настоящих значка')
    await folder.click(); await page.locator('.fav-folder-pop').waitFor()
    assert.equal(await page.locator('.fav-folder-pop .fvt').count(), 4)
    const a = await folder.boundingBox(), b = await page.getByRole('button', { name: 'Root', exact: true }).boundingBox()
    assert.equal(a.width, b.width); assert.equal(a.height, b.height)
    await shot('folder'); await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Root', exact: true }).click({ button: 'right' })
    assert.ok((await page.locator('.cm-head').textContent()).includes('Root'))
    await page.getByRole('menuitem', { name: 'Убрать из избранного', exact: true }).click()
    const saved = await page.evaluate(() => window.masaki.settings.get())
    assert.equal(saved.favorites.filter((f) => f.folder === 'Чтение').length, 4)
    assert.equal(saved.favorites.some((f) => f.title === 'Root'), false)
    const data = await page.evaluateHandle(() => new DataTransfer())
    const other = page.getByRole('button', { name: 'Other', exact: true })
    const target = await other.boundingBox()
    await folder.dispatchEvent('dragstart', { dataTransfer: data })
    await page.waitForTimeout(100)
    await other.dispatchEvent('dragenter', { dataTransfer: data })
    await other.dispatchEvent('dragover', { dataTransfer: data, clientX: target.x + target.width / 2, clientY: target.y + target.height / 2 })
    await other.dispatchEvent('drop', { dataTransfer: data })
    await folder.dispatchEvent('dragend', { dataTransfer: data })
    await until(async () => (await page.evaluate(() => window.masaki.settings.get())).favorites[0].title === 'Other', 'перестановка целой папки')
    const moved = await page.evaluate(() => window.masaki.settings.get())
    assert.equal(moved.favorites.filter((f) => f.folder === 'Чтение').length, 4)
    console.log('OK: папка — одна плитка с четырьмя значками, popup, меню удаляет выбранную закладку')
  } else {
    await page.locator('.app-mode').waitFor()
    await until(async () => { try { return await guest('document.readyState') === 'complete' } catch { return false } }, 'app guest')
    assert.equal(await page.locator('.side-wrap').isVisible(), false)
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
    await page.evaluate((u) => window.masaki.passwords.save({ url: u, username: 'tester', password: 'App-Secret-123' }), base)
    await guest('document.getElementById("user").focus()'); await page.locator('.af-menu .af-row').first().waitFor()
    await page.locator('.af-menu .af-row').first().dispatchEvent('mousedown')
    await until(async () => await guest('document.getElementById("pass").value') === 'App-Secret-123', 'app password')
    await guest('createKey();null'); await page.locator('.pk-card').waitFor()
    await page.locator('.pk-card .perm-btn.primary').click()
    await until(async () => typeof await guest('window.pkOut') === 'object', 'app passkey')
    assert.equal((await guest('window.pkOut')).clientExtensionResults.prf.enabled, true)
    await page.evaluate(() => window.masaki.passkeys.setPin('1234'))
    await guest(`window.conditionalResult='pending';navigator.credentials.get({mediation:'conditional',publicKey:{challenge:new Uint8Array([4,5,6])}}).then(()=>window.conditionalResult='signed',e=>window.conditionalResult=e.name);const u=document.getElementById('user');u.value='';u.setAttribute('autocomplete','username webauthn');u.focus();null`)
    await page.locator('.af-menu .af-pk').first().waitFor()
    await page.locator('.af-menu .af-pk').first().dispatchEvent('mousedown')
    const pin = page.getByLabel('PIN-код ключей доступа', { exact: true })
    await pin.fill('wrong'); await pin.press('Enter')
    await page.getByText('Неверный PIN — попробуйте ещё раз', { exact: true }).waitFor()
    assert.equal(await guest('window.conditionalResult'), 'pending')
    await pin.fill('1234'); await pin.press('Enter')
    await until(async () => await guest('window.conditionalResult') === 'signed', 'PIN in real app sheet')
    await page.evaluate(() => window.masaki.passkeys.setPin(null))
    await shot('app-passkey-created')
    await guest('location.href="/auth";null'); await page.locator('[aria-label="Вход по паролю"]').waitFor()
    await page.getByLabel('Логин', { exact: true }).fill('tester'); await page.getByLabel('Пароль', { exact: true }).fill('secret')
    await page.locator('[aria-label="Вход по паролю"]').getByRole('button', { name: 'Войти', exact: true }).click()
    await until(async () => { try { return await guest('document.readyState') === 'complete' && await guest('location.pathname') === '/auth' } catch { return false } }, 'app HTTP auth')
    await app.evaluate(({ desktopCapturer }) => { desktopCapturer.getSources = async () => [] })
    await guest('navigator.mediaDevices.getDisplayMedia({video:true}).then(s=>s.getTracks().forEach(t=>t.stop()),e=>window.displayError=e.name);null')
    await page.locator('.ds-card').waitFor(); await page.getByRole('button', { name: 'Отмена', exact: true }).click()
    await until(async () => typeof await guest('window.displayError') === 'string', 'app display cancel')
    await guest('window.open("/other","_blank");null')
    await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 2), 'browser opened from app')
    console.log('OK: приложение без главного окна — пароли, создание passkey, HTTP-вход, демонстрация и открытие ссылки браузером')
  }
  assert.deepEqual(errors, [])
} finally {
  await app?.close().catch(() => {}); clearTimeout(watchdog)
  site.closeAllConnections(); await new Promise((r) => site.close(r)); fs.rmSync(profile, { recursive: true, force: true })
}
