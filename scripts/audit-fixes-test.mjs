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
assert.ok(['unload', 'history', 'display'].includes(mode), 'Выберите unload, history или display')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-audit-'))
const output = path.join(root, 'test-output')
fs.mkdirSync(output, { recursive: true })

const site = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://localhost').pathname
  const html = (body) => `<!doctype html><meta charset="utf-8"><title>${p.slice(1) || 'домой'}</title><style>body{background:#152221;color:#e2f1e9;font:20px sans-serif;margin:40px}button{font:inherit;padding:8px 16px}</style>${body}`
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
