// Узкие регрессии: закрытие пары вкладок и распознавание несохранённых форм.
// node scripts/tab-regressions-test.mjs split|forms (после сборки)
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv[2]
assert.ok(['split', 'forms'].includes(mode), 'Выберите split или forms')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-tab-regressions-'))
const output = path.join(root, 'test-output')
fs.mkdirSync(output, { recursive: true })
const site = http.createServer((req, res) => {
  const title = new URL(req.url, 'http://localhost').pathname.slice(1)
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title>
    <style>body{background:#152221;color:#e2f1e9;font:20px sans-serif;margin:40px}input,select{display:block;margin:20px}</style>
    <h1>${title}</h1><form id="draft">
      <select id="implicit"><option>Первый</option><option>Второй</option></select>
      <select id="explicit"><option>Первый</option><option selected>Второй</option></select>
      <select id="multiple" multiple><option selected>Первый</option><option>Второй</option></select>
      <input id="range" type="range" min="10" max="30" form="draft" name="reset">
      <input id="color" type="color"><input id="text" value="Исходный текст">
      <input id="check" type="checkbox" checked><textarea id="area">Исходный текст</textarea>
    </form>`)
})
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
const base = `http://localhost:${site.address().port}`
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ sidebarCollapsed: false, sleepAfter: 0, addons: { adblock: { enabled: false } } }))
fs.writeFileSync(path.join(profile, 'session.json'), JSON.stringify({ active: 0, tabs: [
  { url: base + '/left', title: 'left' }, { url: base + '/right', title: 'right' }, { url: base + '/tail', title: 'tail' }
] }))
let app, page, mainId
const errors = []
const watchdog = setTimeout(() => { console.error('Превышен лимит 90 секунд'); app?.process().kill(); process.exit(1) }, 90_000)
async function waitFor(fn, label) {
  const end = Date.now() + 10_000
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  throw new Error('Не дождались: ' + label)
}
async function shot(name) {
  // Скрытое окно получает кадр позже изменения DOM; capturePage должен увидеть уже новый размер.
  await page.waitForTimeout(650)
  const png = await app.evaluate(async ({ BrowserWindow }, id) => (await BrowserWindow.fromId(id).capturePage()).toPNG().toString('base64'), mainId)
  fs.writeFileSync(path.join(output, `tab-regressions-${name}.png`), Buffer.from(png, 'base64'))
}
const tab = (title) => page.locator('.tab-main').filter({ hasText: title }).first()
async function menu(title, label) {
  await tab(title).click({ button: 'right' })
  await page.getByText(label, { exact: true }).click()
}
try {
  const env = { ...process.env, MASAKI_PROFILE: profile, MASAKI_TEST_HEADLESS: '1', MASAKI_TEST_INACTIVE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [root], cwd: root, env, colorScheme: null })
  page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  mainId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id)
  await page.waitForSelector('webview.wv.on')
  await waitFor(() => page.evaluate(() => document.querySelector('webview.wv.on').getURL().endsWith('/left')), 'страница')
  if (mode === 'forms') {
    const wc = await page.evaluate(() => document.querySelector('webview.wv.on').getWebContentsId())
    const guest = (code) => app.evaluate(({ webContents }, [id, code]) => webContents.fromId(id).executeJavaScript(code), [wc, code])
    await waitFor(async () => await guest('document.readyState') === 'complete', 'форма')
    // Убираем вкладку с экрана и проверяем настоящий IPC, который решает, можно ли выгружать webview.
    await tab('tail').click()
    const save = () => page.evaluate((id) => window.masaki.tabMemory.save(id), wc)
    const forget = (key) => page.evaluate((key) => window.masaki.tabMemory.forget(key), key)
    const values = () => guest(`JSON.stringify([...document.querySelectorAll('input, textarea, select')].map(el =>
      [el.id, el.value, el.checked, el instanceof HTMLSelectElement ? [...el.options].map(o => o.selected) : null]))`)
    const key = await save()
    assert.ok(key, 'нетронутые select, range и color не должны блокировать выгрузку')
    await forget(key)
    const changes = {
      implicit: `document.querySelector('#implicit').selectedIndex=1`,
      explicit: `document.querySelector('#explicit').selectedIndex=0`,
      multiple: `document.querySelector('#multiple').options[1].selected=true`,
      range: `document.querySelector('#range').value='25'`,
      color: `document.querySelector('#color').value='#ff0000'`,
      text: `document.querySelector('#text').value='Черновик'`,
      check: `document.querySelector('#check').checked=false`,
      area: `document.querySelector('#area').value='Черновик'`
    }
    for (const [name, change] of Object.entries(changes)) {
      await guest(change)
      const before = await values()
      assert.equal(await save(), null, 'изменённое поле защищено: ' + name)
      assert.equal(await values(), before, 'проверка не меняет исходную форму: ' + name)
      await guest('HTMLFormElement.prototype.reset.call(document.querySelector("form"))')
      const reset = await save()
      assert.ok(reset, 'сброшенная форма снова допускает выгрузку: ' + name)
      await forget(reset)
    }
    await tab('left').click()
    await shot('forms')
    console.log('OK: исходные значения формы допускают выгрузку, все 8 изменений защищены')
  } else {
    await menu('right', 'Открыть рядом с текущей')
    await waitFor(() => page.locator('webview.wv.pane').count().then((n) => n === 2), 'пара вкладок')
    await menu('right', 'Закрыть вкладки ниже')
    assert.equal(await page.locator('webview.wv.pane').count(), 2, 'удаление третьей вкладки сохраняет пару')
    await menu('left', 'Закрыть вкладки ниже')
    await shot('close-below')
    assert.equal(await page.locator('.split-div').count(), 0, 'после удаления второй половины разделитель убран')
    assert.equal(await page.locator('webview.wv.pane').count(), 0, 'оставшаяся вкладка занимает всю страницу')
    await app.evaluate(({ BrowserWindow }, [id, url]) => BrowserWindow.fromId(id).webContents.send('command', { type: 'open-url', url }), [mainId, base + '/other'])
    await waitFor(() => tab('other').count(), 'новая вкладка')
    await menu('left', 'Открыть рядом с текущей')
    await waitFor(() => page.locator('webview.wv.pane').count().then((n) => n === 2), 'вторая пара')
    await menu('other', 'Закрыть другие вкладки')
    await shot('close-others')
    assert.equal(await page.locator('.split-div').count(), 0, 'закрытие остальных сбрасывает разделение')
    assert.equal(await page.locator('webview.wv.pane').count(), 0)
    assert.equal(await page.locator('.tab-main').count(), 1)
    console.log('OK: обе команды массового закрытия возвращают целую страницу')
  }
  assert.deepEqual(errors, [], 'ошибки интерфейса')
} finally {
  await app?.close().catch(() => {})
  clearTimeout(watchdog)
  site.closeAllConnections()
  await new Promise((resolve) => site.close(resolve))
  fs.rmSync(profile, { recursive: true, force: true })
}
