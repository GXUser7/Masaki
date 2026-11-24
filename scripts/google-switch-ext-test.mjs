// Узкая регрессия исправлений:
// 1. MV3-расширение с Service Worker и chrome.webRequest.onCompleted (причина софт-лока AdBlock)
// 2. Очистка пустого query-параметра &pageId на *.google.com в onBeforeRequest (причина Error 400)
// 3. Точечные заголовки accounts.google.com в onBeforeSendHeaders (не ломают CORS ogs.google.com и ListAccounts)
// 4. Сохранение postBody (POST target="_blank") и Referer (по Referrer-Policy) в setWindowOpenHandler
//
// Все проверки идут против локальных HTTP/HTTPS серверов (к настоящему Google тест не ходит).
// Запуск: npm run build && node scripts/google-switch-ext-test.mjs
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'

const root = process.cwd()
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-gswitch-'))
const workDir = path.join(profile, '_work')
fs.mkdirSync(workDir, { recursive: true })

// 1. Генерируем временный самоподписанный сертификат для локального HTTPS-стенда (*.google.com, other.test).
const opensslExe =
  ['C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'openssl'].find((p) =>
    p.includes('\\') ? fs.existsSync(p) : true
  ) ?? 'openssl'
const keyPath = path.join(workDir, 'key.pem')
const certPath = path.join(workDir, 'cert.pem')
const sslConf = path.join(workDir, 'openssl.cnf')
fs.writeFileSync(
  sslConf,
  `[req]
distinguished_name = dn
x509_extensions = v3_req
prompt = no
[dn]
CN = google.com
[v3_req]
subjectAltName = DNS:google.com,DNS:*.google.com,DNS:other.test,IP:127.0.0.1
`
)
execFileSync(
  opensslExe,
  ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath, '-days', '2', '-nodes', '-config', sslConf],
  { stdio: 'ignore' }
)

// 2. Распакованное MV3-расширение с Service Worker и наблюдателями chrome.webRequest (как у AdBlock).
const swExtDir = path.join(workDir, 'ext-wr-sw')
fs.mkdirSync(swExtDir, { recursive: true })
fs.writeFileSync(
  path.join(swExtDir, 'manifest.json'),
  JSON.stringify({
    manifest_version: 3,
    name: 'Test WR ServiceWorker',
    version: '1.0.0',
    background: { service_worker: 'sw.js' },
    permissions: ['webRequest', 'declarativeNetRequest', 'declarativeNetRequestFeedback'],
    host_permissions: ['<all_urls>']
  })
)
fs.writeFileSync(
  path.join(swExtDir, 'sw.js'),
  `
  const observed = [];
  chrome.webRequest.onCompleted.addListener((d) => {
    observed.push({ event: 'onCompleted', url: d.url, statusCode: d.statusCode });
  }, { urls: ['<all_urls>'] });
  chrome.webRequest.onSendHeaders.addListener((d) => {
    observed.push({ event: 'onSendHeaders', url: d.url });
  }, { urls: ['<all_urls>'] });
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg === 'wr-stats') sendResponse({ count: observed.length, urls: observed.map((x) => x.url) });
  });
`
)

// 3. Локальные HTTP и HTTPS серверы для фиксации реальных запросов из сетевого стека Chromium.
const httpRequests = []
const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })

const httpSrv = http.createServer(async (req, res) => {
  const body = await readBody(req)
  const u = new URL(req.url, `http://${req.headers.host}`)
  httpRequests.push({
    method: req.method,
    path: u.pathname + u.search,
    host: req.headers.host,
    referer: req.headers.referer ?? null,
    contentType: req.headers['content-type'] ?? null,
    body
  })
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  if (u.pathname === '/opener') {
    return res.end(`<!doctype html><meta charset="utf-8"><title>Opener</title>
      <form id="f-url" method="POST" action="/post-target" target="_blank">
        <input name="a" value="hello"><input name="b" value="world">
        <button id="go-post" type="submit">Post</button>
      </form>
      <form id="f-mp" method="POST" enctype="multipart/form-data" action="/mp-target" target="_blank">
        <input name="field" value="mpval">
        <button id="go-mp" type="submit">MP</button>
      </form>
      <a id="same-ref" href="/ref-target?k=1" target="_blank">Same</a>
      <a id="cross-ref" href="http://other.test:${httpPort}/cross-target" target="_blank">Cross</a>
      <a id="no-ref" href="/noref-target" target="_blank" referrerpolicy="no-referrer">NoRef</a>`)
  }
  res.end(`<!doctype html><meta charset="utf-8"><title>HTTP ${u.pathname}</title><pre>${req.method} ${u.pathname}</pre>`)
})
await new Promise((r) => httpSrv.listen(0, '127.0.0.1', r))
const httpPort = httpSrv.address().port

const httpsRequests = []
const httpsSrv = https.createServer(
  { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
  async (req, res) => {
    const body = await readBody(req)
    const u = new URL(req.url, `https://${req.headers.host}`)
    const hostOnly = (req.headers.host || '').split(':')[0]
    httpsRequests.push({
      method: req.method,
      host: hostOnly,
      path: u.pathname + u.search,
      ua: req.headers['user-agent'] ?? '',
      origin: req.headers.origin ?? null,
      secChUa: Object.keys(req.headers).filter((k) => /^sec-ch-ua/i.test(k)),
      referer: req.headers.referer ?? null,
      body
    })
    if (hostOnly === 'accounts.google.com' && u.pathname === '/ListAccounts') {
      const origin = req.headers.origin || '*'
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
        'Cache-Control': 'no-store'
      })
      return res.end(`)]}'\n["gaia.l.a.r",[["gaia.l.a",1,"Tester","tester@example.com","",1,1,0]]]`)
    }
    if (hostOnly === 'accounts.google.com' && u.pathname === '/sub-api') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      return res.end(JSON.stringify({ ua: req.headers['user-agent'] ?? '', secChUa: Object.keys(req.headers).filter((k) => /^sec-ch-ua/i.test(k)) }))
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    if (hostOnly === 'ogs.google.com' && u.pathname === '/widget') {
      return res.end(`<!doctype html><meta charset="utf-8"><title>OGS Widget</title>
        <script>
          window.runListAccounts = async () => {
            const r = await fetch('https://accounts.google.com:${httpsPort}/ListAccounts?gpsia=1&source=ogb', {
              method: 'POST', credentials: 'include'
            });
            return { ok: r.ok, status: r.status, text: await r.text() };
          };
        </script>`)
    }
    if (hostOnly === 'accounts.google.com' && u.pathname === '/ServiceLogin') {
      return res.end(`<!doctype html><meta charset="utf-8"><title>Accounts Login</title>
        <script>
          window.loginInfo = { ua: navigator.userAgent, uad: !!navigator.userAgentData };
          window.runSubApi = async () => (await fetch('/sub-api')).json();
        </script>`)
    }
    res.end(`<!doctype html><meta charset="utf-8"><title>Google Mock ${hostOnly}</title><div>${u.pathname}${u.search}</div>`)
  }
)
await new Promise((r) => httpsSrv.listen(0, '127.0.0.1', r))
const httpsPort = httpsSrv.address().port

const app = await electron.launch({
  args: [
    root,
    `--host-resolver-rules=MAP *.google.com 127.0.0.1, MAP other.test 127.0.0.1`
  ],
  cwd: root,
  env: {
    ...process.env,
    MASAKI_TEST_HEADLESS: process.env.MASAKI_TEST_HEADLESS ?? '1',
    MASAKI_TEST_INACTIVE: '1',
    MASAKI_PROFILE: profile
  },
  colorScheme: null,
  timeout: 60000
})

const page = await app.firstWindow()
let failed = false

try {
  await page.waitForSelector('.tab, .dk-tab', { timeout: 20000 })
  await page.waitForTimeout(800)

  // Подключаем контроль uncaughtException и разрешаем локальный тестовый сертификат в сессии теста.
  await app.evaluate(({ session }) => {
    globalThis.__masakiTestUncaught = []
    process.on('uncaughtException', (err) => {
      globalThis.__masakiTestUncaught.push(String(err?.stack || err))
    })
    session.fromPartition('persist:frost').setCertificateVerifyProc((_req, cb) => cb(0))
  })

  const openAndWait = async (url, matchUrl) => {
    const beforeIds = await app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().filter((c) => c.getType() === 'webview').map((c) => c.id)
    )
    await app.evaluate(({ BrowserWindow }, u) => BrowserWindow.getAllWindows()[0].webContents.send('command', { type: 'open-url', url: u }), url)
    await page.waitForSelector('webview.wv.on', { timeout: 15000 })
    const start = Date.now()
    while (Date.now() - start < 15000) {
      const info = await app.evaluate(
        ({ webContents }, [prev, match]) => {
          const w = webContents
            .getAllWebContents()
            .find((c) => c.getType() === 'webview' && !prev.includes(c.id) && c.getURL().includes(match) && !c.isLoading())
          return w ? { id: w.id, url: w.getURL() } : null
        },
        [beforeIds, matchUrl]
      )
      if (info) return info
      await page.waitForTimeout(100)
    }
    throw new Error(`Таймаут загрузки ${url} (ожидали ${matchUrl})`)
  }

  // ---------- 0. Main-процесс ListAccounts (до загрузки webRequest-расширения из-за бага Electron 44 с ses.fetch) ----------
  httpsRequests.length = 0
  const mainListStatus = await app.evaluate(async ({ session }, port) => {
    const r = await session.fromPartition('persist:frost').fetch(`https://accounts.google.com:${port}/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard`, {
      method: 'POST',
      body: '',
      credentials: 'include'
    })
    return r.status
  }, httpsPort)
  assert.equal(mainListStatus, 200)
  const mainListReq = httpsRequests.find((r) => r.host === 'accounts.google.com' && r.path.startsWith('/ListAccounts'))
  assert.ok(mainListReq)
  assert.equal(mainListReq.origin, 'https://www.google.com', 'Запрос main-процесса без Origin получает Origin: https://www.google.com')
  assert.match(mainListReq.ua, /Chrome\//, 'Запрос ChromiumBrowser остаётся с Chrome UA')
  console.log('0. Main ListAccounts (Origin + Chrome UA): ок')

  // ---------- 1. Регрессия AdBlock / Service Worker chrome.webRequest ----------
  const extLoad = await app.evaluate(async ({ session }, dir) => {
    const ses = session.fromPartition('persist:frost')
    const ext = await ses.extensions.loadExtension(dir, { allowFileAccess: true })
    return { id: ext.id, name: ext.name }
  }, swExtDir)
  assert.ok(extLoad.id, 'MV3-расширение с webRequest должно загрузиться')

  const getWrStats = () =>
    app.evaluate(async ({ session, BrowserWindow }, extId) => {
      const ses = session.fromPartition('persist:frost')
      const w = new BrowserWindow({ show: false, webPreferences: { session: ses, offscreen: true } })
      try {
        await w.loadURL(`chrome-extension://${extId}/manifest.json`)
        return await Promise.race([
          w.webContents.executeJavaScript(`new Promise((resolve) => chrome.runtime.sendMessage('wr-stats', resolve))`),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500))
        ])
      } catch {
        return null
      } finally {
        w.destroy()
      }
    }, extLoad.id)

  // Ждём, пока Service Worker проснётся и зарегистрирует chrome.webRequest слушатели.
  let readyStats = null
  for (let i = 0; i < 20 && !readyStats; i++) {
    readyStats = await getWrStats()
    if (!readyStats) await page.waitForTimeout(250)
  }
  assert.ok(readyStats, 'Service Worker должен ответить до навигации')

  await openAndWait(`http://127.0.0.1:${httpPort}/opener?sw=1`, '/opener?sw=1')
  await page.waitForTimeout(500)

  const uncaught1 = await app.evaluate(() => globalThis.__masakiTestUncaught)
  assert.deepEqual(uncaught1, [], 'Не должно быть uncaughtException в main при webRequest + Service Worker')

  const wrStats = await getWrStats()
  console.log('1. SW webRequest stats:', JSON.stringify(wrStats))
  assert.ok(wrStats && wrStats.count > 0, 'Service Worker должен получить события webRequest (onCompleted/onSendHeaders)')
  assert.ok(wrStats.urls.some((u) => u.includes('/opener?sw=1')), 'SW должен увидеть /opener?sw=1')

  // ---------- 2. setWindowOpenHandler: POST target="_blank" и Referer ----------
  const openerTab = await openAndWait(`http://127.0.0.1:${httpPort}/opener?from=test`, '/opener?from=test')
  const evalTab = (id, code) =>
    app.evaluate(({ webContents }, [wcId, c]) => webContents.fromId(wcId).executeJavaScript(c), [id, code])

  const countBeforePost = httpRequests.length
  await evalTab(openerTab.id, `document.getElementById('go-post').click()`)
  await page.waitForFunction(() => document.querySelectorAll('webview.wv').length >= 2, null, { timeout: 10000 })
  await page.waitForTimeout(600)
  const postReq = httpRequests.slice(countBeforePost).find((r) => r.path === '/post-target')
  assert.ok(postReq, 'POST target="_blank" должен открыть запрос к /post-target')
  assert.equal(postReq.method, 'POST', 'Метод должен сохраняться как POST, а не сбрасываться в GET')
  assert.equal(postReq.body, 'a=hello&b=world', 'Тело формы POST должно передаваться')
  assert.match(postReq.contentType || '', /application\/x-www-form-urlencoded/i)
  assert.equal(postReq.referer, `http://127.0.0.1:${httpPort}/opener?from=test`)

  const countBeforeMp = httpRequests.length
  await evalTab(openerTab.id, `document.getElementById('go-mp').click()`)
  await page.waitForTimeout(700)
  const mpReq = httpRequests.slice(countBeforeMp).find((r) => r.path === '/mp-target')
  assert.ok(mpReq, 'multipart POST target="_blank" должен открыть запрос к /mp-target')
  assert.equal(mpReq.method, 'POST')
  assert.match(mpReq.contentType || '', /multipart\/form-data;\s*boundary=/i)
  assert.ok(mpReq.body.includes('mpval'), 'multipart-тело должно сохраняться')

  const countBeforeSame = httpRequests.length
  await evalTab(openerTab.id, `document.getElementById('same-ref').click()`)
  await page.waitForTimeout(600)
  const sameReq = httpRequests.slice(countBeforeSame).find((r) => r.path === '/ref-target?k=1')
  assert.ok(sameReq)
  assert.equal(sameReq.referer, `http://127.0.0.1:${httpPort}/opener?from=test`, 'Same-origin target="_blank" сохраняет полный Referer')

  const countBeforeCross = httpRequests.length
  await evalTab(openerTab.id, `document.getElementById('cross-ref').click()`)
  await page.waitForTimeout(600)
  const crossReq = httpRequests.slice(countBeforeCross).find((r) => r.path === '/cross-target')
  assert.ok(crossReq)
  assert.equal(crossReq.referer, `http://127.0.0.1:${httpPort}/`, 'Cross-origin target="_blank" передаёт только origin в Referer')

  const countBeforeNoRef = httpRequests.length
  await evalTab(openerTab.id, `document.getElementById('no-ref').click()`)
  await page.waitForTimeout(600)
  const noRefReq = httpRequests.slice(countBeforeNoRef).find((r) => r.path === '/noref-target')
  assert.ok(noRefReq)
  assert.equal(noRefReq.referer, null, 'referrerpolicy="no-referrer" не должен передавать Referer')
  console.log('2. setWindowOpenHandler POST + Referer: ок')

  // ---------- 3. Очистка пустого &pageId на *.google.com ----------
  httpsRequests.length = 0
  const gemClean = await openAndWait(`https://gemini.google.com:${httpsPort}/u/1/?hl=ru&pageId`, 'gemini.google.com')
  assert.equal(gemClean.url, `https://gemini.google.com:${httpsPort}/u/1/?hl=ru`)
  assert.ok(!httpsRequests.some((r) => r.path.includes('pageId')), 'Пустой &pageId не должен доходить до сервера Gemini')

  httpsRequests.length = 0
  const myAccClean = await openAndWait(`https://myaccount.google.com:${httpsPort}/u/2/?hl=ru&gar=WzJd&pageId=#sec`, 'myaccount.google.com')
  assert.equal(myAccClean.url, `https://myaccount.google.com:${httpsPort}/u/2/?hl=ru&gar=WzJd#sec`)
  assert.equal(httpsRequests.at(-1)?.path, '/u/2/?hl=ru&gar=WzJd')

  httpsRequests.length = 0
  const onlyPageId = await openAndWait(`https://gemini.google.com:${httpsPort}/u/1/?pageId=`, 'gemini.google.com')
  assert.equal(onlyPageId.url, `https://gemini.google.com:${httpsPort}/u/1/`)

  httpsRequests.length = 0
  const pageIdNone = await openAndWait(`https://gemini.google.com:${httpsPort}/u/1/?hl=ru&pageId=none`, 'pageId=none')
  assert.equal(pageIdNone.url, `https://gemini.google.com:${httpsPort}/u/1/?hl=ru&pageId=none`)

  httpsRequests.length = 0
  const pageIdNumeric = await openAndWait(`https://gemini.google.com:${httpsPort}/u/1/?hl=ru&pageId=123456`, 'pageId=123456')
  assert.equal(pageIdNumeric.url, `https://gemini.google.com:${httpsPort}/u/1/?hl=ru&pageId=123456`)
  console.log('3. stripEmptyGooglePageId (onBeforeRequest): ок')

  // ---------- 4. Точечные заголовки accounts.google.com (ListAccounts CORS + Firefox UA) ----------
  httpsRequests.length = 0
  const ogsTab = await openAndWait(`https://ogs.google.com:${httpsPort}/widget`, 'ogs.google.com')
  const ogsListRes = await evalTab(ogsTab.id, 'window.runListAccounts()')
  assert.equal(ogsListRes.ok, true, 'CORS на ListAccounts из ogs.google.com должен проходить')
  const ogsListReq = httpsRequests.find((r) => r.host === 'accounts.google.com' && r.path.startsWith('/ListAccounts'))
  assert.ok(ogsListReq)
  assert.equal(ogsListReq.origin, `https://ogs.google.com:${httpsPort}`, 'Origin запроса из ogs.google.com не должен перезаписываться')
  assert.match(ogsListReq.ua, /Chrome\//, 'Фоновый ListAccounts со страницы остаётся с Chrome UA')

  httpsRequests.length = 0
  const loginTab = await openAndWait(`https://accounts.google.com:${httpsPort}/ServiceLogin`, 'accounts.google.com')
  const loginDocReq = httpsRequests.find((r) => r.host === 'accounts.google.com' && r.path === '/ServiceLogin')
  assert.ok(loginDocReq)
  assert.match(loginDocReq.ua, /Firefox\/140\.0/, 'Верхний документ accounts.google.com видит Firefox UA')
  assert.deepEqual(loginDocReq.secChUa, [], 'sec-ch-ua должен удаляться на верхнем документе accounts.google.com')

  const loginJsInfo = await evalTab(loginTab.id, 'window.loginInfo')
  assert.match(loginJsInfo.ua, /Firefox\/140\.0/)
  assert.equal(loginJsInfo.uad, false)

  const subApi = await evalTab(loginTab.id, 'window.runSubApi()')
  assert.match(subApi.ua, /Firefox\/140\.0/, 'Запросы со страницы accounts.google.com тоже видят Firefox UA')
  assert.deepEqual(subApi.secChUa, [], 'Запросы со страницы accounts.google.com тоже без sec-ch-ua')
  console.log('4. Заголовки accounts.google.com (ListAccounts CORS + Firefox UA): ок')

  const uncaughtFinal = await app.evaluate(() => globalThis.__masakiTestUncaught)
  assert.deepEqual(uncaughtFinal, [], 'Итоговых uncaughtException не должно быть')

  console.log('ВСЁ ПРОШЛО УСПЕШНО!')
} catch (e) {
  failed = true
  console.error('ОШИБКА ТЕСТА:', e)
} finally {
  await app.close().catch(() => {})
  fs.rmSync(profile, { recursive: true, force: true })
  httpSrv.close()
  httpsSrv.close()
}
process.exit(failed ? 1 : 0)
