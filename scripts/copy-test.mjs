// Копирование из меню страницы: выделенный текст, поле ввода, адрес ссылки — и плашка «Скопировано».
// Меню Masaki рисует интерфейс поверх вкладки и забирает у неё фокус; команды правки (копировать,
// вставить…) Chromium выполняет в сфокусированном фрейме, поэтому раньше «Копировать» ничего не делало.
// Запуск: npx electron-vite build && node scripts/copy-test.mjs
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { clickGuest } from './electron-input.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'test-output')
fs.mkdirSync(out, { recursive: true })
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-copy-'))

const app = await electron.launch({
  args: [root],
  cwd: root,
  env: { ...process.env, MASAKI_TEST_HEADLESS: process.env.MASAKI_TEST_HEADLESS ?? '1', MASAKI_TEST_INACTIVE: '1', MASAKI_PROFILE: profile },
  colorScheme: null,
  timeout: 60000
})
const page = await app.firstWindow()
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

async function shot(name) {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(b64, 'base64'))
  console.log('снимок', name)
}
const command = (c) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('command', c), c)
const guestId = () => page.evaluate(() => document.querySelector('webview.wv.on')?.getWebContentsId())
const inTab = async (code) => app.evaluate(({ webContents }, [id, code]) => webContents.fromId(id).executeJavaScript(code), [await guestId(), code])
const clip = () => app.evaluate(({ clipboard }) => clipboard.readText())
const setClip = (t) => app.evaluate(({ clipboard }, t) => clipboard.writeText(t), t)
const fileUrl = (f) => 'file:///' + f.split(path.sep).join('/').replace(/^\/+/, '')

async function menuPick(x, y, label) {
  await clickGuest(app, await guestId(), x, y, { button: 'right' })
  await page.waitForSelector('.cmenu.shown', { timeout: 8000 })
  await page.waitForTimeout(250)
  await page.click(`.cmenu .cm-item:has-text("${label}")`)
}
async function waitClip(expected, what) {
  for (let i = 0; i < 40; i++) {
    if ((await clip()) === expected) return
    await page.waitForTimeout(100)
  }
  throw new Error(`${what}: в буфере ${JSON.stringify(await clip())}, ждали ${JSON.stringify(expected)}`)
}
async function waitToast(text) {
  let t = ''
  for (let i = 0; i < 40; i++) {
    t = (await page.locator('.copy-toast').first().innerText({ timeout: 100 }).catch(() => '')) || ''
    if (t.includes(text)) return
    await page.waitForTimeout(100)
  }
  throw new Error(`плашка: «${t}», ждали в ней «${text}»`)
}

// Картинка для «Копировать картинку»: PNG 96×64 одним цветом, без файлов и сети.
const IMG = await app.evaluate(({ nativeImage }) => {
  const buf = Buffer.alloc(96 * 64 * 4)
  for (let i = 0; i < buf.length; i += 4) buf.set([200, 120, 40, 255], i) // BGRA
  return nativeImage.createFromBitmap(buf, { width: 96, height: 64 }).toDataURL()
})

/** Ctrl+C прямо в гостя: настоящее нажатие Chromium с командой правки, как у клавиатуры. */
async function ctrlC() {
  await app.evaluate(async ({ webContents }, id) => {
    const d = webContents.fromId(id).debugger
    d.attach('1.3')
    try {
      const base = { key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67, modifiers: 2 }
      await d.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', commands: ['copy'], ...base })
      await d.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    } finally {
      d.detach()
    }
  }, await guestId())
}

let failed = false
try {
  const f = path.join(out, 'copy-test.html')
  fs.writeFileSync(
    f,
    '<meta charset="utf-8"><title>Копирование</title><body style="font:22px sans-serif;padding:40px">' +
      '<p id="p">Матовое стекло и пружины</p>' +
      '<p><a id="a" href="https://example.com/путь">Ссылка на пример</a></p>' +
      '<input id="i" value="текст в поле" style="font:22px sans-serif;width:360px">' +
      '<p><button id="b" style="font:20px sans-serif" onclick="navigator.clipboard.writeText(\'из кнопки сайта\')">Копировать</button></p>' +
      `<p><img id="img" width="96" height="64" src="${IMG}"></p></body>`
  )
  // Команды интерфейс слушает после восстановления сессии — ждём, пока он нарисует вкладки.
  await page.waitForSelector('.tab, .dk-tab', { timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(1500)
  await command({ type: 'open-url', url: fileUrl(f) })
  await page.waitForSelector('webview.wv.on')
  await page.waitForFunction(() => !document.querySelector('.fav.loading'), null, { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(800)

  // 1. Выделенный текст → «Копировать».
  await setClip('—')
  const r = await inTab(`(() => { const p = document.getElementById('p'); const s = getSelection(); s.removeAllRanges();
    const rg = document.createRange(); rg.selectNodeContents(p); s.addRange(rg); const b = p.getBoundingClientRect();
    return { x: b.left + 40, y: b.top + b.height / 2 } })()`)
  await menuPick(r.x, r.y, 'Копировать')
  await waitClip('Матовое стекло и пружины', 'выделенный текст')
  await waitToast('Матовое стекло')
  await page.waitForTimeout(350)
  await shot('copy-01-selection')
  console.log('выделенный текст: ок')

  // 2. Адрес ссылки.
  await setClip('—')
  const a = await inTab(`(() => { getSelection().removeAllRanges(); const b = document.getElementById('a').getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 } })()`)
  await menuPick(a.x, a.y, 'Копировать адрес ссылки')
  await waitClip('https://example.com/%D0%BF%D1%83%D1%82%D1%8C', 'адрес ссылки')
  await waitToast('example.com')
  console.log('адрес ссылки: ок')

  // 3. Поле ввода: выделить всё через меню, копировать, вставить обратно.
  await setClip('—')
  const i = await inTab(`(() => { const i = document.getElementById('i'); i.focus(); i.select(); const b = i.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 } })()`)
  await menuPick(i.x, i.y, 'Копировать')
  await waitClip('текст в поле', 'текст поля')
  // Правый клик ставит курсор туда, где нажали (как в Chrome), — вставка встаёт в это место.
  await setClip('[вставка]')
  await inTab(`document.getElementById('i').setSelectionRange(0, 0)`)
  await menuPick(i.x, i.y, 'Вставить')
  const pasted = (v) => v.includes('[вставка]') && v.replace('[вставка]', '') === 'текст в поле'
  for (let k = 0; k < 30 && !pasted(await inTab(`document.getElementById('i').value`)); k++) await page.waitForTimeout(100)
  const v = await inTab(`document.getElementById('i').value`)
  if (!pasted(v)) throw new Error('вставка в поле из меню не сработала: ' + JSON.stringify(v))
  console.log('поле ввода: копировать и вставить — ок')

  // 4. Кнопка «Копировать» на сайте (navigator.clipboard.writeText) — плашка с тем, что легло в буфер.
  await setClip('—')
  await page.waitForTimeout(3200) // прежняя плашка уходит
  const b = await inTab(`(() => { const b = document.getElementById('b').getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 } })()`)
  await clickGuest(app, await guestId(), b.x, b.y)
  await waitClip('из кнопки сайта', 'кнопка сайта')
  await waitToast('из кнопки сайта')
  console.log('кнопка сайта: ок')

  // 5. Ctrl+C на странице — тоже плашка.
  await setClip('—')
  await inTab(`(() => { document.activeElement?.blur(); const s = getSelection(); s.removeAllRanges(); const r = document.createRange();
    r.selectNodeContents(document.getElementById('a')); s.addRange(r) })()`)
  await ctrlC()
  await waitClip('Ссылка на пример', 'Ctrl+C')
  await waitToast('Ссылка на пример')
  console.log('Ctrl+C: ок')

  // 6. «Копировать картинку» — плашка с уменьшенной картинкой. Действие зовём прямо: у ввода через CDP
  // координаты меню приходят в системе страницы, а у настоящей мыши — окна (их и пересчитывает меню).
  const im = await inTab(`(() => { getSelection().removeAllRanges(); const b = document.getElementById('img').getBoundingClientRect(); return { x: b.left + 30, y: b.top + 30 } })()`)
  await page.evaluate(([id, x, y]) => window.masaki.pageAction(id, { type: 'copy-image', x, y }), [await guestId(), im.x, im.y])
  await page.waitForSelector('.copy-toast .ct-img', { timeout: 5000 })
  await waitToast('Картинка скопирована')
  await page.waitForTimeout(400)
  await shot('copy-02-image')
  console.log('картинка: ок')

  // 7. Меню закрыли без выбора (Esc) — фокус вернулся в поле страницы, печать идёт туда.
  await inTab(`(() => { const i = document.getElementById('i'); i.value = ''; i.focus() })()`)
  await clickGuest(app, await guestId(), i.x, i.y, { button: 'right' })
  await page.waitForSelector('.cmenu.shown')
  // На Linux меню открывается на нажатии, и отпускание, поданное через CDP, порой возвращает фокус странице;
  // в Windows меню открывается после отпускания и фокус остаётся в нём — так и ставим.
  await page.locator('.cmenu .cm-item:not(:disabled)').first().focus()
  await page.keyboard.press('Escape')
  await page.waitForSelector('.cmenu', { state: 'detached', timeout: 3000 })
  await page.waitForTimeout(200)
  await app.evaluate(({ webContents }, id) => webContents.fromId(id).insertText('после меню'), await guestId())
  const after = await inTab(`document.getElementById('i').value`)
  if (after !== 'после меню') throw new Error('после Esc фокус не вернулся в поле страницы: ' + JSON.stringify(after))
  console.log('Esc возвращает фокус странице: ок')

  // 8. Панель свёрнута — плашка над доком, а не под ним. Длинный текст — с числом символов.
  await page.click('.side-top .ib[aria-label^="Свернуть панель"]')
  await page.waitForTimeout(1200)
  await page.evaluate(() => window.masaki.copyText('Длинный текст. '.repeat(20).trim(), 'Скопировано'))
  await waitToast('символ')
  await page.waitForTimeout(450)
  const [toast, dock] = await Promise.all([page.locator('.copy-toast').boundingBox(), page.locator('.capz').first().boundingBox()])
  if (!toast || !dock || toast.y + toast.height > dock.y) throw new Error('плашка залезла на док: ' + JSON.stringify({ toast, dock }))
  await shot('copy-03-collapsed')
  console.log('над доком: ок')
} catch (e) {
  failed = true
  console.error('ОШИБКА:', e.message)
  await shot('copy-99-failure').catch(() => {})
} finally {
  fs.writeFileSync(path.join(out, 'copy-console.log'), logs.join('\n'))
  await app.close().catch(() => {})
  fs.rmSync(profile, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
