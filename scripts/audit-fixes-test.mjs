// Узкие регрессии этого прогона: подтверждение ухода со страницы (beforeunload),
// страница истории и окно демонстрации экрана.
// node scripts/audit-fixes-test.mjs unload|history|display (после сборки)
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv[2]
assert.ok(['unload', 'history', 'display', 'iframe', 'autofill', 'passkey'].includes(mode), 'Выберите режим теста')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-audit-'))
const output = path.join(root, 'test-output')
fs.mkdirSync(output, { recursive: true })

const site = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://localhost').pathname
  const html = (body) => `<!doctype html><meta charset="utf-8"><title>${p.slice(1) || 'домой'}</title><style>body{background:#152221;color:#e2f1e9;font:20px sans-serif;margin:40px}button{font:inherit;padding:8px 16px}</style>${body}`
  if (p === '/pk') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    return res.end(html(`<h1>ключи</h1><pre id="out"></pre>
      <script>
        const raw = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
        const show = (x) => (document.getElementById('out').textContent = typeof x === 'string' ? x : JSON.stringify(x))
        async function create() {
          try {
            const c = await navigator.credentials.create({ publicKey: {
              challenge: raw('aaaaaaaaaaaaaaaa'), rp: { name: 'PK Test' },
              user: { id: raw('dXNlcjE='), name: 'user1', displayName: 'Пользователь 1' },
              pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
              extensions: { prf: { eval: { first: raw('c2FsdDFzYWx0MQ==') } } }
            }})
            show({ step: 'created', id: c.id, prf: c.getClientExtensionResults().prf })
          } catch (e) { show('create ERR ' + e.name) }
        }
        async function get(salt, allow) {
          try {
            const c = await navigator.credentials.get({ publicKey: {
              challenge: raw('bbbbbbbbbbbbbbbb'), rpId: location.hostname,
              allowCredentials: allow ? [{ type: 'public-key', id: raw(allow) }] : [],
              extensions: { prf: { eval: { first: raw(salt) } } }
            }})
            show({ step: 'got', prf: c.getClientExtensionResults().prf })
          } catch (e) { show('get ERR ' + e.name) }
        }
        async function signal(id) {
          PublicKeyCredential.signalUnknownCredential({ rpId: location.hostname, credentialId: raw(id) })
          show('signaled')
        }
      </script>`))
  }
  if (p === '/shop') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    return res.end(html(`<h1>оформление</h1><form>
      <input id="a1" autocomplete="name"><input id="a2" autocomplete="tel"><input id="a3" autocomplete="postal-code">
      <input id="c1" autocomplete="cc-name"><input id="c2" autocomplete="cc-number"><input id="c3" autocomplete="cc-exp">
    </form>`))
  }
  if (p === '/login-frame') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    return res.end(html(`<input id="user" type="email" autocomplete="username" placeholder="логин в iframe"><input id="pass" type="password">`))
  }
  if (p === '/with-frame') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    return res.end(html(`<h1>страница с формой внутри</h1><iframe id="f" src="/login-frame" style="width:420px;height:120px;border:1px solid #456"></iframe>`))
  }
  if (p === '/unload') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    return res.end(html(`<h1>уход</h1><button id="nav">перевести</button>
      <script>
        document.getElementById('nav').onclick = () => { location.href = '/next' }
        window.addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = 'форма не сохранена' })
      </script>`))
  }
  if (p === '/display') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    return res.end(html(`<h1>демо</h1><button id="go">показать</button><div id="out"></div>
      <script>
        document.getElementById('go').onclick = async () => {
          try {
            const s = await navigator.mediaDevices.getDisplayMedia({ video: true })
            document.getElementById('out').textContent = 'поток: ' + s.getVideoTracks()[0].label
          } catch (e) {
            document.getElementById('out').textContent = 'отказ: ' + e.name
          }
        }
      </script>`))
  }
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(html('<h1>' + p.slice(1) + '</h1>'))
})
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
const base = `http://localhost:${site.address().port}`
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ sidebarCollapsed: false, sleepAfter: 0, addons: { adblock: { enabled: false } } }))

let app, page, mainId
const errors = []
const watchdog = setTimeout(() => { console.error('Превышен лимит 90 секунд'); app?.process().kill(); process.exit(1) }, 90_000)
async function waitFor(fn, label) {
  const end = Date.now() + 12_000
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  console.log('UI ERRORS:', JSON.stringify(errors))
  try { await shot('99-audit-' + mode + '-fail') } catch {}
  throw new Error('Не дождались: ' + label)
}
async function shot(name) {
  await page.waitForTimeout(650)
  const png = await app.evaluate(async ({ BrowserWindow }, id) => (await BrowserWindow.fromId(id).capturePage()).toPNG().toString('base64'), mainId)
  fs.writeFileSync(path.join(output, `audit-${mode}-${name}.png`), Buffer.from(png, 'base64'))
}

try {
  const env = { ...process.env, MASAKI_PROFILE: profile, MASAKI_TEST_HEADLESS: '1', MASAKI_TEST_INACTIVE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [root], cwd: root, env, colorScheme: null })
  page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  mainId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id)
  const url = async () => page.evaluate(() => { try { return decodeURIComponent(document.querySelector('webview.wv.on')?.getURL() ?? '') } catch { return '' } })
  // Команды принимаются только после монтирования интерфейса — иначе первая open-url теряется.
  await page.waitForSelector('.tablist', { timeout: 20000 })

  if (mode === 'unload') {
    // Сайт с beforeunload. В скрытом прогоне вопрос отвечается «покинуть» автоматически — проверяем,
    // что навигация теперь проходит (раньше она отменялась молча и сайт «намертво зависал»).
    await app.evaluate(({ BrowserWindow }, [id, u]) => BrowserWindow.fromId(id).webContents.send('command', { type: 'open-url', url: u }), [mainId, base + '/unload'])
    await page.waitForSelector('webview.wv.on', { timeout: 15000 })
    await waitFor(async () => (await url()).endsWith('/unload'), 'страница с формой')
    await shot('boot')
    const wc = await page.evaluate(() => document.querySelector('webview.wv.on').getWebContentsId())
    // userGesture=true: без жеста пользователя Chromium игнорирует beforeunload, и вопроса не будет.
    const guest = (code) => app.evaluate(({ webContents }, [id, code]) => webContents.fromId(id).executeJavaScript(code, true), [wc, code])
    await guest(`document.getElementById('nav').click()`)
    await waitFor(async () => (await url()).endsWith('/next'), 'переход после beforeunload')
    await shot('left')
    console.log('OK: beforeunload больше не блокирует навигацию молча (в скрытом прогоне — автоответ «покинуть»)')
    } else if (mode === 'history') {
    await app.evaluate(({ BrowserWindow }, [id, u]) => BrowserWindow.fromId(id).webContents.send('command', { type: 'open-url', url: u }), [mainId, base + '/первая'])
    await page.waitForSelector('webview.wv.on', { timeout: 15000 })
    await waitFor(async () => (await url()).endsWith('/первая'), 'первая страница')
    await app.evaluate(({ BrowserWindow }, [id, u]) => BrowserWindow.fromId(id).webContents.send('command', { type: 'open-url', url: u }), [mainId, base + '/вторая'])
    await waitFor(async () => (await url()).endsWith('/вторая'), 'вторая страница')
    // Ctrl+H — страница истории.
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).webContents.send('command', { type: 'history' }), mainId)
    await waitFor(() => page.getByRole('heading', { name: 'История' }).count().then((n) => n > 0), 'страница истории')
    await waitFor(() => page.getByText('localhost', { exact: false }).count().then((n) => n >= 2), 'записи в истории')
    await shot('page')
    // Крестик у записи убирает её.
    const before = await page.locator('.dlp-row').count()
    await page.locator('.dlp-row').first().locator('button[aria-label="Убрать из истории"]').click()
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(await page.locator('.dlp-row').count(), before - 1, 'запись удалена')
    await shot('removed')
    console.log('OK: история открывается по Ctrl+H, записи на месте, удаление работает')
  } else if (mode === 'autofill') {
    // Адрес и карта подставляются у полей форм одним выбором; номер карты уходит на страницу только так.
    await page.evaluate(() => window.masaki.autofill.saveAddress({ name: 'Тест Тестов', street: 'ул. Примерная, 1', city: 'Москва', zip: '101000', phone: '+7 900 000-00-00' }))
    await page.evaluate(() => window.masaki.autofill.saveCard({ holder: 'TEST TESTOV', number: '4242 4242 4242 4242', exp: '12/29', nick: 'Тестовая' }))
    await app.evaluate(({ BrowserWindow }, [id, u]) => BrowserWindow.fromId(id).webContents.send('command', { type: 'open-url', url: u }), [mainId, base + '/shop'])
    await page.waitForSelector('webview.wv.on', { timeout: 15000 })
    await waitFor(async () => (await url()).endsWith('/shop'), 'форма магазина')
    const wc = await page.evaluate(() => document.querySelector('webview.wv.on').getWebContentsId())
    const guest = (code) => app.evaluate(({ webContents }, [id, code]) => webContents.fromId(id).executeJavaScript(code, true), [wc, code])
    await waitFor(async () => (await guest(`document.readyState`)) === 'complete', 'форма готова')
    // Адрес: фокус в поле имени — список — выбор — все поля адреса заполнены.
    await guest(`document.getElementById('a1').focus()`)
    await waitFor(() => page.locator('.af-menu').count().then((n) => n > 0), 'список адресов у поля')
    await page.locator('.af-menu .af-row').first().dispatchEvent('mousedown')
    await waitFor(async () => (await guest(`document.getElementById('a2').value`)) === '+7 900 000-00-00', 'телефон подставлен')
    assert.equal(await guest(`document.getElementById('a3').value`), '101000', 'индекс подставлен')
    await shot('address')
    // Карта: номер целиком, срок и держатель.
    await guest(`document.getElementById('c2').focus()`)
    await waitFor(() => page.locator('.af-menu').count().then((n) => n > 0), 'список карт у поля')
    await page.locator('.af-menu .af-row').first().dispatchEvent('mousedown')
    await waitFor(async () => (await guest(`document.getElementById('c2').value`)) === '4242424242424242', 'номер карты подставлен')
    assert.equal(await guest(`document.getElementById('c3').value`), '12/29', 'срок подставлен')
    assert.equal(await guest(`document.getElementById('c1').value`), 'TEST TESTOV', 'держатель подставлен')
    await shot('card')
    console.log('OK: адрес и карта подставляются одним выбором, форма заполняется целиком')
  } else if (mode === 'passkey') {
    // PRF: выводы от одного salt совпадают, от другого различаются; Signal API убирает удалённый на сайте ключ.
    await app.evaluate(({ BrowserWindow }, [id, u]) => BrowserWindow.fromId(id).webContents.send('command', { type: 'open-url', url: u }), [mainId, base + '/pk'])
    await page.waitForSelector('webview.wv.on', { timeout: 15000 })
    await waitFor(async () => (await url()).endsWith('/pk'), 'страница ключей')
    const wc = await page.evaluate(() => document.querySelector('webview.wv.on').getWebContentsId())
    const guest = (code) => app.evaluate(({ webContents }, [id, code]) => webContents.fromId(id).executeJavaScript(code, true), [wc, code])
    const out = () => guest(`document.getElementById('out').textContent`)
    await waitFor(async () => (await guest(`document.readyState`)) === 'complete', 'готова')
    await waitFor(async () => (await guest(`typeof create`)) === 'function', 'скрипт страницы')
    const clickOk = async (label) => {
      await waitFor(() => page.locator('.pk-card').count().then((n) => n > 0), 'окно ключа')
      // Окно входа подтверждается кликом по аккаунту, окно создания — кнопкой «Создать».
      // Доверенный клик Playwright у окна с анимацией нестабилен — жмём из самого интерфейса.
      await page.waitForTimeout(300)
      await page.evaluate(() => {
        document.querySelector('.pk-card .pk-acc')?.click()
        document.querySelector('.pk-card .perm-btn.primary')?.click()
      })
      await waitFor(() => page.locator('.pk-card').count().then((n) => n === 0), 'окно закрылось')
    }
    const started = await guest(`try { create(); null } catch (e) { 'THROW: ' + e.message }`)
    if (typeof started === 'string' && started.startsWith('THROW')) throw new Error(started)
    await clickOk()
    await waitFor(async () => (await out()).includes('created'), 'ключ создан')
    const r1 = JSON.parse((await out()).replace(/^/, ''))
    await guest(`get('c2FsdDFzYWx0MQ==', '${r1.id}'); null`)
    await clickOk()
    await waitFor(async () => (await out()).includes('got'), 'вход по ключу')
    const same = JSON.parse(await out())
    assert.equal(same.prf.first, r1.prf.first, 'PRF от того же salt совпадает')
    await guest(`get('c2FsdDJzYWx0MQ==', '${r1.id}'); null`)
    await clickOk()
    await waitFor(async () => (await out()).includes('got'), 'второй вход')
    const diff = JSON.parse(await out())
    assert.notEqual(diff.prf.first, r1.prf.first, 'PRF от другого salt другой')
    await guest(`signal('${r1.id}')`)
    await waitFor(async () => (await out()).includes('signaled'), 'сигнал ушёл')
    await guest(`get('c2FsdDFzYWx0MQ==', ''); null`)
    await waitFor(() => page.locator('.pk-card').count().then((n) => n > 0), 'окно «нет ключей»')
    const title = await page.locator('.pk-title').textContent()
    assert.ok((title ?? '').includes('нет ключей'), 'после сигнала ключа нет: ' + title)
    await page.locator('.pk-card .perm-btn.primary').click()
    await shot('passkey-signal')
    console.log('OK: PRF детерминирован, Signal API сверяет сейф с сайтом')
  } else if (mode === 'iframe') {
    // Форма входа внутри iframe: guest.js теперь сессионный и работает во всех фреймах,
    // пароли подбираются по origin фрейма. Сохранённый пароль того же хоста подойдёт.
    await app.evaluate(({ BrowserWindow }, [id, u]) => BrowserWindow.fromId(id).webContents.send('command', { type: 'open-url', url: u }), [mainId, base + '/with-frame'])
    await page.waitForSelector('webview.wv.on', { timeout: 15000 })
    await waitFor(async () => (await url()).endsWith('/with-frame'), 'страница с iframe')
    const wc = await page.evaluate(() => document.querySelector('webview.wv.on').getWebContentsId())
    const guest = (code) => app.evaluate(({ webContents }, [id, code]) => webContents.fromId(id).executeJavaScript(code, true), [wc, code])
    await waitFor(async () => (await guest(`!!document.getElementById('f')`)) === true, 'iframe на странице')
    // Пароль этого сайта (origin фрейма) — сохраняем средствами самого Masaki.
    await page.evaluate((u) => window.masaki.passwords.save({ url: u + '/login-frame', username: 'tester', password: 'parol-test' }), base)
    // Фокус в поле внутри iframe — список аккаунтов Masaki должен появиться над вкладкой.
    await guest(`document.getElementById('f').contentWindow.document.getElementById('user').focus()`)
    await waitFor(() => page.locator('.af-menu').count().then((n) => n > 0), 'список аккаунтов у поля в iframe')
    await shot('iframe-autofill')
    console.log('OK: пароли работают в iframe (список у поля появился по origin фрейма)')
  } else {
    await app.evaluate(({ BrowserWindow }, [id, u]) => BrowserWindow.fromId(id).webContents.send('command', { type: 'open-url', url: u }), [mainId, base + '/display'])
    await page.waitForSelector('webview.wv.on', { timeout: 15000 })
    await waitFor(async () => (await url()).endsWith('/display'), 'страница демонстрации')
    const wc = await page.evaluate(() => document.querySelector('webview.wv.on').getWebContentsId())
    const guest = (code) => app.evaluate(({ webContents }, [id, code]) => webContents.fromId(id).executeJavaScript(code, true).catch((e) => 'ERR:' + e), [wc, code])
    await waitFor(async () => (await guest('document.readyState')) === 'complete', 'готова')
    await guest(`document.getElementById('go').click()`)
    await waitFor(() => page.getByRole('heading', { name: 'Поделиться экраном' }).count().then((n) => n > 0), 'окно выбора экрана')
    await shot('picker')
    // Отказ: страница получает NotAllowedError, а не вечное ожидание.
    await page.getByRole('button', { name: 'Отмена' }).click()
    await waitFor(async () => (await guest(`document.getElementById('out').textContent`)).includes('отказ'), 'отказ дошёл до страницы')
    // И выбор источника, если Chromium их видит.
    await guest(`document.getElementById('go').click()`)
    const hasSource = await page.locator('.ds-src').count()
    if (hasSource > 0) {
      await page.locator('.ds-src').first().click()
      await waitFor(async () => (await guest(`document.getElementById('out').textContent`)).includes('поток'), 'поток выдан')
    }
    await shot('done')
    console.log(`OK: демо экрана спрашивает окно Masaki, отказ доходит${hasSource > 0 ? ', выбор источника работает' : ' (источников в скрытом окне нет — проверено только окно и отказ)'}`)
  }
  assert.deepEqual(errors, [], 'ошибки интерфейса')
} finally {
  await app?.close().catch(() => {})
  clearTimeout(watchdog)
  await new Promise((resolve) => site.close(resolve))
  fs.rmSync(profile, { recursive: true, force: true })
}
