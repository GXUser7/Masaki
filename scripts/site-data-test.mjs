// Очистка кук из меню: границы сайтов, частные суффиксы, сохранность хранилищ и проверка отправителя IPC.
// Все адреса обслуживает локальный обработчик протокола; настоящий интернет и профиль не используются.
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'test-output')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-site-data-'))
const profile = path.join(temp, 'profile')
for (const dir of [out, profile]) fs.mkdirSync(dir, { recursive: true })
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
    (await inTab('document.readyState')) === 'complete', 'загрузка тестового сайта')
  await win.waitForTimeout(350)
}
async function shot(name) {
  await win.waitForTimeout(350)
  const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(b64, 'base64'))
}
async function seed(cookies) {
  await app.evaluate(async ({ session }, cookies) => {
    const ses = session.fromPartition('persist:frost')
    for (const cookie of cookies) await ses.cookies.set({ value: 'test-value', ...cookie })
  }, cookies)
}
const names = () => app.evaluate(async ({ session }) => (await session.fromPartition('persist:frost').cookies.get({}))
  .filter((c) => !c.name.startsWith('chip-')).map((c) => c.name).sort())
async function chips(seed = false) {
  return app.evaluate(async ({ webContents }, [id, seed]) => {
    const debug = webContents.fromId(id).debugger
    debug.attach('1.3')
    try {
      if (seed) {
        for (const [name, url, topLevelSite] of [
          ['chip-owned', 'https://deep.a.masaki.test', 'https://other.test'],
          ['chip-third-party', 'https://other.test', 'https://masaki.test']
        ]) {
          const result = await debug.sendCommand('Network.setCookie', {
            name, value: 'test-value', url, secure: true, sameSite: 'None',
            partitionKey: { topLevelSite, hasCrossSiteAncestor: true }
          })
          if (!result.success) throw new Error('Не удалось создать разделённые куки')
        }
      }
      // Storage.getCookies без browserContextId читает defaultSession, а webview живёт в persist:frost.
      const { cookies } = await debug.sendCommand('Network.getAllCookies')
      return cookies.filter((c) => c.name.startsWith('chip-')).map((c) => c.name).sort()
    } finally { debug.detach() }
  }, [await activeId(), seed])
}
const clear = async () => win.evaluate(([id, origin]) => window.masaki.site.clearCookies(id, origin), [await activeId(), await inTab('location.origin')])

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
    const fixture = '<!doctype html><meta charset="utf-8"><title>Тест очистки кук</title><h1>Локальная тестовая страница</h1>'
    for (const scheme of ['http', 'https']) {
      session.fromPartition('persist:frost').protocol.handle(scheme, () => new Response(fixture, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
      }))
    }
  })

  // Внутренним страницам куки не принадлежат: пункт меню отсутствует.
  await win.getByRole('button', { name: 'Меню', exact: true }).click()
  assert.equal(await win.getByRole('button', { name: 'Очистить куки текущего сайта', exact: true }).count(), 0)
  await win.getByRole('button', { name: 'Закрыть меню', exact: true }).click()
  await open('https://deep.a.masaki.test/nested/page')
  await seed([
    { url: 'https://masaki.test', domain: '.masaki.test', name: 'parent', httpOnly: true, secure: true },
    { url: 'https://deep.a.masaki.test', name: 'host', secure: true },
    { url: 'https://a.masaki.test/nested', domain: '.a.masaki.test', path: '/nested', name: 'path', secure: true },
    { url: 'http://b.masaki.test', name: 'sibling' },
    { url: 'https://other.test', name: 'other', httpOnly: true },
    { url: 'https://evilmasaki.test', name: 'suffix-collision' }
  ])
  assert.deepEqual(await chips(true), ['chip-owned', 'chip-third-party'])
  await app.evaluate(async ({ session }) => session.fromPartition('site-cookie-other-profile').cookies.set({
    url: 'https://masaki.test', name: 'other-profile', value: 'test-value'
  }))
  await inTab(`(async () => {
    localStorage.setItem('keep', 'local-value')
    sessionStorage.setItem('keep', 'session-value')
    const cache = await caches.open('keep')
    await cache.put('/cached', new Response('cache-value'))
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('keep', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('data')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction('data', 'readwrite')
        tx.objectStore('data').put('db-value', 'keep')
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => reject(tx.error)
      }
    })
  })()`)

  const id = await activeId()
  const untrusted = await app.evaluate(async ({ BrowserWindow }, id) => {
    const other = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } })
    try {
      await other.loadURL('about:blank')
      return await other.webContents.executeJavaScript(`require('electron').ipcRenderer.invoke('site:clear-cookies', ${JSON.stringify(id)}, 'https://deep.a.masaki.test')`)
    } finally { other.destroy() }
  }, id)
  assert.equal(untrusted.ok, false)
  assert.equal((await win.evaluate(() => window.masaki.site.clearCookies(-1, 'https://deep.a.masaki.test'))).ok, false)
  assert.equal((await win.evaluate((id) => window.masaki.site.clearCookies(id, 'https://stale.test'), id)).ok, false)
  assert.ok((await names()).includes('parent'))

  await win.getByRole('button', { name: 'Меню', exact: true }).click()
  const button = win.getByRole('button', { name: 'Очистить куки текущего сайта', exact: true })
  await button.waitFor()
  assert.match(await button.innerText(), /masaki\.test/)
  await shot('site-data-01-menu')
  await button.click()
  await waitFor(async () => (await button.innerText()).includes('Куки очищены'), 'результат очистки в меню')
  await waitFor(async () => await inTab('document.readyState') === 'complete', 'перезагрузка после очистки')
  assert.deepEqual(await names(), ['other', 'suffix-collision'])
  assert.deepEqual(await chips(), ['chip-third-party'])
  assert.equal(await app.evaluate(async ({ session }) => (await session.fromPartition('site-cookie-other-profile').cookies.get({})).length), 1)
  assert.deepEqual(await inTab(`(async () => {
    const dbValue = await new Promise((resolve, reject) => {
      const request = indexedDB.open('keep', 1)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const read = db.transaction('data').objectStore('data').get('keep')
        read.onsuccess = () => { db.close(); resolve(read.result) }
        read.onerror = () => reject(read.error)
      }
    })
    return [localStorage.getItem('keep'), sessionStorage.getItem('keep'), await (await caches.match('/cached')).text(), dbValue]
  })()`), ['local-value', 'session-value', 'cache-value', 'db-value'])
  await shot('site-data-02-cleared')
  await win.getByRole('button', { name: 'Закрыть меню', exact: true }).click()
  console.log('ok — меню очищает parent, HttpOnly, path и поддомены; чужие сайты и другой профиль сохранены')
  console.log('ok — localStorage, sessionStorage, IndexedDB и CacheStorage сохранены; посторонний IPC отклонён')
  console.log('ok — разделённые куки текущего домена удалены; чужие CHIPS с его topLevelSite сохранены')

  // Частный суффикс github.io: отдельные проекты — независимые сайты.
  await open('https://deep.alice.github.io/')
  await seed([
    { url: 'https://alice.github.io', domain: '.alice.github.io', name: 'alice-parent', secure: true },
    { url: 'https://deep.alice.github.io', name: 'alice-child', secure: true },
    { url: 'https://bob.github.io', name: 'bob', secure: true }
  ])
  assert.deepEqual(await clear(), { ok: true, site: 'alice.github.io', reloaded: true })
  assert.deepEqual(await names(), ['bob', 'other', 'suffix-collision'])

  // Многоуровневый публичный суффикс: нельзя объединять независимые *.co.uk.
  await open('https://www.example.co.uk/')
  await seed([
    { url: 'https://example.co.uk', domain: '.example.co.uk', name: 'uk-parent', secure: true },
    { url: 'https://sub.example.co.uk', name: 'uk-child', secure: true },
    { url: 'https://different.co.uk', name: 'uk-other', secure: true }
  ])
  assert.deepEqual(await clear(), { ok: true, site: 'example.co.uk', reloaded: true })
  assert.deepEqual(await names(), ['bob', 'other', 'suffix-collision', 'uk-other'])

  // localhost и IP не сводятся к общему «сайту без домена».
  await open('http://127.0.0.1/')
  await seed([
    { url: 'http://127.0.0.1', name: 'ip' },
    { url: 'http://localhost', name: 'localhost' }
  ])
  assert.equal((await clear()).ok, true)
  assert.deepEqual(await names(), ['bob', 'localhost', 'other', 'suffix-collision', 'uk-other'])
  console.log('ok — private suffix, co.uk, IP и localhost не стирают куки соседних сайтов')
} catch (e) {
  process.exitCode = 1
  console.error(e)
  if (app && win) await shot('site-data-99-failure').catch(() => {})
} finally {
  fs.writeFileSync(path.join(out, 'site-data-console.log'), logs.join('\n'))
  if (app) await app.close().catch(() => {})
  // Папка создана mkdtemp выше: очистка ограничена временными данными именно этого теста.
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}
