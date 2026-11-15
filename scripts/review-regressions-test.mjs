// Регрессии аудита: проверяем сохранность и публичные контракты настоящих модулей.
// Electron и дисковое хранилище заменяются только на границах; все секреты выдуманы.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { transformWithEsbuild } from 'vite'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-review-unit-'))
const hooks = { ui() {}, changed() {}, backedUp: () => false }
const electron = {
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
  webContents: { getAllWebContents: () => [] }, app: { getName: () => 'Test' }, clipboard: {}
}
async function load(relative, extra = {}) {
  const filename = path.join(root, 'src', relative + '.ts')
  const code = (await transformWithEsbuild(fs.readFileSync(filename, 'utf8'), filename, { format: 'cjs', target: 'es2022' })).code
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports, Buffer, URL, URLSearchParams, process, console, setTimeout, clearTimeout, setImmediate, __GOOGLE_CLIENT__: null,
    require(id) {
      if (id === 'electron') return electron
      if (id === './store') return { JsonFile: class { async read() { return null } write() {} flushSync() {} } }
      return require(id)
    }, ...extra
  }, { filename })
  return module.exports
}
try {
  const pw = await load('main/passwords'); await pw.initPasswords(hooks)
  const secrets = ['AA1,bb"cc', '=Abcdefghi123!', '+long123Password', 'a\nb\rc9!']
  secrets.forEach((password, i) => pw.save({ url: `https://csv${i}.example`, username: `user${i}`, password, note: 'тест, "заметка"\nстрока' }))
  const csv = path.join(temp, 'roundtrip.csv'); assert.equal(pw.exportTo(csv).ok, true)
  const copy = await load('main/passwords'); await copy.initPasswords(hooks); await copy.importCsv(csv, false)
  assert.equal(copy.list().length, secrets.length)
  for (let i = 0; i < secrets.length; i++) assert.equal(copy.reveal(copy.list().find((l) => l.username === `user${i}`).id), secrets[i])
  const audit = await load('main/passwords'); await audit.initPasswords(hooks)
  for (const [host, user] of [['one.example', 'a'], ['one.example', 'b']]) audit.save({ url: `https://${host}`, username: user, password: 'Strong12345678!' })
  assert.equal(audit.audit().reused.length, 0)
  audit.save({ url: 'https://other.example', username: 'c', password: 'Strong12345678!' })
  assert.equal(audit.audit().reused.length, 3)
  console.log('OK: точный CSV round-trip и повторение паролей на разных сайтах')

  const a = await load('main/autofill'); const b = await load('main/autofill')
  await a.initAutofill(hooks); await b.initAutofill(hooks)
  a.saveAddress({ name: 'Test Name', street: 'Street 1\nFlat 2', city: 'City', zip: '12345', country: 'RU', phone: '123', email: 'test@example.test' })
  const address = a.listAddresses()[0]
  assert.equal(address.street, 'Street 1\nFlat 2'); assert.equal(address.city, 'City')
  assert.equal(a.addressValues(a.getAddress(address.id))['given-name'], 'Test')
  a.saveCard({ holder: 'Test', number: '4242424242424242', exp: '12/29' })
  b.syncApply(a.syncExport())
  a.remove('address', address.id); a.remove('card', a.listCards()[0].id)
  assert.equal(a.syncExport().filter((r) => r.deleted).length, 2)
  b.syncApply(a.syncExport()); assert.equal(b.listAddresses().length, 0); assert.equal(b.listCards().length, 0)
  console.log('OK: полный адрес и tombstone адресов/карт между двумя хранилищами')

  const sync = await load('main/sync')
  const visit = { url: 'https://history.example', time: 100, title: 'Test' }
  assert.equal(sync.mergeHistory([[visit], []], 0, [visit.url + '|100']).length, 0)
  assert.equal(sync.mergeHistory([[{ ...visit, time: 200 }]], 0, [visit.url + '|100']).length, 1)
  console.log('OK: старое устройство не восстанавливает удалённое посещение, новый визит остаётся')

  const pk = await load('main/passkeys'); await pk.initPasskeys(hooks)
  const wc = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false, send() {} })
  const pub = { challenge: 'Y2hhbGxlbmdl', rp: { name: 'Test' }, user: { id: 'dXNlcg', name: 'test', displayName: 'Test' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], extensions: { prf: { eval: { first: 'c2FsdA' } }, largeBlob: { support: 'preferred' } } }
  const creating = pk.request(wc, 'https://site.example', 'create', JSON.stringify({ id: 'create', publicKey: pub }))
  pk.answer(pk.prompts()[0].id, 'ok'); const created = JSON.parse(await creating)
  assert.equal(created.cred.clientExtensionResults.prf.enabled, true)
  assert.equal(typeof created.cred.clientExtensionResults.prf.results.first, 'string')
  pk.setPin('1234')
  let settled = false
  const get = pk.request(wc, 'https://site.example', 'get', JSON.stringify({ id: 'get', mediation: 'conditional', publicKey: { challenge: pub.challenge } })).then((r) => { settled = true; return JSON.parse(r) })
  const record = pk.conditionalItems(wc)[0]
  pk.useConditional(wc, record.id)
  assert.equal(pk.prompts()[0].pinRequired, true)
  pk.answer(pk.prompts()[0].id, 'ok', record.id, 'wrong'); await Promise.resolve(); assert.equal(settled, false)
  pk.answer(pk.prompts()[0].id, 'ok', record.id, '1234'); const assertion = await get; assert.equal(assertion.ok, true)
  console.log('OK: conditional-вход требует правильный PIN')
  pk.setPin(null)
  const beforeWrite = pk.syncExport()[0].t
  const keyOptions = { challenge: pub.challenge, allowCredentials: [{ type: 'public-key', id: created.cred.id }] }
  const writing = pk.request(wc, 'https://site.example', 'get', JSON.stringify({ id: 'write', publicKey: { ...keyOptions, extensions: { largeBlob: { write: 'YmxvYi10ZXN0' } } } }))
  pk.answer(pk.prompts()[0].id, 'ok', record.id)
  assert.equal(JSON.parse(await writing).cred.clientExtensionResults.largeBlob.written, true)
  assert.ok(pk.syncExport()[0].t > beforeWrite, 'запись blob меняет версию для синхронизации')
  const reading = pk.request(wc, 'https://site.example', 'get', JSON.stringify({ id: 'read', publicKey: { ...keyOptions, extensions: { largeBlob: { read: true }, prf: { eval: { first: 'c2FsdA' } } } } }))
  pk.answer(pk.prompts()[0].id, 'ok', record.id)
  const readAssertion = JSON.parse(await reading)
  assert.equal(readAssertion.cred.clientExtensionResults.largeBlob.blob, 'YmxvYi10ZXN0')
  assert.equal(readAssertion.cred.clientExtensionResults.prf.results.first, created.cred.clientExtensionResults.prf.results.first)

  const PKC = class {}; const Container = class { create() {} get() {} }
  let sent
  const api = await load('preload/passkey-page', { window: { PublicKeyCredential: PKC, CredentialsContainer: Container, isSecureContext: true }, ArrayBuffer, Uint8Array, DOMException, btoa, atob,
    AuthenticatorAttestationResponse: class {}, AuthenticatorAssertionResponse: class {} })
  api.installPasskeys(async (op, json) => {
    sent = { op, ...JSON.parse(json) }
    return op === 'signal' ? JSON.stringify({ ok: true }) : JSON.stringify(op === 'create' ? created : readAssertion)
  })
  const credential = await new Container().create({ publicKey: { challenge: new Uint8Array([1]), user: { id: new Uint8Array([1]) } } })
  const output = credential.getClientExtensionResults()
  assert.ok(output.prf.results.first instanceof ArrayBuffer)
  assert.equal(typeof credential.toJSON().clientExtensionResults.prf.results.first, 'string')
  output.prf.results.first = null; assert.ok(credential.getClientExtensionResults().prf.results.first instanceof ArrayBuffer)
  const signaling = PKC.signalUnknownCredential({ rpId: 'site.example', credentialId: 'dGVzdA' })
  assert.equal(typeof signaling.then, 'function'); await signaling; assert.equal(sent.credentialId, 'dGVzdA')
  await PKC.signalAllAcceptedCredentials({ rpId: 'site.example', userId: 'dXNlcg', allAcceptedCredentialIds: ['dGVzdA'] })
  assert.equal(sent.allAcceptedCredentialIds[0], 'dGVzdA')
  await PKC.signalCurrentUserDetails({ rpId: 'site.example', userId: 'dXNlcg', name: 'new', displayName: 'New' })
  assert.equal(sent.userId, 'dXNlcg')
  const readCredential = await new Container().get({ publicKey: { challenge: new Uint8Array([1]), extensions: { prf: { eval: { first: new Uint8Array([2]) } }, largeBlob: { read: true } } } })
  assert.ok(readCredential.getClientExtensionResults().largeBlob.blob instanceof ArrayBuffer)
  assert.equal(typeof readCredential.toJSON().clientExtensionResults.largeBlob.blob, 'string')
  assert.ok(sent.publicKey.extensions.prf); assert.equal(sent.publicKey.extensions.largeBlob.read, true)
  await assert.rejects(PKC.signalUnknownCredential({ rpId: 'site.example', credentialId: new Uint8Array([1]) }))
  console.log('OK: бинарный JS API PRF, JSON, Promise/строки Signal и совместный PRF+largeBlob')

  const ses = new EventEmitter(); ses.setDisplayMediaRequestHandler = () => {}
  const application = new EventEmitter()
  const devices = await load('main/devices', { require(id) {
    if (id === 'electron') return { app: application, session: { fromPartition: () => ses }, ipcMain: { handle() {}, on() {} }, webContents: { fromFrame: () => ({ id: 7 }) } }
    return require(id)
  } })
  const asks = []
  devices.initDevices('test', { hasWindow: () => true, isUi: () => true, ui: (_c, d) => asks.push(d) })
  for (const kind of ['usb', 'hid', 'serial']) {
    let prevented = false, answer
    const e = { preventDefault() { prevented = true } }
    const done = (id) => { answer = id }
    if (kind === 'serial') ses.emit('select-serial-port', e, [{ portId: 'test', displayName: 'Test' }], { id: 7, getURL: () => 'https://site.example' }, done)
    else ses.emit('select-' + kind + '-device', e, { frame: { origin: 'https://site.example' }, deviceList: [{ deviceId: 'test', productName: 'Test', name: 'Test' }] }, done)
    assert.equal(prevented, true); assert.equal(answer, undefined)
    devices.answerDevice(asks.at(-1).id, 'test'); assert.equal(answer, 'test')
  }
  console.log('OK: USB/HID/Serial ждут выбора пользователя до callback')
} finally { fs.rmSync(temp, { recursive: true, force: true }) }
