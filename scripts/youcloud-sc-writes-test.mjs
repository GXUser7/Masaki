// Real Electron/guest IPC for SoundCloud writes. Every HTTPS response is a local fixture;
// no account, real SoundCloud request or real CAPTCHA is used.
// After electron-vite build: node scripts/youcloud-sc-writes-test.mjs
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-sc-writes-'))
const output = path.join(root, 'test-output')
fs.mkdirSync(output, { recursive: true })
// hello prepares yt-dlp. A fresh, inert test-only placeholder prevents even a download check.
const ytDir = path.join(profile, 'yt-dlp')
fs.mkdirSync(ytDir)
fs.writeFileSync(path.join(ytDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'), 'test fixture; never executed')
fs.writeFileSync(path.join(ytDir, 'state.json'), JSON.stringify({ checkedAt: Date.now(), sha256: 'dummy' }))
const SITE = 'https://youcloud.inkerror67.workers.dev/'
const CAPTCHA = 'https://geo.captcha-delivery.com/captcha/?cid=masaki-fixture'
const WRITE = { url: 'https://api-v2.soundcloud.com/users/12/track_likes/34?client_id=fixture', method: 'PUT', token: 'synthetic-session' }
const logs = []
const launchEnv = { ...process.env, MASAKI_PROFILE: profile, MASAKI_TEST_INACTIVE: '1', MASAKI_TEST_HEADLESS: '1' }
delete launchEnv.ELECTRON_RUN_AS_NODE
let app
const watchdog = setTimeout(() => {
  console.error('ОШИБКА: SoundCloud integration test exceeded 90 seconds')
  app?.process().kill()
  process.exit(1)
}, 90_000)

async function until(read, label, timeout = 15_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const value = await read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Не дождались: ' + label)
}
const inSite = (code) => app.evaluate(({ webContents }, [origin, code]) => {
  const contents = webContents.getAllWebContents().find(c => c.getType() === 'webview' && c.getURL().startsWith(origin))
  if (!contents) throw new Error('Нет тестовой вкладки YouCloud')
  return contents.executeJavaScript(code, true)
}, [SITE, code])
const ask = (message, ms = 30_000) => inSite(`new Promise((resolve) => {
  const id = Math.random().toString(36)
  const handler = (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.yc !== 'ext' || event.data.kind !== 'response' || event.data.id !== id) return
    clearTimeout(timer); removeEventListener('message', handler); resolve(event.data)
  }
  addEventListener('message', handler)
  const timer = setTimeout(() => { removeEventListener('message', handler); resolve({error:'bridge timeout'}) }, ${ms})
  postMessage({yc:'page', id, ...${JSON.stringify(message)}}, location.origin)
})`)
const scWindow = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('https://soundcloud.com/'))?.id ?? null)
const scEval = (code) => app.evaluate(({ BrowserWindow }, code) => {
  const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('https://soundcloud.com/'))
  if (!window) throw new Error('Нет тестовой страницы SoundCloud')
  return window.webContents.executeJavaScript(code, true)
}, code)
const cookie = () => app.evaluate(async ({ session }) => (await session.fromPartition('persist:frost').cookies.get({ url: 'https://soundcloud.com/', name: 'datadome' }))[0]?.value)

try {
  app = await electron.launch({
    args: [root], cwd: root, colorScheme: null,
    env: launchEnv,
    timeout: 60_000,
  })
  const page = await app.firstWindow()
  page.on('console', message => logs.push(`[${message.type()}] ${message.text()}`))
  page.on('pageerror', error => logs.push(`[pageerror] ${error.message}`))
  await page.waitForSelector('.stage', { timeout: 30_000 })
  await app.evaluate(({ session }) => {
    globalThis.__scFixture = { status: 204, writes: [], requests: [] }
    const html = body => new Response('<!doctype html><meta charset="utf-8">' + body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
    const handle = async request => {
      const url = new URL(request.url)
      globalThis.__scFixture.requests.push(url.href)
      if (url.origin === 'https://youcloud.inkerror67.workers.dev') return html('<title>YouCloud fixture</title><h1>Подставной YouCloud</h1><p>Тест лайков и подписок без аккаунта.</p>')
      if (url.origin === 'https://soundcloud.com') return html(`<title>SoundCloud fixture</title><body style="font:20px system-ui;background:#24211f;color:#fff;padding:30px"><h1>Подставной SoundCloud</h1><p>Запросы выполняются в этой странице, проверка открывается здесь же.</p><script>
        // Electron protocol.handle bypasses Chromium's automatic Origin/Cookie headers.
        // Observe the native fetch call's real page and credentials before forwarding it.
        const nativeFetch = window.fetch.bind(window);
        window.fetch = (url, options) => {
          window.fixtureFetch = {origin: location.origin, cookie: document.cookie, credentials: options?.credentials};
          return nativeFetch(url, options);
        };
      </script>`)
      if (url.origin === 'https://api-v2.soundcloud.com') {
        const headers = { 'access-control-allow-origin': 'https://soundcloud.com', 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'PUT,POST,DELETE,OPTIONS', 'access-control-allow-headers': 'authorization,accept,x-datadome-clientid,content-type', 'cache-control': 'no-store' }
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
        globalThis.__scFixture.writes.push({ method: request.method, url: request.url, origin: request.headers.get('origin'), auth: request.headers.get('authorization'), datadome: request.headers.get('x-datadome-clientid'), cookie: request.headers.get('cookie') })
        const status = globalThis.__scFixture.status
        return new Response(status === 403 ? JSON.stringify({ url: 'https://geo.captcha-delivery.com/captcha/?cid=masaki-fixture' }) : null, { status, headers })
      }
      if (url.origin === 'https://geo.captcha-delivery.com') return html(`<title>Проверка (подставная)</title><body style="font:20px system-ui;padding:32px"><h1>Подставная проверка SoundCloud</h1><p>Это локальная проверка протокола сообщений, не настоящая капча.</p><button id="complete" style="padding:18px;font:inherit">Передать тестовый cookie</button><script>document.querySelector('#complete').onclick=()=>parent.postMessage({cookie:'datadome=solved%2Bproof; Domain=.soundcloud.com; Path=/; Secure; SameSite=Lax'},'https://soundcloud.com')</script>`)
      return new Response('External network disabled by test fixture', { status: 404, headers: { 'cache-control': 'no-store' } })
    }
    session.fromPartition('persist:frost').protocol.handle('https', handle)
    session.defaultSession.protocol.handle('https', handle)
    return session.fromPartition('persist:frost').cookies.set({ url: 'https://soundcloud.com/', name: 'datadome', value: 'initial%2Bproof', domain: '.soundcloud.com', secure: true, expirationDate: Date.now() / 1000 + 3600 })
  })
  await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].webContents.send('command', { type: 'open-url', url }), SITE)
  await until(() => app.evaluate(({ webContents }, site) => webContents.getAllWebContents().some(c => c.getType() === 'webview' && c.getURL().startsWith(site) && !c.isLoadingMainFrame()), SITE), 'тестовая вкладка YouCloud')
  const hello = await inSite(`new Promise(resolve=>{
    const handler=e=>{if(e.source===window&&e.origin===location.origin&&e.data?.yc==='ext'&&e.data.kind==='hello'){clearTimeout(timer);removeEventListener('message',handler);resolve(e.data)}}
    addEventListener('message',handler);const timer=setTimeout(()=>resolve(null),3000);postMessage({yc:'page',kind:'ping'},location.origin)
  })`)
  assert.equal(hello?.host, 'masaki')
  assert.equal(hello.version, '0.11.0')
  assert.ok(hello.capabilities?.includes('sc-page-writes'))
  console.log('ок: реальный guest IPC объявляет sc-page-writes')

  const first = await ask({ kind: 'call', name: 'sc-request', args: WRITE })
  assert.equal(first.value?.status, 204, JSON.stringify(first))
  const firstWindow = await scWindow()
  const writes = await app.evaluate(() => globalThis.__scFixture.writes)
  assert.equal(writes.length, 1)
  const pageFetch = await scEval('window.fixtureFetch')
  assert.equal(pageFetch.origin, 'https://soundcloud.com')
  assert.equal(pageFetch.credentials, 'include')
  assert.equal(writes[0].auth, 'OAuth synthetic-session')
  assert.equal(writes[0].datadome, 'initial+proof')
  assert.match(pageFetch.cookie, /datadome=initial%2Bproof/)
  console.log('ок: лайк из страницы SoundCloud с её cookie и DataDome-заголовком')

  for (const args of [
    { ...WRITE, url: 'https://api-v2.soundcloud.com/me' },
    { ...WRITE, url: 'https://evil.test/users/12/track_likes/34' },
    { ...WRITE, method: 'GET' },
    { ...WRITE, token: 'invalid\r\nsession' },
  ]) {
    const denied = await ask({ kind: 'call', name: 'sc-request', args })
    assert.ok(denied.error, JSON.stringify(denied))
  }
  assert.equal((await app.evaluate(() => globalThis.__scFixture.writes)).length, 1)
  console.log('ок: запрещённые маршруты и методы не достигают API')

  // Advance only the owned SC page's clock: no real 50s wait or process-wide clock change.
  // The main process still supplies its own deadline, which the page must enforce before fetch.
  await scEval(`window.fixtureNow = Date.now; Date.now = () => window.fixtureNow() + 60_000; true`)
  try {
    const expired = await ask({ kind: 'call', name: 'sc-request', args: { ...WRITE, expiresAt: '9999999999999' } })
    assert.match(expired.error ?? '', /устарел/)
    assert.equal((await app.evaluate(() => globalThis.__scFixture.writes)).length, 1, 'истёкший запрос не вызывает fetch')
  } finally {
    await scEval(`Date.now = window.fixtureNow; delete window.fixtureNow; true`)
  }
  console.log('ок: срок, заданный мостом, проверяется до fetch; страница не может продлить его аргументом')

  const follow = await ask({ kind: 'call', name: 'sc-request', args: { ...WRITE, url: 'https://api-v2.soundcloud.com/me/followings/34?client_id=fixture', method: 'POST' } })
  assert.equal(follow.value?.status, 204, JSON.stringify(follow))
  assert.equal(await scWindow(), firstWindow)
  await app.evaluate(() => { globalThis.__scFixture.status = 403 })
  const refused = await ask({ kind: 'call', name: 'sc-request', args: WRITE })
  assert.equal(refused.value?.status, 403, JSON.stringify(refused))
  const wrong = await ask({ kind: 'call', name: 'sc-captcha', args: { url: CAPTCHA.replace('masaki-fixture', 'other') } })
  assert.ok(wrong.error)
  const opened = await ask({ kind: 'call', name: 'sc-captcha', args: { url: CAPTCHA } })
  assert.equal(opened.value, true, JSON.stringify(opened))
  assert.equal(await scWindow(), firstWindow)
  await until(() => scEval(`!!document.querySelector('#youcloud-soundcloud-challenge iframe')`), 'iframe проверки')
  await until(() => app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('https://soundcloud.com/'))
    return window?.webContents.mainFrame.frames.some(frame => frame.url.startsWith('https://geo.captcha-delivery.com')) ?? false
  }), 'подставной iframe загрузился')
  await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('https://soundcloud.com/'))
    const frame = window.webContents.mainFrame.frames.find(frame => frame.url.startsWith('https://geo.captcha-delivery.com'))
    await frame.executeJavaScript(`new Promise(resolve => {
      const painted = () => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150)));
      if (document.readyState === 'complete') painted(); else addEventListener('load', painted, {once:true});
    })`, true)
  })
  const shot = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('https://soundcloud.com/'))
    return (await window.capturePage()).toPNG().toString('base64')
  })
  const shotPath = path.join(output, 'youcloud-sc-challenge.png')
  fs.writeFileSync(shotPath, Buffer.from(shot, 'base64'))
  console.log('снимок:', shotPath)

  await scEval(`(()=>{const frame=document.querySelector('iframe');for(const properties of [
    {origin:'https://evil.test',source:frame.contentWindow},
    {origin:'https://geo.captcha-delivery.com',source:window},
  ])dispatchEvent(new MessageEvent('message',{...properties,data:{cookie:'datadome=forged; Domain=.soundcloud.com; Path=/; Secure'}}))})()`)
  assert.equal(await cookie(), 'initial%2Bproof')
  await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('https://soundcloud.com/'))
    const frame = window.webContents.mainFrame.frames.find(frame => frame.url.startsWith('https://geo.captcha-delivery.com'))
    await frame.executeJavaScript(`parent.postMessage({cookie:'datadome=forged; Domain=.evil.test; Path=/; Secure'},'https://soundcloud.com')`, true)
  })
  assert.equal(await cookie(), 'initial%2Bproof')
  await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('https://soundcloud.com/'))
    const frame = window.webContents.mainFrame.frames.find(frame => frame.url.startsWith('https://geo.captcha-delivery.com'))
    await frame.executeJavaScript(`document.querySelector('#complete').click()`, true)
  })
  await until(async () => (await cookie()) === 'solved%2Bproof', 'cookie принят из правильного iframe')
  assert.equal(await scEval(`!!document.querySelector('#youcloud-soundcloud-challenge')`), false)
  await app.evaluate(() => { globalThis.__scFixture.status = 204 })
  const retried = await ask({ kind: 'call', name: 'sc-request', args: WRITE })
  assert.equal(retried.value?.status, 204, JSON.stringify(retried))
  assert.equal(await scWindow(), firstWindow)
  assert.equal((await app.evaluate(() => globalThis.__scFixture.writes)).at(-1).datadome, 'solved+proof')
  console.log('ок: поддельные сообщения отклонены; правильный cookie применяется следующему запросу в том же окне')

  await app.evaluate(() => { globalThis.__scFixture.status = 403 })
  await ask({ kind: 'call', name: 'sc-request', args: WRITE })
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).destroy(), firstWindow)
  const expired = await ask({ kind: 'call', name: 'sc-captcha', args: { url: CAPTCHA } })
  assert.ok(expired.error, JSON.stringify(expired))
  assert.equal(await scWindow(), null, 'устаревшая проверка не создаёт новое окно')
  const restarted = await ask({ kind: 'call', name: 'sc-request', args: WRITE })
  assert.equal(restarted.value?.status, 403, JSON.stringify(restarted))
  assert.notEqual(await scWindow(), firstWindow)
  const restartedWindow = await scWindow()
  await inSite(`location.hash = 'same-document'; true`)
  await until(() => inSite(`location.hash === '#same-document'`), 'переход по hash')
  assert.equal(await scWindow(), restartedWindow, 'hash не уничтожает страницу проверки')
  await inSite(`history.pushState({}, '', '#push-state'); true`)
  assert.equal(await scWindow(), restartedWindow, 'pushState не уничтожает страницу проверки')
  await app.evaluate(({ webContents }, site) => webContents.getAllWebContents().find(c => c.getType() === 'webview' && c.getURL().startsWith(site)).reload(), SITE)
  await until(async () => (await scWindow()) === null, 'reload владельца освобождает страницу проверки')
  await until(() => app.evaluate(({ webContents }, site) => webContents.getAllWebContents().some(c => c.getType() === 'webview' && c.getURL().startsWith(site) && !c.isLoadingMainFrame()), SITE), 'YouCloud перезагрузился')
  const afterReload = await ask({ kind: 'call', name: 'sc-request', args: WRITE })
  assert.equal(afterReload.value?.status, 403, JSON.stringify(afterReload))
  assert.notEqual(await scWindow(), restartedWindow, 'новый документ получает новую страницу SoundCloud')
  console.log('ок: hash и pushState сохраняют страницу проверки; reload освобождает её, новый документ создаёт новую')
  await app.evaluate(({ webContents }, site) => webContents.getAllWebContents().find(c => c.getType() === 'webview' && c.getURL().startsWith(site)).destroy(), SITE)
  await until(async () => (await scWindow()) === null, 'окно проверки закрыто вместе с вкладкой YouCloud')
  console.log('ок: закрытая проверка истекает; новая отправка пересоздаёт страницу; закрытие YouCloud освобождает её')
  console.log('SoundCloud bridge: все проверки прошли без реальной сети или аккаунта')
} catch (error) {
  console.error('ОШИБКА:', error)
  if (logs.length) fs.writeFileSync(path.join(output, 'youcloud-sc-writes-console.log'), logs.join('\n'))
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  await app?.close().catch(() => {})
  const tempRoot = path.resolve(os.tmpdir()) + path.sep
  if (!path.resolve(profile).startsWith(tempRoot) || !path.basename(profile).startsWith('masaki-sc-writes-')) throw new Error('Unsafe test profile cleanup path')
  fs.rmSync(profile, { recursive: true, force: true })
}
