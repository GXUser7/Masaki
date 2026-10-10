// Тест аддонов и функций Chrome в меню: прозрачные сайты, видео, QR, блокировщик, расширение.
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = process.cwd()
const out = path.join(root, 'test-output')
const fixtures = path.join(root, 'scripts', 'fixtures')
const fileUrl = (name) => 'file:///' + path.join(fixtures, name).split(path.sep).join('/')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-addons-'))
// Тестовое расширение подключаем через настройки профиля — окно выбора папки автотест не откроет.
fs.writeFileSync(
  path.join(profile, 'settings.json'),
  JSON.stringify({ addons: { extensions: [path.join(fixtures, 'ext-banner')] } })
)

const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, MASAKI_TEST_INACTIVE: '1', MASAKI_PROFILE: profile }, timeout: 60000 })
const page = await app.firstWindow()
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
const shot = async (name) => {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(b64, 'base64'))
  console.log('снимок', name)
}
/** Аддоны — командой палитры (Ctrl+Shift+A теперь поиск по вкладкам, как в Chrome). */
async function openAddons() {
  await page.keyboard.press('Control+KeyK')
  await page.waitForSelector('.cmd')
  await page.keyboard.type('>аддоны')
  await page.waitForTimeout(300)
  await page.keyboard.press('Enter')
}
const open = (url) =>
  app.evaluate(({ BrowserWindow }, u) => BrowserWindow.getAllWindows()[0].webContents.send('command', { type: 'open-url', url: u }), url)

let failed = false
try {
  await page.waitForSelector('.ntp', { timeout: 30000 })
  await page.waitForTimeout(1200)

  console.log('шаг страница аддонов')
  await openAddons()
  await page.waitForSelector('.addons-page')
  await page.click('.addon:has-text("Прозрачные сайты") .switch')
  await page.waitForTimeout(600)
  await shot('20-addons')

  console.log('шаг светлая страница')
  await open(fileUrl('light.html'))
  await page.waitForTimeout(2500)
  await shot('21-glass-light')

  console.log('шаг тёмная страница')
  await open(fileUrl('dark.html'))
  await page.waitForTimeout(2500)
  await shot('22-glass-dark')

  console.log('шаг сайт-приложение')
  await open(fileUrl('app-like.html'))
  await page.waitForTimeout(2500)
  await shot('22b-glass-app')
  const glass = await app.evaluate(async ({ webContents }) => {
    const g = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL().includes('app-like.html'))
    return g?.executeJavaScript(`(() => {
      const st = (s) => getComputedStyle(document.querySelector(s))
      return {
        html: st('html').backgroundColor,
        app: st('#app').backgroundColor,
        head: st('#head').backgroundColor,
        side: st('#side').backgroundColor,
        card: st('.card').backgroundColor,
        player: st('.player').backgroundColor,
        modal: st('#modal').backgroundColor
      }
    })()`)
  })
  console.log('прозрачность:', JSON.stringify(glass))
  const clearBg = 'rgba(0, 0, 0, 0)'
  if (glass?.html !== clearBg || glass.app !== clearBg) throw new Error('Фон сайта не стал прозрачным')
  // «Как у панели» (по умолчанию): тёмный сайт в тёмной теме лежит на стекле панели, и его шапка
  // с меню — полупрозрачные цвета этого стекла (--wall), а не своего цвета сайта.
  const wall = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--wall').trim())
  const wallRgb = [1, 3, 5].map((i) => parseInt(wall.slice(i, i + 2), 16)).join(', ')
  const half = (c, rgb) => typeof c === 'string' && c.startsWith(`rgba(${rgb}, 0.`) && parseFloat(c.split(',')[3]) <= 0.8
  if (!half(glass.head, wallRgb) || !half(glass.side, wallRgb)) throw new Error('Шапка и меню не стали полупрозрачными')
  if (!(await page.$('.card.page.glassy.match'))) throw new Error('Под тёмным сайтом не стекло панели')
  if (glass.card === clearBg || glass.player === clearBg) throw new Error('Прозрачность съела карточку или плеер')
  if (glass.modal === clearBg) throw new Error('Прозрачность съела всплывающее окно')
  // Страница под полупрозрачной шапкой не должна мешать читать её.
  await app.evaluate(async ({ webContents }) => {
    const g = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL().includes('app-like.html'))
    await g?.executeJavaScript('document.getElementById("modal").remove(); scrollTo(0, 120)')
  })
  await page.waitForTimeout(500)
  await shot('22c-glass-scrolled')

  console.log('шаг прозрачность «Своя»')
  await page.click('.tab:has-text("Аддоны")')
  await page.waitForSelector('.addons-page')
  await page.click('.addon:has-text("Прозрачные сайты") .seg button:has-text("Своя")')
  await page.waitForSelector('.addons-page input[aria-label="Прозрачность сайтов"]')
  await page.waitForTimeout(1500)
  const own = await app.evaluate(async ({ webContents }) => {
    const g = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL().includes('app-like.html'))
    return g?.executeJavaScript('getComputedStyle(document.querySelector("#head")).backgroundColor')
  })
  if (!half(own, '15, 15, 15')) throw new Error('В режиме «Своя» шапка не своего цвета сайта: ' + own)
  await page.click('.addon:has-text("Прозрачные сайты") .seg button:has-text("Как у панели")')
  await page.waitForTimeout(800)

  console.log('шаг меню видео')
  await page.click('.tab:has-text("Светлая страница")')
  await page.waitForTimeout(800)
  const box = await page.locator('webview.wv.on').boundingBox()
  await page.mouse.click(box.x + 40 + 200, box.y + 40 + 230, { button: 'right' })
  await page.waitForSelector('.cmenu', { timeout: 8000 })
  await page.waitForTimeout(400)
  await shot('23-video-menu')
  // Кадр видео в буфер обмена
  await page.click('.cm-item:has-text("Скопировать кадр")')
  await page.waitForTimeout(1000)
  const hasImage = await app.evaluate(async ({ clipboard }) => {
    const items = await clipboard.read()
    return items.some((i) => i.types.some((t) => t.startsWith('image/')))
  })
  console.log('кадр в буфере обмена:', hasImage)
  if (!hasImage) throw new Error('Кадр видео не попал в буфер обмена')
  // Картинка в картинке
  await page.mouse.click(box.x + 40 + 200, box.y + 40 + 230, { button: 'right' })
  await page.waitForSelector('.cmenu')
  await page.click('.cm-item:has-text("Картинка в картинке")')
  await page.waitForTimeout(1500)
  const pip = await app.evaluate(async ({ webContents }) => {
    const g = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL().includes('light.html'))
    return g ? g.executeJavaScript('!!document.pictureInPictureElement') : 'нет вкладки'
  })
  console.log('картинка в картинке:', pip)
  if (pip !== true) throw new Error('Картинка в картинке не открылась')
  await app.evaluate(async ({ webContents }) => {
    const g = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL().includes('light.html'))
    await g?.executeJavaScript('document.exitPictureInPicture()', true)
  })

  console.log('шаг QR-код')
  await page.mouse.click(box.x + box.width - 120, box.y + box.height - 80, { button: 'right' })
  await page.waitForSelector('.cmenu')
  await page.click('.cm-item:has-text("QR-код")')
  await page.waitForSelector('.pop.qr img', { timeout: 5000 })
  await page.waitForTimeout(500)
  await shot('24-qr')
  await page.click('.pop-scrim', { position: { x: 700, y: 300 } })

  console.log('шаг блокировщик')
  await openAddons()
  await page.waitForSelector('.addons-page')
  await page.click('.addon:has-text("Блокировщик рекламы") .switch')
  await page.waitForFunction(() => !document.body.innerText.includes('Скачиваю фильтры'), null, { timeout: 60000 })
  await page.waitForTimeout(800)
  await shot('25-adblock')
  const adblockError = await page.$('.addon .err-text')
  if (adblockError) throw new Error('Блокировщик: ' + (await adblockError.innerText()))

  console.log('шаг расширение')
  const exts = await page.$$eval('.addon:has-text("Расширения Chrome") .sc-item b', (els) => els.map((e) => e.textContent))
  console.log('загружены расширения:', exts.join(', ') || 'нет')
  await open('https://example.com/')
  await page.waitForTimeout(4000)
  await shot('26-extension-banner')
} catch (e) {
  failed = true
  console.error('ОШИБКА:', e.message)
  await shot('99-addons-failure').catch(() => {})
} finally {
  fs.writeFileSync(path.join(out, 'addons-console.log'), logs.join('\n'))
  await app.close().catch(() => {})
  fs.rmSync(profile, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
