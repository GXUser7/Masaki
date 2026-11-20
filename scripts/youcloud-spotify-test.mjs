// Проверяет встроенный мост Spotify с подставными страницами и без настоящего аккаунта.
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { createServer } from 'node:https'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-spotify-'))
const site = 'https://youcloud.inkerror67.workers.dev/'
const spotify = 'https://open.spotify.com/'
const apiUrl = 'https://api-partner.spotify.com/pathfinder/v2/query'
const browserToken = 'fixture-browser-access-token'
const clientToken = 'fixture-browser-client-token'
const ytDir = path.join(profile, 'yt-dlp')
fs.mkdirSync(ytDir)
fs.writeFileSync(path.join(ytDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'), 'test fixture')
fs.writeFileSync(path.join(ytDir, 'state.json'), JSON.stringify({ checkedAt: Date.now(), sha256: 'fixture' }))
const env = { ...process.env, MASAKI_PROFILE: profile, MASAKI_TEST_INACTIVE: '1', MASAKI_TEST_HEADLESS: '1' }
delete env.ELECTRON_RUN_AS_NODE
let app
let server

async function until(check, label) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Не дождались: ' + label)
}

const request = (data, responseKind = 'response') => `new Promise(resolve => {
  const id = Math.random().toString(36)
  const handler = (event) => {
    const data = event.data
    if (event.source !== window || event.origin !== location.origin || data?.yc !== 'ext' || data.kind !== ${JSON.stringify(responseKind)}) return
    if (data.kind === 'response' && data.id !== id) return
    clearTimeout(timer)
    removeEventListener('message', handler)
    resolve(data)
  }
  const timer = setTimeout(() => { removeEventListener('message', handler); resolve(null) }, 30_000)
  addEventListener('message', handler)
  postMessage({ yc: 'page', id, ...${JSON.stringify(data)} }, location.origin)
})`

const evaluateGuest = (origin, script) => app.evaluate(({ webContents }, args) => {
  const guest = webContents.getAllWebContents().find(wc =>
    wc.getType() === 'webview' && wc.getURL().startsWith(args.origin))
  return guest?.executeJavaScript(args.script, true)
}, { origin, script })

const open = async (url) => {
  await app.evaluate(({ BrowserWindow }, target) => {
    BrowserWindow.getAllWindows()[0].webContents.send('command', { type: 'open-url', url: target })
  }, url)
  await until(() => evaluateGuest(url, 'document.readyState === "complete"').catch(() => false), url)
}

try {
  const names = [new URL(site).hostname, new URL(spotify).hostname, 'accounts.spotify.com', new URL(apiUrl).hostname]
  const config = path.join(profile, 'tls.cnf')
  const certFile = path.join(profile, 'cert.pem')
  const keyFile = path.join(profile, 'key.pem')
  fs.writeFileSync(config, `[req]
prompt = no
distinguished_name = dn
x509_extensions = ext
[dn]
CN = Spotify test fixture
[ext]
subjectAltName = ${names.map(name => 'DNS:' + name).join(',')}
`)
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', config, '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' })
  const cert = fs.readFileSync(certFile)
  // Доверяем только одноразовому сертификату подставного сервера.
  const publicKey = new X509Certificate(cert).publicKey.export({ format: 'der', type: 'spki' })
  const fixtureKey = createHash('sha256').update(publicKey).digest('base64')
  server = createServer({ key: fs.readFileSync(keyFile), cert }, (request, response) => {
    const url = new URL(request.url, 'https://' + request.headers.host)
    const html = (body) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<!doctype html>' + body)
    }
    if (url.origin === new URL(site).origin) return html('<title>YouCloud fixture</title>')
    if (url.hostname === 'accounts.spotify.com') {
      response.writeHead(302, {
        location: spotify, 'set-cookie': 'sp_dc=fixture-sign-in; Domain=.spotify.com; Path=/; Secure; HttpOnly'
      })
      return response.end()
    }
    if (url.origin === new URL(spotify).origin) {
      return html(`<title>Spotify fixture</title><script>
        fetch(${JSON.stringify(apiUrl)}, { method: 'POST', headers: {
          authorization: ${JSON.stringify('Bearer ' + browserToken)},
          'client-token': ${JSON.stringify(clientToken)}
        } }).catch(() => undefined)
      </script>`)
    }
    if (url.hostname === new URL(apiUrl).hostname) {
      const cors = {
        'access-control-allow-origin': new URL(spotify).origin,
        'access-control-allow-headers': 'authorization,client-token',
        'access-control-allow-methods': 'GET,POST,OPTIONS'
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(204, cors)
        return response.end()
      }
      const accepted = request.headers.authorization === 'Bearer ' + browserToken &&
        request.headers['client-token'] === clientToken &&
        request.headers.origin === new URL(spotify).origin
      response.writeHead(accepted ? 200 : 401, { ...cors, 'content-type': 'application/json' })
      return response.end(JSON.stringify({ accepted }))
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  const hostRules = names.map(name => `MAP ${name} 127.0.0.1:${server.address().port}`).concat('MAP * ~NOTFOUND')
  const linux = process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless', '--disable-gpu'] : []
  app = await electron.launch({
    args: [...linux, '--no-proxy-server', '--host-resolver-rules=' + hostRules.join(','), '--ignore-certificate-errors-spki-list=' + fixtureKey, root],
    cwd: root, env, timeout: 45_000
  })
  const window = await app.firstWindow()
  await window.waitForSelector('.stage')
  await open(site)
  const ask = (data) => evaluateGuest(site, request(data))
  const hello = await evaluateGuest(site, request({ kind: 'ping' }, 'hello'))
  assert.equal(hello.host, 'masaki')
  assert.ok(hello.capabilities.includes('sp-login'))
  assert.equal((await ask({ kind: 'call', name: 'sp-token' })).value, false)

  const rejected = await ask({ kind: 'fetch', request: { url: 'https://api-partner.spotify.com.example.test/' } })
  assert.match(rejected.error, /host not allowed/)
  await app.evaluate(({ session }, spotify) => session.fromPartition('persist:frost').cookies.set({
    url: spotify, name: 'sp_dc', value: 'fixture-cookie', httpOnly: true, secure: true
  }), spotify)
  assert.equal((await ask({ kind: 'call', name: 'sp-token' })).value, true)

  const renewed = await ask({ kind: 'call', name: 'sp-renew' })
  assert.ok(renewed?.value, 'Обновление вернуло сессию')
  assert.match(renewed.value.token, /^masaki-sp-/)
  assert.equal(renewed.value.clientToken, 'masaki')
  assert.ok(!JSON.stringify(renewed).includes(browserToken))

  const fetchCatalog = (token) => ask({ kind: 'fetch', request: {
    url: apiUrl, method: 'POST', body: '{}', headers: { authorization: 'Bearer ' + token, 'client-token': 'masaki' }
  } })
  const catalog = await fetchCatalog(renewed.value.token)
  assert.equal(catalog.status, 200)
  assert.equal(JSON.parse(catalog.body).accepted, true)
  assert.equal((await fetchCatalog('masaki-sp-dead')).status, 401)
  const second = site + '?second=1'
  await open(second)
  const elsewhere = await evaluateGuest(second, request({ kind: 'fetch', request: {
    url: apiUrl, method: 'POST', body: '{}', headers: { authorization: 'Bearer ' + renewed.value.token }
  } }))
  assert.equal(elsewhere.status, 401)

  await app.evaluate(({ session }, spotify) => session.fromPartition('persist:frost').cookies.remove(spotify, 'sp_dc'), spotify)
  assert.equal((await ask({ kind: 'call', name: 'sp-token' })).value, false)
  assert.equal((await fetchCatalog(renewed.value.token)).status, 401)

  await evaluateGuest(site, `addEventListener('message', e => {
    if (e.source === window && e.origin === location.origin && e.data?.yc === 'ext' && e.data.kind === 'sp-token') {
      window.fixtureLogin = e.data
    }
  })`)
  assert.equal((await ask({ kind: 'call', name: 'sp-login' })).value, true)
  const login = await until(() => evaluateGuest(site, 'window.fixtureLogin'), 'завершение входа Spotify')
  assert.match(login.token, /^masaki-sp-/)
  assert.ok(!JSON.stringify(login).includes(browserToken))
  assert.equal((await fetchCatalog(login.token)).status, 200)
  console.log('Spotify: capability, изоляция заголовков, обновление сессии, запрос каталога, выход и вход прошли')
} finally {
  await app?.close()
  server?.close()
  fs.rmSync(profile, { recursive: true, force: true })
}
