// Настоящий YouCloud в скрытом Masaki: режимы фона и проверка пикселей размытия под поисковыми треками.
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { clickGuest } from './electron-input.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const webRoot = path.resolve(root, '../YouCloud/web')
const webRequire = createRequire(path.join(webRoot, 'package.json'))
const { createServer } = await import(pathToFileURL(webRequire.resolve('vite')).href)
const { svelte } = await import(pathToFileURL(webRequire.resolve('@sveltejs/vite-plugin-svelte')).href)
const { PNG } = createRequire(import.meta.url)('pngjs')
const server = await createServer({ configFile: false, root: webRoot, plugins: [svelte()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-yc-background-'))
const output = path.join(root, 'test-output')
fs.mkdirSync(output, { recursive: true })
let app, page, mainId, guest
const errors = []
const watchdog = setTimeout(() => { console.error('Лимит теста: 150 секунд'); app?.process().kill(); process.exit(1) }, 150_000)
const inSite = (code) => app.evaluate(({ webContents }, [id, code]) => webContents.fromId(id).executeJavaScript(code), [guest, code])
const command = (value) => app.evaluate(({ BrowserWindow }, [id, value]) => BrowserWindow.fromId(id).webContents.send('command', value), [mainId, value])
const visibleGuest = () => app.evaluate(({ webContents }, id) => {
  // Повторно применяем режим выбранной вкладки после её скрытия вместе с тестовым окном.
  const contents = webContents.fromId(id)
  contents.backgroundThrottling = true
  contents.backgroundThrottling = false
}, guest)
async function waitFor(fn, label, ms = 12_000) {
  const until = Date.now() + ms
  while (Date.now() < until) { if (await fn()) return; await new Promise((resolve) => setTimeout(resolve, 70)) }
  throw new Error('Не дождались: ' + label)
}
const shot = async (name) => {
  await page.mouse.move(12, 12)
  await page.waitForTimeout(800)
  const b64 = await app.evaluate(async ({ BrowserWindow }, id) => (await BrowserWindow.fromId(id).capturePage()).toPNG().toString('base64'), mainId)
  const bytes = Buffer.from(b64, 'base64')
  fs.writeFileSync(path.join(output, `youcloud-background-${name}.png`), bytes)
  return PNG.sync.read(bytes)
}
async function mode(name) {
  await command({ type: 'open-url', url: 'masaki://addons' })
  await page.getByRole('radiogroup', { name: 'Фон YouCloud', exact: true }).getByRole('radio', { name, exact: true }).click()
  await page.locator('.tab-main').filter({ hasText: 'YouCloud' }).first().click()
  await waitFor(async () => await page.locator('webview.wv.on').evaluate((el) => el.getWebContentsId()) === guest, 'возврат в YouCloud')
  await visibleGuest()
}
async function alignment() {
  const rect = await inSite(`(() => {const r=document.querySelector('.result-group.track-list').getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height,width:innerWidth,height:innerHeight}})()`)
  const host = await page.evaluate((rect) => {
    const layer = document.querySelector('.yc-host-glass.on'), sx = layer.clientWidth / rect.width, sy = layer.clientHeight / rect.height
    const wanted = { x: rect.x * sx, y: rect.y * sy, w: rect.w * sx, h: rect.h * sy }
    const match = [...layer.children].map((el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) }))
      .find((r) => ['x', 'y', 'w', 'h'].every((k) => Math.abs(r[k] - wanted[k]) < 2))
    const box = layer.getBoundingClientRect()
    return { match, wanted, panels: [...layer.children].map(el => el.style.cssText), viewport: { x: box.x, y: box.y, w: box.width, h: box.height }, sx, sy }
  }, rect)
  assert.ok(host.match, 'размытие совмещено с карточкой: ' + JSON.stringify(host))
  return { rect, ...host }
}
function contrast(png, x, y, width = 60) {
  const values = []
  for (let i = 0; i < width; i++) values.push(png.data[(Math.round(y) * png.width + Math.round(x + i)) * 4])
  return Math.max(...values) - Math.min(...values)
}

try {
  await server.listen()
  const local = `http://127.0.0.1:${server.httpServer.address().port}`
  const env = { ...process.env, MASAKI_PROFILE: profile, MASAKI_TEST_HEADLESS: '1', MASAKI_TEST_INACTIVE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [root], cwd: root, env, colorScheme: null })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.waitForSelector('.ntp')
  mainId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id)
  await app.evaluate(({ session }, local) => {
    const handle = async (request) => {
      const url = new URL(request.url)
      // Только статические шрифты; сайты сервисов и аккаунты в тесте не открываются.
      if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) return fetch(request.url)
      if (url.hostname !== 'youcloud.inkerror67.workers.dev') return new Response('{}', { headers: { 'content-type': 'application/json' } })
      if (url.pathname.startsWith('/x/')) {
        const tracks = url.pathname.includes('/search/tracks') ? Array.from({ length: 18 }, (_, i) => ({
          id: 1000 + i, title: 'Трек ' + (i + 1), duration: 180_000, permalink_url: 'https://soundcloud.com/test/' + i,
          user: { id: 1, username: 'Тестовый исполнитель', permalink: 'test' }, media: { transcodings: [] },
        })) : []
        return Response.json({ collection: tracks, next_href: null })
      }
      const response = await fetch(local + url.pathname + url.search)
      let body = Buffer.from(await response.arrayBuffer())
      if (url.pathname === '/') body = Buffer.from(body.toString().replace('<head>', `<head><script>
        localStorage.setItem('yc.lang','ru'); localStorage.setItem('yc.theme','dark');
        localStorage.setItem('yc.liveBackdrop','false'); localStorage.setItem('yc.sc.clientId','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      </script>`))
      return new Response(body, { status: response.status, headers: { 'content-type': response.headers.get('content-type') || 'application/octet-stream' } })
    }
    globalThis.__ycBackgroundHandler = handle
    session.fromPartition('persist:frost').protocol.handle('https', handle)
  }, local)
  await command({ type: 'open-url', url: 'https://youcloud.inkerror67.workers.dev/#/search/проверка' })
  await waitFor(async () => {
    try { guest = await page.locator('webview.wv.on').evaluate((el) => el.getWebContentsId()); return await inSite('!!document.querySelector(".result-group.track-list .row")') } catch { return false }
  }, 'поиск на реальном YouCloud', 25_000)
  await waitFor(async () => await page.locator('.yc-host-glass.on > div').count() > 0, 'области стекла')
  assert.equal(await inSite('document.querySelectorAll(".backdrop").length'), 0, 'прозрачный режим без фигур сайта')
  assert.equal(await inSite('getComputedStyle(document.documentElement).backgroundColor'), 'rgba(0, 0, 0, 0)')
  assert.equal(await page.locator('main.card').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', 'под страницей нет общей вуали')
  await page.waitForTimeout(1000)
  await alignment()
  await shot('transparent')
  await page.evaluate(() => {
    const wall = document.querySelector('.wall')
    window.__ycWall = wall.innerHTML
    wall.replaceChildren()
    wall.style.background = 'repeating-linear-gradient(90deg, #000 0px 5px, #fff 5px 10px)'
  })
  const box = await alignment()
  const png = await shot('blur-proof')
  const x = box.viewport.x + box.wanted.x + box.wanted.w - 120
  const y = box.viewport.y + box.wanted.y + 50
  assert.ok(contrast(png, box.viewport.x + 3, box.viewport.y + 350) > 180, 'фон вне карточки остаётся резким и прозрачным')
  assert.ok(contrast(png, x, y) < 25, 'карточка действительно размывает полосатые обои')
  console.log('OK: прозрачный фон и настоящее размытие обоев под поисковыми треками (проверка пикселей)')
  await page.evaluate(() => { const wall = document.querySelector('.wall'); wall.innerHTML = window.__ycWall; wall.style.background = '' })

  await inSite('document.querySelector(".scroller").scrollTo(0,100)')
  await page.waitForTimeout(850)
  await alignment()
  await command({ type: 'zoom', delta: 1, wcId: guest })
  await page.waitForTimeout(1000)
  await alignment()
  await command({ type: 'zoom', delta: -1, wcId: guest })
  await page.waitForTimeout(800)
  console.log('OK: совмещение карточек и размытия после прокрутки и изменения масштаба')

  await mode('Оригинальный')
  await waitFor(async () => await inSite('document.querySelectorAll(".backdrop .shape").length') === 12, 'фигуры оригинального фона')
  assert.equal(await page.locator('.yc-host-glass.on').count(), 0, 'в оригинальном режиме браузер не размывает фон сайта')
  assert.equal(await inSite('document.documentElement.dataset.host'), 'masaki', 'мост сохранён')
  assert.equal(await inSite('document.documentElement.dataset.masakiBackground'), 'original')
  await shot('original')
  // Проверяем и обычный CSS-blur сайта внутри маски прокрутки, на собственном фоне страницы.
  await inSite(`(() => {const style=document.createElement('style');style.id='blur-proof';style.textContent='.backdrop{background:repeating-linear-gradient(90deg,#000 0px 5px,#fff 5px 10px)!important}.backdrop .shape,.backdrop .veil{visibility:hidden}';document.head.append(style)})()`)
  const originalRect = await inSite(`(() => {const r=document.querySelector('.result-group.track-list').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width}})()`)
  const originalPng = await shot('original-blur-proof')
  const viewBox = await page.locator('webview.wv.on').boundingBox()
  const pixelContrast = contrast(originalPng, viewBox.x + originalRect.x + originalRect.w - 120, viewBox.y + originalRect.y + 50)
  assert.ok(pixelContrast < 25,
    'оригинальный фон размывается внутри карточек сайта')
  await inSite('document.querySelector("#blur-proof").remove()')
  await app.evaluate(async ({ webContents }, id) => {
    const contents = webContents.fromId(id)
    await new Promise((resolve) => { contents.once('did-finish-load', resolve); contents.reload() })
  }, guest)
  await visibleGuest()
  await waitFor(async () => await inSite('document.querySelectorAll(".backdrop .shape").length').catch(() => 0) === 12 &&
    await inSite('!!document.querySelector(".result-group.track-list")'), 'оригинальный фон после перезагрузки')
  await mode('Прозрачный')
  await waitFor(async () => await inSite('document.querySelectorAll(".backdrop").length') === 0 && await page.locator('.yc-host-glass.on > div').count() > 0, 'прозрачность без перезагрузки')
  await page.evaluate(() => { const wall = document.querySelector('.wall'); wall.innerHTML = window.__ycWall; wall.style.background = '' })
  await inSite('document.querySelector(".scroller").scrollTo(0,0)')
  await shot('transparent-final')
  await inSite(`(() => {const r=document.querySelector('.section-head h2').getBoundingClientRect();window.__contextPoint=[r.x+r.width/2,r.y+r.height/2]})()`)
  await clickGuest(app, guest, ...await inSite('window.__contextPoint'), { button: 'right' })
  await page.getByText('Оригинальный фон YouCloud', { exact: true }).click()
  await waitFor(async () => await inSite('document.querySelectorAll(".backdrop .shape").length') === 12, 'режим из контекстного меню')
  await mode('Прозрачный')
  await page.waitForTimeout(900)
  await alignment()
  console.log('OK: оба режима на лету, фигуры внутри маски прокрутки, сохранение после перезагрузки')

  const normal = await app.evaluate(async ({ BrowserWindow, session }) => {
    const ses = session.fromPartition('yc-background-regular')
    ses.protocol.handle('https', globalThis.__ycBackgroundHandler)
    const window = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, backgroundThrottling: false } })
    await window.loadURL('https://youcloud.inkerror67.workers.dev/#/search/проверка')
    return window.webContents.id
  })
  await waitFor(async () => await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript('document.querySelectorAll(".backdrop .shape").length'), normal) === 12, 'обычный сайт без моста Masaki')
  assert.equal(await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript('document.documentElement.dataset.host ?? null'), normal), null)
  await app.evaluate(({ BrowserWindow, webContents }, id) => BrowserWindow.fromWebContents(webContents.fromId(id)).destroy(), normal)
  console.log('OK: обычный сайт без Masaki сохраняет оригинальное оформление')
  assert.deepEqual(errors, [])
  console.log('YouCloud background: все проверки прошли')
} catch (error) {
  console.error('site state', await inSite(`({dataset:{...document.documentElement.dataset},backdrops:document.querySelectorAll('.backdrop').length,hidden:document.hidden})`).catch(() => null))
  console.error('host state', await page.evaluate(() => ({layers:[...document.querySelectorAll('.yc-host-glass')].map(e=>({class:e.className,count:e.children.length}))})).catch(()=>null))
  console.error(error)
  throw error
} finally {
  await app?.close().catch(() => {})
  await server.close()
  clearTimeout(watchdog)
  fs.rmSync(profile, { recursive: true, force: true })
}
