// Смоук-тест: запускает собранный Masaki в отдельном профиле, проходит основные сценарии
// и сохраняет снимки окна в test-output/. Запуск: npm run build && node scripts/smoke.mjs
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'test-output')
fs.mkdirSync(out, { recursive: true })
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-test-'))
const only = process.argv.slice(2)

const app = await electron.launch({
  args: [root],
  cwd: root,
  env: { ...process.env, MASAKI_TEST_INACTIVE: '1', MASAKI_PROFILE: profile },
  timeout: 60000
})
const page = await app.firstWindow()
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

async function shot(name) {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const img = await w.capturePage()
    return img.toPNG().toString('base64')
  })
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(b64, 'base64'))
  console.log('снимок', name)
}

const command = (c) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('command', c), c)
async function inTab(code) {
  const id = await page.evaluate(() => document.querySelector('webview.wv.on')?.getWebContentsId())
  return app.evaluate(({ webContents }, [id, code]) => webContents.fromId(id).executeJavaScript(code), [id, code])
}
const fileUrl = (f) => 'file:///' + f.split(path.sep).join('/')

async function waitLoaded(ms = 20000) {
  await page.waitForFunction(() => !document.querySelector('.fav.loading'), null, { timeout: ms }).catch(() => {})
  await page.waitForTimeout(800)
}

const steps = {
  async ntp() {
    await page.waitForSelector('.ntp', { timeout: 30000 })
    await page.waitForTimeout(1500)
    await shot('01-newtab')
  },
  async palette() {
    await page.click('.fakebox')
    await page.waitForSelector('.cmd')
    await page.keyboard.type('material 3 expressive', { delay: 20 })
    await page.waitForTimeout(1200)
    await shot('02-palette')
    await page.keyboard.press('Escape')
  },
  async navigate() {
    await page.click('.fakebox')
    await page.keyboard.type('example.com')
    await page.keyboard.press('Enter')
    await page.waitForSelector('webview.wv.on')
    await waitLoaded()
    await shot('03-site')
  },
  async perm() {
    // data: — небезопасный контекст, геолокация там недоступна; берём локальный файл.
    const file = path.join(out, 'perm-test.html')
    fs.writeFileSync(file, '<meta charset="utf-8"><body style="font:16px sans-serif;padding:24px">Страница просит местоположение<script>navigator.geolocation.getCurrentPosition(()=>{},()=>{})</script></body>')
    await app.evaluate(({ BrowserWindow }, url) => {
      BrowserWindow.getAllWindows()[0].webContents.send('command', { type: 'open-url', url })
    }, 'file:///' + file.split(path.sep).join('/'))
    await page.waitForSelector('.perm', { timeout: 10000 })
    await page.waitForTimeout(700)
    await shot('03a-permission')
    await page.click('.perm-btn.ghost')
    await page.waitForTimeout(300)
    await page.keyboard.press('Control+KeyW')
  },
  async pageMenu() {
    await page.waitForTimeout(800)
    const box = await page.locator('webview.wv.on').boundingBox()
    await page.mouse.click(box.x + box.width / 2, box.y + 120, { button: 'right' })
    await page.waitForSelector('.cmenu', { timeout: 8000 })
    await page.waitForTimeout(500)
    await shot('03b-page-menu')
    await page.click('.cm-scrim', { position: { x: 4, y: 400 } })
  },
  async tabMenu() {
    await page.click('.tab.on', { button: 'right' })
    await page.waitForSelector('.cmenu')
    await page.waitForTimeout(400)
    await shot('03c-tab-menu')
    await page.click('.cm-scrim', { position: { x: 4, y: 400 } })
  },
  async tileMenu() {
    await page.click('.fvt >> nth=0', { button: 'right' })
    await page.waitForSelector('.cm-shapes')
    await page.click('.cm-shape[aria-label="Сердце"]')
    await page.waitForTimeout(1000)
    await shot('03d-tile-menu-heart')
    await page.click('.cm-scrim', { position: { x: 4, y: 400 } })
  },
  async winButtons() {
    // Кнопки окна — в шапке панели; задержка на «развернуть» открывает свои раскладки.
    await page.hover('.side-top .wb[aria-label$="окно"] >> nth=1')
    await page.waitForSelector('.snap', { timeout: 4000 })
    await page.waitForTimeout(600)
    await shot('03f-snap-layouts')
    await page.mouse.move(700, 500)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  },
  async groupsAndPreview() {
    // Вторая вкладка и группа из двух вкладок.
    const f = path.join(out, 'group-test.html')
    fs.writeFileSync(f, '<meta charset="utf-8"><title>Рецепт борща</title><body style="font:20px sans-serif;padding:40px;background:#fff8ee">Рецепт борща за 40 минут</body>')
    await command({ type: 'open-url', url: fileUrl(f) })
    await waitLoaded()
    await page.click('.tab.on', { button: 'right' })
    await page.click('.cm-item:has-text("В новую группу")')
    await page.waitForTimeout(400)
    await page.click('.tab:not(.on) >> nth=0', { button: 'right' })
    await page.click('.cm-item:has-text("В группу «Группа 1»")')
    await page.waitForTimeout(600)
    // Наведение на неактивную вкладку — превью со снимком.
    await page.hover('.tab.in-grp:not(.on)')
    await page.waitForSelector('.tprev', { timeout: 4000 })
    await page.waitForTimeout(500)
    await shot('03g-groups-preview')
    await page.mouse.move(700, 500)
  },
  async split() {
    await page.click('.tab.in-grp:not(.on)', { button: 'right' })
    await page.click('.cm-item:has-text("Открыть рядом с текущей")')
    await page.waitForSelector('.split-div', { timeout: 4000 })
    await page.waitForTimeout(1200)
    await shot('03h-split')
    await page.click('.tab.in-split >> nth=0', { button: 'right' })
    await page.click('.cm-item:has-text("Убрать разделение экрана")')
    await page.waitForTimeout(400)
  },
  async commands() {
    await page.keyboard.press('Control+KeyK')
    await page.waitForSelector('.cmd')
    await page.keyboard.type('>')
    await page.waitForTimeout(500)
    await shot('03i-commands')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+Shift+KeyA')
    await page.waitForSelector('.cmd')
    await page.waitForTimeout(500)
    await shot('03j-tab-search')
    await page.keyboard.press('Escape')
  },
  async glance() {
    const f = path.join(out, 'glance-test.html')
    fs.writeFileSync(f, '<meta charset="utf-8"><title>Ссылки</title><body style="font:20px sans-serif;padding:40px"><a id="l" href="https://example.com/">Пример — Alt+клик</a></body>')
    await command({ type: 'open-url', url: fileUrl(f) })
    await waitLoaded()
    await inTab(`document.getElementById('l').dispatchEvent(new MouseEvent('click', { altKey: true, bubbles: true, cancelable: true }))`)
    await page.waitForSelector('.gl-card', { timeout: 5000 })
    await page.waitForTimeout(2500)
    await shot('03k-glance')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    if (await page.$('.gl-card')) await page.click('.gl-card .ib[aria-label^="Закрыть"]')
  },
  async swipe() {
    // Две страницы в истории вкладки — жест тачпадом влево возвращает назад.
    const a = path.join(out, 'swipe-a.html')
    const b = path.join(out, 'swipe-b.html')
    fs.writeFileSync(b, '<meta charset="utf-8"><title>Вторая</title><body style="font:20px sans-serif;padding:40px">Вторая страница</body>')
    fs.writeFileSync(a, '<meta charset="utf-8"><title>Первая</title><body style="font:20px sans-serif;padding:40px"><a id="n" href="swipe-b.html" style="display:inline-block;padding:20px;background:#dfe">Дальше</a></body>')
    await command({ type: 'open-url', url: fileUrl(a) })
    await waitLoaded()
    // Настоящий клик: переход без действия пользователя Chromium не пускает в историю «назад».
    const box = await page.locator('webview.wv.on').boundingBox()
    const link = await inTab(`(() => { const r = document.getElementById('n').getBoundingClientRect(); return { x: r.left + 20, y: r.top + 20 } })()`)
    await page.mouse.click(box.x + link.x, box.y + link.y)
    await page.waitForTimeout(1500)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(-30, 0)
      await page.waitForTimeout(16)
    }
    await page.waitForSelector('.swipe', { timeout: 3000 })
    await shot('03l-swipe')
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(-30, 0)
      await page.waitForTimeout(16)
    }
    await page.waitForTimeout(1500)
    const title = await inTab('document.title')
    if (title !== 'Первая') throw new Error('жест «назад» не сработал: ' + title)
  },
  async player() {
    // Звук в фоновой вкладке — мини-плеер внизу панели.
    const f = path.join(out, 'player-test.html')
    const clip = fileUrl(path.join(root, 'scripts', 'fixtures', 'clip.webm'))
    fs.writeFileSync(f, `<meta charset="utf-8"><title>Плейлист на вечер</title><body style="margin:0;background:#111"><video src="${clip}" autoplay loop style="width:100%"></video></body>`)
    await command({ type: 'open-url', url: fileUrl(f) })
    await waitLoaded()
    await page.waitForTimeout(1200)
    await page.keyboard.press('Control+KeyT')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
    await shot('03m-player')
  },
  async accounts() {
    await page.click('.side-bottom .achip')
    await page.waitForSelector('.pop.accounts')
    await page.waitForTimeout(600)
    await shot('03e-accounts')
    await page.click('.pop-scrim', { position: { x: 700, y: 400 } })
  },
  async collapse() {
    await page.click('.side-top .ib[aria-label^="Свернуть панель"]')
    await page.waitForTimeout(1200)
    await shot('04-collapsed')
  },
  async newtabCollapsed() {
    // Вкладки над капсулой раскрываются и по фокусу (наведение тест проверить не может:
    // интерфейс сверяется с настоящим курсором, а Playwright двигает мышь понарошку).
    await page.focus('.capsule .cap-side')
    await page.waitForTimeout(700)
    await shot('04b-capsule-tabs')
    await page.click('.ct-add')
    await page.waitForTimeout(1200)
    await shot('05-newtab-collapsed')
    await page.keyboard.type('youtu')
    await page.waitForSelector('.cmd')
    await page.waitForTimeout(900)
    await shot('05b-typed-on-newtab')
    await page.keyboard.press('Escape')
  },
  async ai() {
    // Без Enter: частые запросы к Google из тестов приводят к капче «подозрительный трафик».
    await page.click('.ntp .chip')
    await page.waitForSelector('.cmd')
    await page.keyboard.type('что такое material 3 expressive')
    await page.waitForTimeout(600)
    await shot('06-ai-palette')
    await page.click('.scrim', { position: { x: 4, y: 400 } })
    // Повторное нажатие AI Mode после закрытия палитры должно сразу открыть её снова в режиме AI.
    await page.waitForTimeout(400)
    await page.click('.ntp .chip')
    await page.waitForSelector('.cmd-in.ai', { timeout: 3000 })
    await page.click('.scrim', { position: { x: 4, y: 400 } })
    await page.waitForTimeout(400)
    // После закрытия без вопроса обычная палитра открывается без AI Mode.
    await page.click('.fakebox')
    await page.waitForSelector('.cmd')
    if (await page.$('.cmd-in.ai')) throw new Error('AI Mode остался включённым после закрытия палитры')
    await page.click('.scrim', { position: { x: 4, y: 400 } })
    // Страница с полем ввода, прибитым к низу (как у AI Mode): док не должен его закрывать.
    const html = '<body style="margin:0;background:#202124;color:#eee;font:16px sans-serif"><p style="padding:24px">Поле ввода прибито к низу страницы</p><input style="position:fixed;bottom:16px;left:20%;width:60%;height:56px;font-size:18px;border-radius:28px;border:0;padding:0 20px" placeholder="Задайте вопрос"></body>'
    await app.evaluate(({ BrowserWindow }, url) => {
      BrowserWindow.getAllWindows()[0].webContents.send('command', { type: 'open-url', url })
    }, 'data:text/html;charset=utf-8,' + encodeURIComponent(html))
    await page.waitForTimeout(1500)
    await shot('07-bottom-input')
  },
  async dockPalette() {
    await page.click('.capsule .addr')
    await page.waitForSelector('.cmd')
    await page.waitForTimeout(700)
    await shot('07b-dock-palette')
    await page.keyboard.press('Escape')
  },
  async capsuleSmall() {
    // Длинная страница: листаем вниз — капсула сжимается до домена.
    const f = path.join(out, 'long-test.html')
    fs.writeFileSync(f, '<meta charset="utf-8"><title>Длинная статья</title><body style="font:20px sans-serif;padding:40px;height:4000px;background:linear-gradient(#fff,#dfe)">Листайте вниз</body>')
    await command({ type: 'open-url', url: fileUrl(f) })
    await waitLoaded()
    await page.mouse.move(700, 300)
    await inTab('window.scrollTo(0, 900)')
    await page.waitForTimeout(900)
    await shot('07c-capsule-small')
    await inTab('window.scrollTo(0, 0)')
    await page.waitForTimeout(700)
  },
  async small() {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 600))
    await page.keyboard.press('Control+KeyT')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
    await shot('09-small-window')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 860))
  },
  async settings() {
    await page.click('.capsule .cap-side')
    await page.waitForTimeout(900)
    await page.keyboard.press('Control+Comma')
    await page.waitForSelector('.settings')
    await page.waitForTimeout(1200)
    await shot('08-settings')
  },
  async looks() {
    // Готовая палитра по базовому цвету и свой цвет с ползунка
    await page.click('.swatch[title="Закат"]')
    await page.waitForTimeout(600)
    await shot('10a-palette-sunset')
    await page.click('.swatch.own')
    await page.locator('.own-color .hue').fill('200')
    await page.waitForTimeout(600)
    await shot('10b-custom-color')
    await page.click('.seg button:has-text("Обои Windows")')
    await page.click('.swatch.wp')
    await page.click('.clock-card:has-text("Аналоговые")')
    await page.waitForTimeout(2500)
    await shot('11-settings-wallpaper')
    await page.keyboard.press('Control+KeyT')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1500)
    await shot('12-newtab-analog-wallpaper')
  }
}

let failed = false
try {
  for (const [name, fn] of Object.entries(steps)) {
    if (only.length && !only.includes(name)) continue
    console.log('шаг', name)
    await fn()
  }
} catch (e) {
  failed = true
  console.error('ОШИБКА:', e.message)
  await shot('99-failure').catch(() => {})
} finally {
  fs.writeFileSync(path.join(out, 'console.log'), logs.join('\n'))
  await app.close().catch(() => {})
  fs.rmSync(profile, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
