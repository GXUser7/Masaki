// Тест ключей доступа (passkey): сайт на localhost создаёт ключ и входит им — окном Masaki и из списка
// у поля входа (mediation: conditional). Подписи и формат (clientDataJSON, attestationObject, COSE)
// проверяются здесь же, как их проверил бы сервер сайта. Плюс отказ, отмена, abort, «уже есть»,
// чужой RP ID и синхронизация ключа на второй профиль через шифрованный сейф подставного Google.
// Запуск: npm run test:passkeys. Снимки — test-output/pk-*.png.
import { _electron as electron } from 'playwright'
import { clickGuest as clickGuestInput } from './electron-input.mjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockGoogle } from './mock-google.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'test-output')
fs.mkdirSync(out, { recursive: true })
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const profiles = [tmp('masaki-pk-a-'), tmp('masaki-pk-b-')]
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

// ---------- Сайт ----------
const PAGE = `<!doctype html><meta charset="utf-8"><title>Ключи доступа</title>
<style>body{font:16px sans-serif;padding:40px;background:#fff;color:#111}input{display:block;margin:10px 0;font:inherit;padding:8px;width:280px}</style>
<h1>Вход по ключу</h1>
<input id="u" name="username" autocomplete="username webauthn" placeholder="Логин">
<script>
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
const unb = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
window.__r = null
window.start = (op, o) => {
  window.__r = null
  const ctl = new AbortController()
  window.__ctl = ctl
  const desc = (ids) => (ids || []).map((id) => ({ type: 'public-key', id: unb(id) }))
  const opts = op === 'create'
    ? { signal: ctl.signal, publicKey: { rp: { name: 'Тест', id: o.rpId }, user: { id: unb(o.userId), name: o.name, displayName: o.displayName },
        challenge: unb(o.challenge), pubKeyCredParams: o.algs.map((alg) => ({ type: 'public-key', alg })), excludeCredentials: desc(o.exclude),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, extensions: { credProps: true } } }
    : { signal: ctl.signal, mediation: o.mediation, publicKey: { challenge: unb(o.challenge), rpId: o.rpId, allowCredentials: desc(o.allow), userVerification: 'required' } }
  navigator.credentials[op](opts).then((c) => {
    const r = c.response
    window.__r = {
      ok: true,
      json: c.toJSON(),
      tag: Object.prototype.toString.call(c),
      isPKC: c instanceof PublicKeyCredential,
      isResp: op === 'create' ? r instanceof AuthenticatorAttestationResponse : r instanceof AuthenticatorAssertionResponse,
      ext: c.getClientExtensionResults(),
      rawIdOk: b64u(c.rawId) === c.id,
      alg: op === 'create' ? r.getPublicKeyAlgorithm() : null,
      transports: op === 'create' ? r.getTransports() : null,
      attach: c.authenticatorAttachment
    }
  }, (e) => (window.__r = { ok: false, name: e.name, message: e.message }))
  return true
}
</script>`
const site = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(PAGE)
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const SITE = `http://localhost:${site.address().port}/`
const ORIGIN = SITE.slice(0, -1)

// ---------- Проверка ответов, как на сервере сайта ----------
const unb64u = (s) => Buffer.from(s, 'base64url')
const sha256 = (b) => crypto.createHash('sha256').update(b).digest()
const challenge = () => crypto.randomBytes(32).toString('base64url')

/** Минимальный разбор CBOR: числа, байты, строки, массивы, карты. */
function cbor(buf) {
  let i = 0
  const len = (ai) => {
    if (ai < 24) return ai
    if (ai === 24) return buf[i++]
    if (ai === 25) return (i += 2), buf.readUInt16BE(i - 2)
    if (ai === 26) return (i += 4), buf.readUInt32BE(i - 4)
    throw new Error('CBOR: длина ' + ai)
  }
  const item = () => {
    const b = buf[i++]
    const major = b >> 5
    const n = len(b & 31)
    if (major === 0) return n
    if (major === 1) return -1 - n
    if (major === 2) return (i += n), buf.subarray(i - n, i)
    if (major === 3) return (i += n), buf.toString('utf8', i - n, i)
    if (major === 4) return Array.from({ length: n }, item)
    if (major === 5) {
      const m = new Map()
      for (let k = 0; k < n; k++) m.set(item(), item())
      return m
    }
    throw new Error('CBOR: тип ' + major)
  }
  const v = item()
  return { value: v, rest: buf.subarray(i) }
}

function verifyCreate(r, ch) {
  const resp = r.json.response
  const cd = JSON.parse(unb64u(resp.clientDataJSON).toString())
  check(cd.type === 'webauthn.create' && cd.challenge === ch && cd.origin === ORIGIN && cd.crossOrigin === false, 'clientDataJSON: тип, challenge и origin верные')
  const att = cbor(unb64u(resp.attestationObject)).value
  check(att.get('fmt') === 'none' && att.get('attStmt').size === 0, 'attestationObject: fmt none')
  const ad = att.get('authData')
  check(ad.subarray(0, 32).equals(sha256('localhost')), 'rpIdHash = sha256(localhost)')
  const flags = ad[32]
  check((flags & 0x45) === 0x45 && (flags & 0x08) === 0x08, 'флаги UP, UV, AT и BE')
  check(ad.readUInt32BE(33) === 0, 'счётчик подписей 0')
  const idLen = ad.readUInt16BE(53)
  const credId = ad.subarray(55, 55 + idLen)
  check(credId.toString('base64url') === r.json.id && r.rawIdOk, 'credential id совпадает в authData, id и rawId')
  const cose = cbor(ad.subarray(55 + idLen)).value
  const pub = crypto.createPublicKey({ key: unb64u(resp.publicKey), format: 'der', type: 'spki' })
  const jwk = pub.export({ format: 'jwk' })
  const alg = cose.get(3)
  if (alg === -7) check(cose.get(-2).toString('base64url') === jwk.x && cose.get(-3).toString('base64url') === jwk.y, 'COSE-ключ ES256 = getPublicKey()')
  else if (alg === -257) check(cose.get(-1).toString('base64url') === jwk.n, 'COSE-ключ RS256 = getPublicKey()')
  check(resp.authenticatorData === ad.toString('base64url'), 'getAuthenticatorData совпадает с authData')
  return { credId: r.json.id, pub, alg }
}

function verifyGet(r, ch, key, userId) {
  const resp = r.json.response
  const cdRaw = unb64u(resp.clientDataJSON)
  const cd = JSON.parse(cdRaw.toString())
  check(cd.type === 'webauthn.get' && cd.challenge === ch && cd.origin === ORIGIN, 'вход: clientDataJSON верный')
  const ad = unb64u(resp.authenticatorData)
  check(ad.length === 37 && ad.subarray(0, 32).equals(sha256('localhost')) && (ad[32] & 0x05) === 0x05 && !(ad[32] & 0x40), 'вход: authData с UP и UV, без AT')
  const ok = crypto.verify('sha256', Buffer.concat([ad, sha256(cdRaw)]), key.pub, unb64u(resp.signature))
  check(ok, `подпись ${key.alg === -7 ? 'ES256' : 'RS256'} проверяется открытым ключом с регистрации`)
  check(r.json.id === key.credId, 'вход тем ключом, что ждали')
  check(resp.userHandle === userId, 'userHandle = user.id с регистрации')
}

// ---------- Masaki ----------
async function launch(profile, tag) {
  const app = await electron.launch({
    args: [root],
    cwd: root,
    env: { ...process.env, MASAKI_TEST_HEADLESS: process.env.MASAKI_TEST_HEADLESS ?? '1', MASAKI_TEST_INACTIVE: '1', MASAKI_PROFILE: profile, MASAKI_SYNC_MOCK: mock.url },
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
    await new Promise((r) => setTimeout(r, 200))
  }
}

async function shot(app, name) {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(b64, 'base64'))
  console.log('  снимок', name)
}

async function inTab(m, code) {
  const id = await m.win.evaluate(() => document.querySelector('webview.wv.on')?.getWebContentsId())
  return m.app.evaluate(({ webContents }, [id, code]) => webContents.fromId(id).executeJavaScript(code), [id, code])
}

async function open(m, url) {
  await command(m.app, { type: 'open-url', url })
  await waitFor(async () => (await inTab(m, 'location.href').catch(() => '')) === url && (await inTab(m, 'document.readyState')) === 'complete', 'загрузка ' + url)
  await m.win.waitForTimeout(400)
}

async function clickIn(m, selector) {
  const r = await inTab(m, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  const wcId = await m.win.evaluate(() => document.querySelector('webview.wv.on').getWebContentsId())
  await clickGuestInput(m.app, wcId, r.x, r.y)
}

const start = (m, op, o) => inTab(m, `start(${JSON.stringify(op)}, ${JSON.stringify(o)})`)
const result = (m, what) => waitFor(() => inTab(m, 'window.__r'), what, 15000)
const syncState = (m) => m.win.evaluate(() => window.masaki.sync.state())
const keys = (m) => m.win.evaluate(() => window.masaki.passkeys.list())

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

const alice = { userId: Buffer.from('alice-1').toString('base64url'), name: 'alice@example.com', displayName: 'Алиса' }
const bob = { userId: Buffer.from('bob-2').toString('base64url'), name: 'bob@example.com', displayName: 'Боб' }

let current = null
try {
  console.log('A: возможности платформы')
  const A = (current = await launch(profiles[0], 'A'))
  await open(A, SITE)
  check((await inTab(A, 'PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()')) === true, 'сайт видит аутентификатор платформы')
  check((await inTab(A, 'PublicKeyCredential.isConditionalMediationAvailable()')) === true, 'сайт видит вход по ключу из автозаполнения')

  console.log('A: создание ключа ES256')
  let ch = challenge()
  await start(A, 'create', { ...alice, rpId: 'localhost', challenge: ch, algs: [-7, -257] })
  await A.win.waitForSelector('.pk-card:has-text("Создать ключ доступа для localhost")', { timeout: 8000 })
  await A.win.waitForTimeout(700)
  await shot(A.app, 'pk-01-create')
  check((await A.win.locator('.pk-card').textContent()).includes('Алиса'), 'в окне имя аккаунта')
  await A.win.click('.pk-card button:has-text("Создать")')
  let r = await result(A, 'создание ключа')
  check(r.ok, 'ключ создан: ' + (r.ok ? '' : r.name + ' ' + r.message))
  check(r.isPKC && r.isResp && r.tag === '[object PublicKeyCredential]', 'ответ — PublicKeyCredential с AuthenticatorAttestationResponse')
  check(r.ext?.credProps?.rk === true && r.alg === -7 && r.attach === 'platform' && r.transports.includes('internal'), 'credProps, алгоритм, attachment и transports')
  const k1 = verifyCreate(r, ch)
  check((await A.win.locator('.pk-card').count()) === 0, 'окно закрылось')
  const storeFile = path.join(profiles[0], 'passkeys.json')
  await waitFor(() => fs.existsSync(storeFile), 'запись passkeys.json')
  const store = fs.readFileSync(storeFile, 'utf8')
  check(!store.includes('BEGIN') && JSON.parse(store).keys.length === 1, 'в профиле один ключ, закрытый ключ зашифрован')

  console.log('A: второй аккаунт, RS256')
  ch = challenge()
  await start(A, 'create', { ...bob, rpId: 'localhost', challenge: ch, algs: [-257] })
  await A.win.waitForSelector('.pk-card:has-text("Боб")', { timeout: 8000 })
  await A.win.click('.pk-card button:has-text("Создать")')
  r = await result(A, 'создание RS256')
  check(r.ok && r.alg === -257, 'ключ RS256 создан')
  const k2 = verifyCreate(r, ch)

  console.log('A: вход окном Masaki')
  ch = challenge()
  await start(A, 'get', { rpId: 'localhost', challenge: ch })
  await A.win.waitForSelector('.pk-card:has-text("Войти на localhost")', { timeout: 8000 })
  check((await A.win.locator('.pk-acc').count()) === 2, 'в окне оба аккаунта')
  await A.win.waitForTimeout(700)
  await shot(A.app, 'pk-02-get')
  await A.win.click('.pk-acc:has-text("Алиса")')
  r = await result(A, 'вход Алисы')
  check(r.ok && r.isPKC && r.isResp, 'вход: ответ — PublicKeyCredential с AuthenticatorAssertionResponse')
  verifyGet(r, ch, k1, alice.userId)
  ch = challenge()
  await start(A, 'get', { rpId: 'localhost', challenge: ch, allow: [k2.credId] })
  await A.win.waitForSelector('.pk-acc:has-text("Боб")', { timeout: 8000 })
  check((await A.win.locator('.pk-acc').count()) === 1, 'allowCredentials сужает список до одного ключа')
  await A.win.click('.pk-acc:has-text("Боб")')
  r = await result(A, 'вход Боба')
  verifyGet(r, ch, k2, bob.userId)

  console.log('A: вход из списка у поля (conditional)')
  ch = challenge()
  await start(A, 'get', { rpId: 'localhost', challenge: ch, mediation: 'conditional' })
  await A.win.waitForTimeout(300)
  check((await A.win.locator('.pk-card').count()) === 0, 'conditional не открывает окно')
  await clickIn(A, '#u')
  await A.win.waitForSelector('.af-menu .af-pk', { timeout: 8000 })
  check((await A.win.locator('.af-pk').count()) === 2, 'в списке у поля оба ключа')
  await A.win.waitForTimeout(700)
  await shot(A.app, 'pk-03-conditional')
  await A.win.locator('.af-pk', { hasText: 'alice@example.com' }).click()
  r = await result(A, 'conditional-вход')
  verifyGet(r, ch, k1, alice.userId)
  check((await A.win.locator('.af-menu').count()) === 0, 'список закрылся')

  console.log('A: отказ, abort, «уже есть», «нет ключей», чужой RP ID')
  await start(A, 'create', { ...alice, rpId: 'localhost', challenge: challenge(), algs: [-7] })
  await A.win.waitForSelector('.pk-card', { timeout: 8000 })
  await A.win.click('.pk-card button:has-text("Отмена")')
  r = await result(A, 'отмена')
  check(!r.ok && r.name === 'NotAllowedError', 'отмена → NotAllowedError')

  await start(A, 'get', { rpId: 'localhost', challenge: challenge() })
  await A.win.waitForSelector('.pk-card', { timeout: 8000 })
  await inTab(A, '__ctl.abort()')
  r = await result(A, 'abort')
  check(!r.ok && r.name === 'AbortError', 'abort → AbortError')
  await A.win.waitForSelector('.pk-card', { state: 'detached', timeout: 5000 })
  check(true, 'окно закрылось по abort')

  await start(A, 'create', { ...alice, rpId: 'localhost', challenge: challenge(), algs: [-7], exclude: [k1.credId] })
  await A.win.waitForSelector('.pk-card:has-text("уже есть")', { timeout: 8000 })
  await A.win.waitForTimeout(600)
  await shot(A.app, 'pk-04-exists')
  await A.win.click('.pk-card button:has-text("Понятно")')
  r = await result(A, 'уже есть')
  check(!r.ok && r.name === 'InvalidStateError', 'excludeCredentials → InvalidStateError')

  await start(A, 'get', { rpId: 'localhost', challenge: challenge(), allow: ['AAAAAAAAAAAAAAAAAAAAAA'] })
  await A.win.waitForSelector('.pk-card:has-text("нет ключей")', { timeout: 8000 })
  await A.win.click('.pk-card button:has-text("Понятно")')
  r = await result(A, 'нет ключей')
  check(!r.ok && r.name === 'NotAllowedError', 'нет подходящих ключей → NotAllowedError')

  await start(A, 'create', { ...alice, rpId: 'example.com', challenge: challenge(), algs: [-7] })
  r = await result(A, 'чужой RP ID')
  check(!r.ok && r.name === 'SecurityError', 'ключ для чужого домена → SecurityError без окна')
  check((await A.win.locator('.pk-card').count()) === 0, 'окно для чужого домена не показано')

  console.log('A: страница паролей')
  await command(A.app, { type: 'palette', withUrl: false })
  await A.win.waitForSelector('.cmd')
  await A.win.keyboard.type('masaki://passwords')
  await A.win.keyboard.press('Enter')
  await A.win.waitForSelector('.pw-page .pw-row:has-text("localhost")')
  check((await A.win.locator('.pw-row:has-text("localhost")').count()) === 2, 'оба ключа на странице паролей')
  await A.win.locator('.pw-row:has-text("Боб")').scrollIntoViewIfNeeded()
  await shot(A.app, 'pk-05-page')

  console.log('A: синхронизация ключей')
  await signIn(A)
  await A.win.click('button[aria-label="Синхронизировать пароли"]')
  await A.win.waitForSelector('.sy-vault:has-text("Придумайте ключ")', { timeout: 10000 })
  await A.win.fill('input[aria-label="Ключ шифрования паролей"]', 'кот-в-сапогах-42')
  await A.win.fill('input[aria-label="Ключ ещё раз"]', 'кот-в-сапогах-42')
  await A.win.click('.sy-vault button:has-text("Включить")')
  await waitFor(async () => (await syncState(A)).vault === 'ready', 'ключ сейфа принят', 20000)
  await waitFor(() => Object.keys(mock.file('vault.json')?.items ?? {}).length >= 2, 'ключи на Диске', 15000)
  check(!/localhost|alice|Алиса|bob@/.test(JSON.stringify(mock.file('vault.json'))), 'на Диске ни сайтов, ни имён в открытом виде')
  await A.app.close()
  current = null

  console.log('B: ключ с A входит на сайт')
  const B = (current = await launch(profiles[1], 'B'))
  await signIn(B)
  await B.win.click('button[aria-label="Синхронизировать пароли"]')
  await B.win.waitForSelector('.sy-vault:has-text("Введите ключ")', { timeout: 10000 })
  await B.win.fill('input[aria-label="Ключ шифрования паролей"]', 'кот-в-сапогах-42')
  await B.win.click('.sy-vault button:has-text("Подключить")')
  await waitFor(async () => (await keys(B)).length === 2, 'ключи пришли на B', 20000)
  check(true, 'оба ключа пришли на B')
  await open(B, SITE)
  ch = challenge()
  await start(B, 'get', { rpId: 'localhost', challenge: ch })
  await B.win.waitForSelector('.pk-acc:has-text("Алиса")', { timeout: 8000 })
  await B.win.click('.pk-acc:has-text("Алиса")')
  r = await result(B, 'вход на B')
  verifyGet(r, ch, k1, alice.userId)

  const bobKey = (await keys(B)).find((k) => k.userName === 'bob@example.com')
  await B.win.evaluate((id) => window.masaki.passkeys.remove(id), bobKey.id)
  await B.win.evaluate(() => window.masaki.sync.syncNow())
  await B.app.close()
  current = null

  console.log('A: удаление с B дошло')
  const A2 = (current = await launch(profiles[0], 'A2'))
  await waitFor(async () => (await keys(A2)).length === 1, 'удаление ключа с B на A', 20000)
  check(true, 'ключ, удалённый на B, пропал и на A')
  await A2.app.close()
  current = null
} catch (e) {
  failures.push(e.message)
  console.error('ОШИБКА:', e.message)
  if (current) await shot(current.app, 'pk-99-failure').catch(() => {})
} finally {
  fs.writeFileSync(path.join(out, 'pk-console.log'), logs.join('\n'))
  if (current) await current.app.close().catch(() => {})
  await mock.close()
  site.close()
  for (const p of profiles) {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    } catch {
      console.log('  не удалось удалить временную папку', p)
    }
  }
}
console.log(failures.length ? `\nПРОВАЛОВ: ${failures.length}` : '\nВсё прошло')
process.exit(failures.length ? 1 : 0)
