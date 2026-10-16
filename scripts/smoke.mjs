// Смоук-тест: запускает собранный Masaki в отдельном профиле, проходит основные сценарии
// и сохраняет снимки окна в test-output/. Запуск: npm run build && node scripts/smoke.mjs
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { clickGuest, guestMouse } from './electron-input.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'test-output')
fs.mkdirSync(out, { recursive: true })
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-test-'))
const only = process.argv.slice(2)

const app = await electron.launch({
  args: [root],
  cwd: root,
  env: { ...process.env, MASAKI_TEST_HEADLESS: process.env.MASAKI_TEST_HEADLESS ?? '1', MASAKI_TEST_INACTIVE: '1', MASAKI_PROFILE: profile },
  // Playwright по умолчанию подменяет prefers-color-scheme на светлую — тогда SVG-значки с медиазапросом
  // в тесте рисовались бы не так, как у пользователя. Тему решает сам Masaki (nativeTheme.themeSource).
  colorScheme: null,
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
const activeGuestId = () => page.evaluate(() => document.querySelector('webview.wv.on')?.getWebContentsId())
async function inTab(code) {
  const id = await activeGuestId()
  return app.evaluate(({ webContents }, [id, code]) => webContents.fromId(id).executeJavaScript(code), [id, code])
}
const fileUrl = (f) => 'file:///' + f.split(path.sep).join('/')

async function assertHidden() {
  if (process.env.MASAKI_TEST_HEADLESS === '0') return
  const windows = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), focused: w.isFocused() }))
  )
  if (windows.some((w) => w.visible || w.focused)) throw new Error('Тестовое окно появилось на экране: ' + JSON.stringify(windows))
}

async function waitLoaded(ms = 20000) {
  await page.waitForFunction(() => !document.querySelector('.fav.loading'), null, { timeout: ms }).catch(() => {})
  await page.waitForTimeout(800)
}

// ---- Заливка адресной капсулы при загрузке ----
// Своя маленькая страница на 127.0.0.1 (до Google и прочих сайтов не ходим): сама лёгкая, а картинка
// в ней отвечает с задержкой — пока её ждём, вкладка в состоянии loading и заливка едет.
let slowSrv = null
function slowServer() {
  if (slowSrv) return slowSrv
  slowSrv = new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1')
      if (u.pathname === '/slow.gif') {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' })
          res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'))
        }, Number(u.searchParams.get('ms')) || 4000)
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(
        '<meta charset="utf-8"><title>Медленная страница</title>' +
          '<body style="font:20px sans-serif;padding:40px;height:3000px;background:linear-gradient(#fff,#dfe)">' +
          `Страница ждёт картинку<br><img src="/slow.gif?ms=${u.searchParams.get('ms') || 4000}&n=${Date.now()}" width="40" height="40">`
      )
    })
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }))
  })
  return slowSrv
}
// Состояние заливки: фаза, прозрачность слоя и какая доля капсулы закрашена (по transform «пилюли»).
const fillState = (sel) =>
  page.evaluate((sel) => {
    const f = document.querySelector(sel)
    if (!f) return null
    const i = f.firstElementChild
    const m = new DOMMatrixReadOnly(getComputedStyle(i).transform)
    return { p: f.dataset.p, opacity: Number(getComputedStyle(f).opacity), shown: 1 + m.m41 / i.offsetWidth }
  }, sel)
const waitFill = (sel, phases, ms = 8000) =>
  page.waitForFunction(([sel, phases]) => phases.includes(document.querySelector(sel)?.dataset.p), [sel, phases], { timeout: ms, polling: 40 })
// Снимок части окна (капсулы) крупным планом: целое окно слишком мелкое, чтобы разглядеть заливку.
async function shotRect(name, sel, pad = 14) {
  const b = await page.locator(sel).first().boundingBox()
  const rect = { x: Math.max(0, Math.floor(b.x - pad)), y: Math.max(0, Math.floor(b.y - pad)), width: Math.ceil(b.width + pad * 2), height: Math.ceil(b.height + pad * 2) }
  const b64 = await app.evaluate(async ({ BrowserWindow }, rect) => (await BrowserWindow.getAllWindows()[0].capturePage(rect)).toPNG().toString('base64'), rect)
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(b64, 'base64'))
  console.log('снимок', name)
}

// ---- Значки плиток ----
// Значки для проверки рисуем сами, без файлов и без сети: PNG 32×32 (кольцо на прозрачном) и SVG.
function pngDataUrl(size, pixel) {
  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) Buffer.from(pixel(x, y)).copy(raw, y * stride + 1 + x * 4)
  const chunk = (type, body) => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(body.length)
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), body])))
    return Buffer.concat([head, Buffer.from(type), body, tail])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // 8 бит на канал
  ihdr[9] = 6 // RGBA
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
  return 'data:image/png;base64,' + png.toString('base64')
}
const ringPng = (rgb) =>
  pngDataUrl(32, (x, y) => {
    const d = Math.hypot(x - 15.5, y - 15.5)
    return d <= 14 && d >= 7 ? [...rgb, 255] : [0, 0, 0, 0]
  })
// Тёмный знак днём и белый в тёмной теме: как у сайтов, которые рисуют значок по prefers-color-scheme.
const THEMED_SVG =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>circle{fill:none;stroke:#202124;stroke-width:6}' +
      '@media (prefers-color-scheme:dark){circle{stroke:#fff}}</style><circle cx="16" cy="16" r="11"/></svg>'
  )

const steps = {
  async ntp() {
    await page.waitForSelector('.ntp', { timeout: 30000 })
    await page.waitForTimeout(1500)
    await shot('01-newtab')
  },
  async tileDrag() {
    // Перестановка перетаскиванием: на новой вкладке и в избранном панели. Плитки, которые сдвинулись,
    // забирают свою форму с собой; ярлыки «в цвете темы» — тональный цвет палитры.
    const cur = await page.evaluate(() => window.masaki.settings.get())
    const toUi = (s) => app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('settings-changed', s), s)
    const four = ['Альфа', 'Бета', 'Гамма', 'Дельта'].map((title, i) => ({ title, url: `https://tile-${i}.test/` }))
    await toUi({ ...cur, scThemed: true, shortcuts: four, favorites: four })
    await page.waitForTimeout(600)
    const fills = await page.evaluate(() => [...document.querySelectorAll('.shortcuts .tile')].map((t) => t.style.getPropertyValue('--td')))
    if (fills.length !== 4 || fills.some((f) => f !== 'var(--sc)')) throw new Error('ярлыки в цвете темы окрашены не так: ' + JSON.stringify(fills))
    const saved = () => page.evaluate(() => window.masaki.settings.get())
    const drag = async (from, to, name) => {
      const a = await page.locator(from).boundingBox()
      const b = await page.locator(to).boundingBox()
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
      await page.mouse.down()
      await page.mouse.move(a.x + a.width / 2 + 8, a.y + a.height / 2, { steps: 2 })
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 })
      // От быстрых шагов Playwright до страницы доходят не все dragover (настоящая мышь шлёт их всё время,
      // пока тянут): в конечной точке подаём его сами — видно, как соседи расступились до отпускания.
      await page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y)
        el?.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: new DataTransfer() }))
      }, [b.x + b.width / 2, b.y + b.height / 2])
      await page.waitForTimeout(600)
      if (name) {
        // Узлы стоят на месте — смотрим, где плитки на экране.
        const mid = await page.evaluate(() =>
          [...document.querySelectorAll('.shortcuts .sc[data-rk]')]
            .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
            .map((e) => e.querySelector('.sc-l').textContent)
            .join()
        )
        if (mid !== 'Бета,Гамма,Альфа,Дельта') throw new Error('пока тянут, соседи не расступились: ' + mid)
        await shot(name)
      }
      await page.mouse.up()
      await page.waitForTimeout(500)
    }
    await drag('.shortcuts .sc >> nth=0', '.shortcuts .sc >> nth=2', '01a-shortcut-drag')
    let s = await saved()
    if (s.shortcuts.map((x) => x.title).join() !== 'Бета,Гамма,Альфа,Дельта') throw new Error('ярлык переставился не так: ' + s.shortcuts.map((x) => x.title))
    if (s.shortcuts.map((x) => x.shape ?? '-').join() !== 'clover4,sunny8,cookie9,-') throw new Error('сдвинутые ярлыки не сохранили форму: ' + s.shortcuts.map((x) => x.shape))
    const shown = await page.evaluate(() => [...document.querySelectorAll('.shortcuts .sc[data-rk] .sc-l')].map((e) => e.textContent).join())
    if (shown !== 'Бета,Гамма,Альфа,Дельта') throw new Error('на новой вкладке порядок не тот: ' + shown)
    await drag('.fvt >> nth=3', '.fvt >> nth=0')
    s = await saved()
    if (s.favorites.map((x) => x.title).join() !== 'Дельта,Альфа,Бета,Гамма') throw new Error('избранное переставилось не так: ' + s.favorites.map((x) => x.title))
    await shot('01b-tiles-reordered')
    await page.evaluate((s) => window.masaki.settings.set(s), cur)
    await toUi(cur)
    await page.waitForTimeout(300)
  },
  async hoverFx() {
    // Эффекты наведения: кнопка-значок морфит и подрастает, AI Mode светится ореолом,
    // ярлык приподнимается, кнопка окна тянется за курсором (магнит).
    const css = (sel, prop) => page.evaluate(([sel, prop]) => getComputedStyle(document.querySelector(sel))[prop], [sel, prop])
    await page.hover('.side-bottom .ib[aria-label="История"]')
    await page.waitForTimeout(450)
    if ((await css('.side-bottom .ib[aria-label="История"]', 'transform')) === 'none') throw new Error('кнопка-значок не пружинит при наведении')
    await shotRect('01c-hover-ib', '.side-bottom', 10)
    await page.hover('.ntp .chip.halo')
    await page.waitForTimeout(300)
    if ((await css('.ntp .chip.halo', 'boxShadow')) === 'none') throw new Error('у AI Mode нет ореола при наведении')
    await shotRect('01d-hover-halo', '.ntp .search', 30)
    await page.hover('.shortcuts .sc >> nth=0')
    await page.waitForTimeout(550)
    if ((await css('.shortcuts .sc', 'translate')) === 'none') throw new Error('ярлык не приподнимается при наведении')
    // Магнит: курсор у правого края кнопки — кнопка сдвигается к нему. Проверяем сразу: настоящий курсор
    // Windows в тесте не над кнопкой, и сверка с ним вскоре вернёт её на место.
    const b = await page.locator('.side-top .ib.wb >> nth=0').boundingBox()
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
    await page.mouse.move(b.x + b.width - 2, b.y + b.height / 2, { steps: 2 })
    await page.waitForTimeout(60)
    const pulled = await page.evaluate(() => document.querySelector('.side-top .ib.wb').style.translate)
    if (!pulled || !/^[1-9]/.test(pulled)) throw new Error('кнопка окна не тянется за курсором: ' + JSON.stringify(pulled))
    await page.mouse.move(700, 420)
    await page.waitForTimeout(300)
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
  async pageDialogs() {
    // alert / confirm / prompt — окном Masaki, а не системным окном Windows; код страницы ждёт ответа.
    const f = path.join(out, 'dialog-test.html')
    fs.writeFileSync(f, '<meta charset="utf-8"><title>Окна страницы</title><body style="font:20px sans-serif;padding:40px">Окна страницы</body>')
    await command({ type: 'open-url', url: fileUrl(f) })
    await waitLoaded()
    // inTab ответит, только когда окно закроют: страница стоит на confirm/prompt/alert.
    let pending = inTab(`confirm('Удалить запись?\\nЭто действие нельзя отменить.')`)
    await page.waitForSelector('.pd-card', { timeout: 8000 })
    await page.waitForTimeout(500)
    await shot('03a2-page-confirm')
    if (!(await page.locator('.pd-title').innerText()).includes('спрашивает')) throw new Error('у confirm не тот заголовок')
    await page.click('.pd-card .perm-btn.tonal-b')
    if ((await pending) !== false) throw new Error('confirm: «Отмена» должна вернуть false')

    pending = inTab(`prompt('Как назвать вкладку?', 'Masaki')`)
    await page.waitForSelector('.pd-input')
    if ((await page.inputValue('.pd-input')) !== 'Masaki') throw new Error('prompt: нет значения по умолчанию')
    await page.fill('.pd-input', 'Новое имя')
    await page.keyboard.press('Enter')
    if ((await pending) !== 'Новое имя') throw new Error('prompt: Enter должен вернуть введённое')

    // Третье окно страницы — можно запретить остальные; Esc у alert — просто «ОК».
    pending = inTab(`alert('Сохранено'); 'после alert'`)
    await page.waitForSelector('.pd-mute')
    await page.check('.pd-mute input')
    await page.keyboard.press('Escape')
    if ((await pending) !== 'после alert') throw new Error('alert: код страницы не продолжился после окна')
    // Запрещено до следующего перехода: confirm сразу false, окна нет.
    if ((await inTab(`confirm('Ещё раз?')`)) !== false) throw new Error('после запрета confirm должен сразу вернуть false')
    if (await page.$('.pd-card')) throw new Error('после запрета окно страницы всё равно показалось')
    await command({ type: 'close-tab' })
    await page.waitForTimeout(400)
  },
  async pageMenu() {
    await page.waitForTimeout(800)
    const box = await page.locator('webview.wv.on').boundingBox()
    await clickGuest(app, await activeGuestId(), box.width / 2, 120, { button: 'right' })
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
  async saveFromTab() {
    // Меню вкладки: страница — в избранное или ярлыком на новую вкладку, повторный выбор убирает.
    // Избранного больше восьми, как после переноса из Chrome: добавление не должно выкидывать старое.
    const cur = await page.evaluate(() => window.masaki.settings.get())
    const toUi = (s) => app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('settings-changed', s), s)
    const url = await inTab('location.href')
    await toUi({ ...cur, favorites: Array.from({ length: 10 }, (_, i) => ({ title: 'Закладка ' + i, url: `https://bookmark-${i}.test/` })) })
    await page.waitForTimeout(300)
    const saved = () => page.evaluate(() => window.masaki.settings.get())
    const pick = async (label) => {
      await page.click('.tab.on', { button: 'right' })
      await page.click(`.cmenu .cm-item:has-text("${label}")`)
      await page.waitForTimeout(400)
    }
    await pick('Добавить в избранное')
    let s = await saved()
    if (s.favorites.length !== 11 || s.favorites[10].url !== url) throw new Error('страница добавилась в избранное не так: ' + s.favorites.length)
    await page.click('.tab.on', { button: 'right' })
    await page.waitForSelector('.cmenu .cm-item:has-text("Убрать из избранного")')
    await page.waitForTimeout(300)
    await shot('03c2-tab-menu-saved')
    await page.click('.cm-scrim', { position: { x: 4, y: 400 } })
    await pick('Убрать из избранного')
    s = await saved()
    if (s.favorites.length !== 10 || s.favorites.some((f) => f.url === url)) throw new Error('страница не убралась из избранного')
    await pick('Добавить на новую вкладку')
    if (!(await saved()).shortcuts.some((f) => f.url === url)) throw new Error('страница не добавилась на новую вкладку')
    await pick('Убрать с новой вкладки')
    if ((await saved()).shortcuts.some((f) => f.url === url)) throw new Error('ярлык не убрался с новой вкладки')
    // Как было — и главному процессу, и интерфейсу.
    await page.evaluate((c) => window.masaki.settings.set(c), cur)
    await toUi(cur)
    await page.waitForTimeout(300)
  },
  async tileMenu() {
    await page.click('.fvt >> nth=0', { button: 'right' })
    await page.waitForSelector('.cm-shapes')
    await page.click('.cm-shape[aria-label="Сердце"]')
    await page.waitForTimeout(1000)
    await shot('03d-tile-menu-heart')
    await page.click('.cm-scrim', { position: { x: 4, y: 400 } })
  },
  async tileColor() {
    // Цвет плитки: ряд кружков под формами. Меню не закрывается — плитка перекрашивается на глазах,
    // выбор доходит до настроек главного процесса, «Авто» убирает поле color (цвет снова из значка).
    const tileFill = () => page.evaluate(() => getComputedStyle(document.querySelector('.fvt .tile-shape')).fill)
    const savedColor = async () => {
      await page.waitForTimeout(200)
      return page.evaluate(async () => (await window.masaki.settings.get()).favorites[0].color ?? null)
    }
    const auto = await tileFill()
    await page.click('.fvt >> nth=0', { button: 'right' })
    await page.waitForSelector('.cm-colors')
    await page.click('.cm-color[aria-label="Цвет: Красный"]')
    await page.waitForTimeout(1000)
    const red = await tileFill()
    const savedRed = await savedColor()
    if (!/^#[0-9a-f]{6}$/i.test(savedRed ?? '')) throw new Error('цвет плитки не дошёл до настроек: ' + savedRed)
    if (red === auto) throw new Error('заливка плитки не изменилась после выбора цвета: ' + red)
    if (!(await page.$('.cm-color.on[aria-label="Цвет: Красный"]'))) throw new Error('выбранный цвет не отмечен в ряду')
    if (!(await page.$('.cmenu'))) throw new Error('меню закрылось после выбора цвета')
    await shot('03d2-tile-color')
    // «Свой…»: <input type="color"> — выбор применяется сразу, без закрытия окна. Значение ставим родным
    // сеттером, иначе React не заметит подмену и не вызовет onChange.
    await page.locator('.cm-color.own input').evaluate((el, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, '#336699')
    await page.waitForTimeout(1000)
    if ((await savedColor()) !== '#336699') throw new Error('свой цвет не сохранился')
    if ((await tileFill()) === red) throw new Error('заливка не изменилась после своего цвета')
    if (!(await page.$('.cm-color.own.on'))) throw new Error('свой цвет не отмечен в ряду')
    await shot('03d2b-tile-color-own')
    await page.click('.cm-color.auto')
    await page.waitForTimeout(800)
    if ((await savedColor()) !== null) throw new Error('«Авто» должно убрать поле color')
    if (!(await page.$('.cm-color.auto.on'))) throw new Error('«Авто» не отмечено в ряду')
    await page.click('.cm-scrim', { position: { x: 4, y: 400 } })
  },
  async lightIcons() {
    // Светлые значки на прозрачном (белый глиф, SVG по prefers-color-scheme) не должны пропадать на белой
    // подложке: у плитки тёмная подложка (--plate). Обычные цветные значки остаются на белой, битый — буква.
    const learn = (host, icon) => app.evaluate(({ ipcMain }, [host, icon]) => ipcMain.emit('favicon:learn', {}, `https://${host}/`, icon), [host, icon])
    await learn('white-icon.test', ringPng([255, 255, 255]))
    await learn('themed-icon.test', THEMED_SVG)
    await learn('blue-icon.test', ringPng([26, 115, 232]))
    await learn('broken-icon.test', 'data:image/png;base64,AAAA')
    const cur = await page.evaluate(() => window.masaki.settings.get())
    const extra = [
      { title: 'Белый значок', url: 'https://white-icon.test/' },
      { title: 'Значок по теме', url: 'https://themed-icon.test/' },
      { title: 'Синий значок', url: 'https://blue-icon.test/' },
      { title: 'Битый значок', url: 'https://broken-icon.test/' }
    ]
    // Только интерфейсу, как правка с Диска: главный процесс настроек не меняет, вернём их ниже.
    const showFavs = (favorites) =>
      app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('settings-changed', s), { ...cur, favorites })
    await showFavs([...cur.favorites, ...extra])
    const plateOf = (title) =>
      page.evaluate((title) => {
        const tile = [...document.querySelectorAll('.fvt')].find((b) => b.title === title)
        if (!tile) return null
        const ic = tile.querySelector('.site-ic')
        if (!ic) return { letter: !!tile.querySelector('.tile-letter') }
        const m = getComputedStyle(ic).backgroundColor.match(/[\d.]+/g).map(Number)
        return { lum: (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255 }
      }, title)
    // Значки грузятся и разбираются не мгновенно, а подложка ещё и плавно перекрашивается.
    const waitPlate = async (title, ok, what) => {
      let got = null
      for (let i = 0; i < 24; i++) {
        got = await plateOf(title)
        if (got && ok(got)) return
        await page.waitForTimeout(250)
      }
      throw new Error(`«${title}»: ${what}, а получилось ${JSON.stringify(got)}`)
    }
    const dark = (g) => g.lum !== undefined && g.lum < 0.3
    const white = (g) => g.lum !== undefined && g.lum > 0.97
    const wasDark = await page.evaluate(() => !!document.querySelector('.app.dark'))
    if (!wasDark) throw new Error('тест значков рассчитан на тёмную тему')
    await waitPlate('Белый значок', dark, 'у белого PNG подложка должна быть тёмной')
    await waitPlate('Значок по теме', dark, 'у SVG с белым знаком в тёмной теме подложка должна быть тёмной')
    await waitPlate('Синий значок', white, 'у цветного значка подложка должна остаться белой')
    await waitPlate('Битый значок', (g) => g.letter === true, 'вместо битой картинки должна быть буква')
    await page.waitForTimeout(500)
    await shot('03d3-light-icon')
    // Смена темы на лету: SVG с prefers-color-scheme днём тёмный — подложка снова белая, и обратно.
    const setTheme = async (command) => {
      await page.keyboard.press('Control+KeyK')
      await page.waitForSelector('.cmd')
      await page.keyboard.type('>' + command)
      await page.waitForTimeout(300)
      await page.keyboard.press('Enter')
      await page.waitForTimeout(500)
    }
    await setTheme('светлая тема')
    await waitPlate('Значок по теме', white, 'после смены темы на светлую подложка SVG должна вернуться к белой')
    await waitPlate('Белый значок', dark, 'белый PNG и днём должен быть на тёмной подложке')
    await shot('03d3b-light-icon-light-theme')
    await setTheme('тёмная тема')
    await waitPlate('Значок по теме', dark, 'после возврата тёмной темы подложка SVG должна снова стать тёмной')
    await showFavs(cur.favorites)
    await page.waitForTimeout(300)
  },
  async favTiles() {
    // Избранное открывается новой вкладкой, а пустую новую вкладку просто занимает. Сайты — свои файлы:
    // в избранном по умолчанию Google, его из автотеста открывать нельзя.
    const cur = await page.evaluate(() => window.masaki.settings.get())
    const toUi = (s) => app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('settings-changed', s), s)
    const white = path.join(out, 'fav-white.html')
    const blue = path.join(out, 'fav-blue.html')
    fs.writeFileSync(white, `<meta charset="utf-8"><title>Белый значок</title><link rel="icon" href="${ringPng([255, 255, 255])}"><body style="font:20px sans-serif;padding:40px">Белый значок</body>`)
    fs.writeFileSync(blue, `<meta charset="utf-8"><title>Синий значок</title><link rel="icon" href="${ringPng([26, 115, 232])}"><body style="font:20px sans-serif;padding:40px">Синий значок</body>`)
    await toUi({ ...cur, favorites: [{ title: 'Белый значок', url: fileUrl(white) }, { title: 'Синий значок', url: fileUrl(blue) }] })
    await page.waitForTimeout(400)
    const tabs = () => page.evaluate(() => document.querySelectorAll('.side .tab').length)
    const before = await tabs()
    // В строке вкладки ещё буква значка — берём последнюю строку, само название.
    const wasTitle = (await page.locator('.side .tab.on').innerText()).trim().split('\n').pop().trim()
    const was = await inTab('location.href')
    await page.click('.fvt >> nth=0')
    await waitLoaded()
    if ((await tabs()) !== before + 1) throw new Error('избранное открылось не в новой вкладке')
    if ((await inTab('location.href')) !== fileUrl(white)) throw new Error('новая вкладка открыла не ту страницу')
    // Пустая новая вкладка — занимается, лишняя не появляется.
    await command({ type: 'new-tab' })
    await page.waitForTimeout(500)
    const withNtp = await tabs()
    await page.click('.fvt >> nth=1')
    await waitLoaded()
    if ((await tabs()) !== withNtp) throw new Error('избранное с пустой новой вкладки открыло ещё одну')
    // Светлый значок на прозрачном — на тёмном кружке, обычный — на белом.
    await page.waitForSelector('.side .tab.on .fav.img:not(.dk)', { timeout: 5000 })
    await page.waitForSelector('.side .tab:has-text("Белый значок") .fav.img.dk', { timeout: 5000 })
    // Плитки в цвете темы: заливка — тональный цвет палитры у всех плиток, кроме выбранного вручную.
    await toUi({ ...cur, favThemed: true, favorites: [...cur.favorites.slice(0, 3), { ...cur.favorites[3], color: '#E91E63' }] })
    await page.waitForTimeout(700)
    const fills = await page.evaluate(() => [...document.querySelectorAll('.fvt .tile')].map((t) => t.style.getPropertyValue('--td')))
    if (fills.slice(0, 3).some((f) => f !== 'var(--sc)') || fills[3] === 'var(--sc)') throw new Error('плитки в цвете темы окрашены не так: ' + JSON.stringify(fills))
    await shot('03d4-fav-themed')
    for (const title of ['Белый значок', 'Синий значок']) {
      await page.click(`.side .tab:has-text("${title}")`)
      await command({ type: 'close-tab' })
      await page.waitForTimeout(300)
    }
    await page.click(`.side .tab:has-text("${wasTitle}")`)
    await page.waitForTimeout(300)
    if ((await inTab('location.href')) !== was) throw new Error('не вернулась прежняя вкладка')
    await toUi(cur)
    await page.waitForTimeout(300)
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
  async swipeOwned() {
    // Как Google Таблицы: сетка листает себя сама — забирает колесо (preventDefault) или двигает свою
    // полосу прокрутки рядом с сеткой. Такой жест — страницы, назад уходить нельзя. И прокрутка вниз,
    // ушедшая вбок, тоже не «назад». В истории вкладки при этом есть куда вернуться.
    const sheet = path.join(out, 'swipe-sheet.html')
    const tall = path.join(out, 'swipe-tall.html')
    fs.writeFileSync(sheet, `<meta charset="utf-8"><title>Таблица</title>
<style>body{margin:0;font:16px sans-serif}#go{position:fixed;top:8px;left:8px;z-index:1;padding:12px 20px;background:#dfe}
#grid{position:absolute;top:60px;left:0;right:0;bottom:16px;overflow:hidden}
#cells{width:4000px;height:100%;background:repeating-linear-gradient(90deg,#fff 0 99px,#bbb 99px 100px)}
#bar{position:absolute;left:0;right:0;bottom:0;height:16px;overflow-x:scroll}#bar div{width:4000px;height:1px}</style>
<a id="go"></a><div id="grid"><div id="cells"></div></div><div id="bar"><div></div></div>
<script>
  const mode = location.search.slice(1)
  document.title = 'Таблица ' + mode
  go.href = mode === 'prevent' ? 'swipe-sheet.html?bar' : 'swipe-tall.html'
  go.textContent = 'Дальше'
  let x = mode === 'bar' ? 500 : 0
  window.wheels = 0
  addEventListener('load', () => { bar.scrollLeft = x; cells.style.transform = 'translateX(' + -x + 'px)' })
  grid.addEventListener('wheel', (e) => {
    window.wheels++
    if (mode === 'prevent') e.preventDefault()
    x = Math.max(0, Math.min(3000, x + e.deltaX))
    cells.style.transform = 'translateX(' + -x + 'px)'
    if (mode === 'bar') bar.scrollLeft = x
  }, { passive: false })
</script>`)
    fs.writeFileSync(tall, '<meta charset="utf-8"><title>Длинная</title><body style="font:20px sans-serif;padding:40px;height:5000px">Длинная страница</body>')
    const start = path.join(out, 'swipe-start.html')
    fs.writeFileSync(start, '<meta charset="utf-8"><title>Начало</title><body style="font:20px sans-serif;padding:40px"><a id="n" href="swipe-sheet.html?prevent" style="display:inline-block;padding:20px;background:#dfe">Дальше</a></body>')
    await command({ type: 'open-url', url: fileUrl(start) })
    await waitLoaded()
    const box = await page.locator('webview.wv.on').boundingBox()
    // Настоящий клик: переход без действия пользователя Chromium не пускает в историю «назад».
    const follow = async (selector, title) => {
      const r = await inTab(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + 10, y: r.top + 10 } })()`)
      await clickGuest(app, await activeGuestId(), r.x, r.y)
      for (let i = 0; i < 40 && (await inTab('document.title').catch(() => '')) !== title; i++) await page.waitForTimeout(100)
      if ((await inTab('document.title')) !== title) throw new Error('не открылась страница ' + title)
      await page.waitForTimeout(400)
    }
    // Весь жест — одной пачкой: пауза между событиями дольше 140 мс разорвала бы его на два.
    const wheel = async (events) => {
      await guestMouse(app, await activeGuestId(), events.map(([dx, dy]) => ({ type: 'mouseWheel', x: box.width / 2, y: box.height / 2, deltaX: dx, deltaY: dy })))
      await page.waitForTimeout(1200)
    }
    const back10 = Array(10).fill([-30, 0])
    const where = () => inTab('location.pathname.split("/").pop() + location.search')

    await follow('#n', 'Таблица prevent')
    await wheel(back10)
    if ((await inTab('window.wheels')) < 10) throw new Error('колесо не дошло до сетки')
    if ((await where()) !== 'swipe-sheet.html?prevent') throw new Error('страница забрала колесо, а Masaki ушёл назад: ' + (await where()))
    if (await page.$('.swipe')) throw new Error('стрелка жеста осталась на экране')

    await follow('#go', 'Таблица bar')
    await wheel(back10)
    const left = await inTab('bar.scrollLeft')
    if (left >= 500) throw new Error('сетка не листалась вбок: ' + left)
    if ((await where()) !== 'swipe-sheet.html?bar') throw new Error('сетка листалась своей полосой, а Masaki ушёл назад: ' + (await where()))

    await follow('#go', 'Длинная')
    await wheel([[0, 20], [0, 20], [0, 20], ...back10])
    if ((await where()) !== 'swipe-tall.html') throw new Error('прокрутка вниз, ушедшая вбок, сработала как «назад»')
    // Обычный свайп на той же странице по-прежнему возвращает назад.
    await wheel(back10)
    if ((await where()) !== 'swipe-sheet.html?bar') throw new Error('свайп «назад» перестал работать: ' + (await where()))
    // Фокус после кликов — во вкладке, Ctrl+W туда не дойдёт: закрываем командой.
    await command({ type: 'close-tab' })
    await page.waitForTimeout(400)
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
    await clickGuest(app, await activeGuestId(), link.x, link.y)
    await page.waitForTimeout(1500)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    // Жест — серия событий без паузы дольше 140 мс, поэтому каждая часть уходит одной пачкой: отдельные
    // подключения отладчика на событие под нагрузкой рвали жест на короткие куски (тест мигал).
    const wheel = async (n) =>
      guestMouse(app, await activeGuestId(), Array.from({ length: n }, () => ({ type: 'mouseWheel', x: box.width / 2, y: box.height / 2, deltaX: -30, deltaY: 0 })))
    // Недотянутый жест: стрелка видна, а назад не уходит.
    await wheel(4)
    await page.waitForSelector('.swipe', { timeout: 3000 })
    await shot('03l-swipe')
    await page.waitForTimeout(600)
    if ((await inTab('document.title')) !== 'Вторая') throw new Error('недотянутый жест всё равно увёл назад')
    // Дотянутый — уходит назад.
    await wheel(8)
    await page.waitForTimeout(1500)
    const title = await inTab('document.title')
    if (title !== 'Первая') throw new Error('жест «назад» не сработал: ' + title)
  },
  async mouseNav() {
    // Боковые кнопки мыши. Сначала настоящий путь Windows: WM_XBUTTONDOWN/UP прямо в окно Masaki
    // (PostMessage, а не SendInput — тот двигал бы настоящую мышь пользователя). Chromium отдаёт их
    // странице как mouseup с button 3/4, дальше guest.ts → главный процесс → «назад»/«вперёд».
    // После шага swipe вкладка на «Первой», «Вторая» — впереди.
    const box = await page.locator('webview.wv.on').boundingBox()
    const dpr = await page.evaluate(() => devicePixelRatio)
    const hwnd = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE(0).toString())
    const x = Math.round((box.x + box.width / 2) * dpr)
    const y = Math.round((box.y + box.height / 2) * dpr)
    const xbutton = async (n) => {
      if (process.env.MASAKI_TEST_HEADLESS !== '0') {
        await clickGuest(app, await activeGuestId(), box.width / 2, box.height / 2, { button: n === 1 ? 'back' : 'forward' })
        return
      }
      const down = (n << 16) | (n === 1 ? 0x20 : 0x40)
      const up = n << 16
      execFileSync('powershell', [
        '-NoProfile',
        '-Command',
        `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);';` +
          `$h=[IntPtr]::new([Int64]${hwnd}); $l=[IntPtr]::new(${(y << 16) | x});` +
          `[W.U]::PostMessage($h,0x0200,[IntPtr]::Zero,$l)|Out-Null; Start-Sleep -Milliseconds 50;` +
          `[W.U]::PostMessage($h,0x020B,[IntPtr]::new(${down}),$l)|Out-Null; Start-Sleep -Milliseconds 50;` +
          `[W.U]::PostMessage($h,0x020C,[IntPtr]::new(${up}),$l)|Out-Null`
      ])
    }
    const titleNow = async () => {
      await page.waitForTimeout(1500)
      return inTab('document.title')
    }
    await xbutton(2)
    let t = await titleNow()
    if (t !== 'Вторая') throw new Error('кнопка мыши «вперёд» (WM_XBUTTON) не сработала: ' + t)
    await xbutton(1)
    t = await titleNow()
    if (t !== 'Первая') throw new Error('кнопка мыши «назад» (WM_XBUTTON) не сработала: ' + t)

    // Страница, которой боковая кнопка нужна самой (preventDefault), её и получает — как в Chrome.
    await inTab(`window.addEventListener('mouseup', (e) => e.button === 3 && e.preventDefault(), { once: true }); 1`)
    await xbutton(2)
    if ((await titleNow()) !== 'Вторая') throw new Error('«вперёд» перед проверкой preventDefault не сработал')
    await inTab(`window.addEventListener('mouseup', (e) => e.button === 3 && e.preventDefault(), { once: true }); 1`)
    await xbutton(1)
    t = await titleNow()
    if (t !== 'Вторая') throw new Error('страница отменила кнопку «назад», а Masaki всё равно ушёл назад: ' + t)
    await xbutton(1)
    if ((await titleNow()) !== 'Первая') throw new Error('после отменённого нажатия «назад» перестал работать')

    // Ctrl+колесо над страницей меняет масштаб вкладки (Electron сам не меняет, только шлёт zoom-changed).
    // Синтетическое колесо (CDP) Chromium запросом масштаба не считает — у него нет «щелчков» колёсика,
    // поэтому подаём то самое событие, которое Electron шлёт на настоящее Ctrl+колесо.
    const id = await page.evaluate(() => document.querySelector('webview.wv.on')?.getWebContentsId())
    const zoomNow = () => app.evaluate(({ webContents }, id) => webContents.fromId(id).getZoomLevel(), id)
    const z0 = await zoomNow()
    await app.evaluate(({ webContents }, id) => webContents.fromId(id).emit('zoom-changed', {}, 'in'), id)
    await page.waitForTimeout(700)
    const z1 = await zoomNow()
    if (!(z1 > z0)) throw new Error(`Ctrl+колесо не увеличило масштаб: ${z0} → ${z1}`)
    await shot('03l2-ctrl-wheel-zoom')
    await command({ type: 'zoom', delta: 0 })
    await page.waitForTimeout(300)
    if ((await zoomNow()) !== 0) throw new Error('масштаб не сбросился')

    // Ctrl+D — звёздочка, как в Chrome (запасной путь через интерфейс: фокус в окне Masaki).
    await page.evaluate(() => document.activeElement?.blur?.())
    const url = await inTab('location.href')
    const favHas = () => page.evaluate(async (u) => (await window.masaki.settings.get()).favorites.some((f) => f.url === u), url)
    await page.keyboard.press('Control+KeyD')
    await page.waitForTimeout(600)
    if (!(await favHas())) throw new Error('Ctrl+D не добавил страницу в избранное')
    await page.keyboard.press('Control+KeyD')
    await page.waitForTimeout(600)
    if (await favHas()) throw new Error('второй Ctrl+D не убрал страницу из избранного')
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
  async loadFill() {
    // Загрузка заливает адресную капсулу (волны по кромке страницы больше нет). Страница ждёт
    // медленную картинку — ловим заливку посреди пути, потом смену вкладки и конец загрузки.
    const { port } = await slowServer()
    const side = '.side .abar-fill'
    if (await page.$('.pprog')) throw new Error('волна по кромке страницы должна быть убрана')
    await command({ type: 'open-url', url: `http://127.0.0.1:${port}/?ms=6000` })
    await waitFill(side, ['crawl'], 5000)
    await page.waitForTimeout(1200)
    const mid = await fillState(side)
    console.log('заливка в пути:', JSON.stringify(mid))
    if (!mid || mid.opacity < 0.99 || mid.shown < 0.2 || mid.shown > 0.9) throw new Error('заливка капсулы посреди загрузки: ' + JSON.stringify(mid))
    await shot('03n-load-fill')
    await shotRect('03n-load-fill-bar', '.side .abar')
    // Переключились на чужую вкладку — её капсула чистая, а загрузка той вкладки до неё не «доезжает».
    await page.click('.tab:not(.on) >> nth=0')
    await page.waitForTimeout(300)
    const other = await fillState(side)
    if (!other || other.p !== 'idle' || other.opacity !== 0) throw new Error('чужая вкладка получила заливку: ' + JSON.stringify(other))
    await page.waitForFunction(() => !document.querySelector('.fav.loading'), null, { timeout: 15000 })
    await page.waitForTimeout(800)
    const after = await fillState(side)
    if (!after || after.p !== 'idle' || after.opacity !== 0) throw new Error('заливка «доехала» чужую загрузку: ' + JSON.stringify(after))
    // Загрузка активной вкладки заканчивается: заливка доезжает до края, гаснет и сбрасывается.
    await command({ type: 'open-url', url: `http://127.0.0.1:${port}/?ms=2500` })
    await waitFill(side, ['crawl'], 5000)
    await waitFill(side, ['finish', 'fade'], 8000)
    await waitFill(side, ['idle'], 4000)
    const done = await fillState(side)
    if (!done || done.opacity !== 0) throw new Error('после загрузки заливка не погасла: ' + JSON.stringify(done))
    // Дальше шаги ждут пустую новую вкладку, как после «player».
    await page.keyboard.press('Control+KeyT')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
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
    // Док: вкладки слева от капсулы видны сразу, без наведения.
    await page.waitForSelector('.dk-tabs .dk-t.on')
    await shot('04b-capsule-tabs')
    await page.click('.dk-add')
    await page.waitForTimeout(1200)
    await shot('05-newtab-collapsed')
    await page.keyboard.type('youtu')
    await page.waitForSelector('.cmd')
    await page.waitForTimeout(900)
    await shot('05b-typed-on-newtab')
    await page.keyboard.press('Escape')
  },
  async dockMany() {
    // Много вкладок: в доке — сколько влезает (активная всегда видна) и «+N» со списком всех вкладок.
    const before = await page.locator('.dk-t').count()
    const extra = 16
    for (let i = 1; i <= extra; i++) {
      const html = `<meta charset="utf-8"><title>Вкладка ${i}</title><body style="font:20px sans-serif;padding:40px">Вкладка ${i}</body>`
      await command({ type: 'open-url', url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) })
    }
    await page.waitForTimeout(2500)
    const shown = await page.locator('.dk-t').count()
    const more = await page.locator('.dk-more').textContent().catch(() => null)
    console.log('док: видно вкладок', shown, 'было', before, 'кнопка', more)
    if (!more || !/^\+\d+$/.test(more.trim())) throw new Error('при множестве вкладок в доке нет кнопки «+N»')
    if (!(await page.$('.dk-t.on'))) throw new Error('активная вкладка не видна в доке')
    const box = await page.locator('.dk-tabs').boundingBox()
    const cap = await page.locator('.capz > .capsule').boundingBox()
    if (box.x + box.width > cap.x) throw new Error('остров вкладок налез на капсулу')
    await shot('04c-dock-many')
    await page.click('.dk-more')
    await page.waitForSelector('.pop.tabs .dkl-row')
    const rows = await page.locator('.pop.tabs .dkl-row').count()
    if (rows < before + extra) throw new Error('в списке вкладок не все вкладки: ' + rows)
    await page.waitForTimeout(400)
    await shot('04d-dock-list')
    await page.keyboard.type('Вкладка 3')
    await page.waitForTimeout(300)
    const found = await page.locator('.pop.tabs .dkl-row').count()
    if (found < 1 || found > 2) throw new Error('поиск по списку вкладок: ' + found)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(600)
    if (await page.$('.pop.tabs')) throw new Error('список вкладок не закрылся после выбора')
    const title = await page.locator('.dk-t.on .dk-main').getAttribute('title')
    if (!title?.startsWith('Вкладка 3')) throw new Error('из списка открылась не та вкладка: ' + title)
    // Убираем добавленные вкладки: дальше шаги рассчитаны на обычное их число.
    for (let i = 1; i <= extra; i++) {
      const t = await page.locator('.dk-t').filter({ has: page.locator('[title^="Вкладка "]') }).first()
      await t.click({ button: 'middle' })
      await page.waitForTimeout(80)
    }
    await page.waitForTimeout(600)
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
  async loadFillCapsule() {
    // То же в свёрнутом виде: заливка в капсуле дока и в капсуле, сжатой до домена.
    const { port } = await slowServer()
    const cap = '.capsule .abar-fill'
    await command({ type: 'open-url', url: `http://127.0.0.1:${port}/?ms=6000` })
    await waitFill(cap, ['crawl'], 5000)
    await page.waitForTimeout(1200)
    const mid = await fillState(cap)
    console.log('заливка в капсуле:', JSON.stringify(mid))
    if (!mid || mid.opacity < 0.99 || mid.shown < 0.2 || mid.shown > 0.9) throw new Error('заливка в капсуле дока: ' + JSON.stringify(mid))
    await shotRect('03n-load-fill-capsule', '.capsule')
    // Листаем вниз, пока страница ещё грузится, — капсула сжимается до домена, заливка остаётся.
    await page.mouse.move(700, 300)
    await inTab('window.scrollTo(0, 900)')
    await page.waitForTimeout(900)
    if (!(await page.$('.capz.small'))) console.log('предупреждение: капсула не сжалась, снимок сделан в обычном виде')
    await shotRect('03n-load-fill-small', '.capsule')
    await waitFill(cap, ['idle'], 12000)
    const done = await fillState(cap)
    if (!done || done.opacity !== 0) throw new Error('после загрузки заливка в капсуле не погасла: ' + JSON.stringify(done))
    await inTab('window.scrollTo(0, 0)')
    await page.waitForTimeout(500)
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
  async dockBounce() {
    // У низа длинной страницы худеющий док делал страницу выше, браузер сдвигал прокрутку вверх — и док
    // раздувался обратно. Каждая «докрутка» до низа давала пару «сжался — вырос». Теперь — одно сжатие.
    const f = path.join(out, 'dock-bounce.html')
    fs.writeFileSync(f, '<meta charset="utf-8"><title>Низ страницы</title><body style="margin:0;font:20px sans-serif"><div style="height:2400px;padding:40px;box-sizing:border-box;background:linear-gradient(#fff,#fde)">Листайте до конца</div></body>')
    await command({ type: 'open-url', url: fileUrl(f) })
    await waitLoaded()
    await page.evaluate(() => {
      const capz = document.querySelector('.capz')
      let small = capz.classList.contains('small')
      window.__dockFlips = []
      new MutationObserver(() => {
        if (capz.classList.contains('small') === small) return
        small = !small
        window.__dockFlips.push({ small, at: Math.round(performance.now()), morph: capz.classList.contains('morph') })
      }).observe(capz, { attributes: true, attributeFilter: ['class'] })
    })
    const flips = () => page.evaluate(() => window.__dockFlips)
    if ((await page.$('.capz.small')) !== null) throw new Error('док уже маленький до прокрутки')

    for (let i = 0; i < 4; i++) {
      await inTab('window.scrollTo(0, 1e6)')
      if (i === 0) {
        await page.waitForTimeout(160)
        await shot('07d-dock-morph')
      }
      await page.waitForTimeout(450)
    }
    // Настоящее колесо у самого низа тоже не раскачивает док.
    for (let i = 0; i < 5; i++) {
      await guestMouse(app, await activeGuestId(), [{ type: 'mouseWheel', x: 300, y: 300, deltaX: 0, deltaY: 200 }])
      await page.waitForTimeout(60)
    }
    await page.waitForTimeout(900)
    let f1 = await flips()
    if (f1.length !== 1 || !f1[0].small) throw new Error('док качается у низа страницы: ' + JSON.stringify(f1))
    if (!f1[0].morph) throw new Error('док сменил размер без перетекания')
    if (await page.$('.capz.morph')) throw new Error('класс перетекания не снялся')
    const hidden = await page.evaluate(() => [...document.querySelectorAll('.capz .capsule > .ib, .capz .cap-w')].map((el) => {
      const cs = getComputedStyle(el)
      return { vis: cs.visibility, w: el.getBoundingClientRect().width }
    }))
    if (!hidden.length || hidden.some((h) => h.vis !== 'hidden' || h.w > 0.5)) throw new Error('спрятанные кнопки дока остались доступны: ' + JSON.stringify(hidden))
    // Раскрыть маленький док можно со всей полосы внизу, а не только с пилюль; на страницу полоса не заходит.
    const strip = await page.evaluate(() => {
      const r = document.querySelector('.capz.small').getBoundingClientRect()
      return { pe: getComputedStyle(document.querySelector('.capz.small')).pointerEvents, top: r.top, width: r.width, win: innerWidth, card: document.querySelector('.card.page').getBoundingClientRect().bottom }
    })
    if (strip.pe !== 'auto' || strip.width < strip.win * 0.9 || strip.top < strip.card - 0.5) throw new Error('полоса наведения дока не та: ' + JSON.stringify(strip))
    await shot('07e-dock-small-bottom')

    await inTab('window.scrollTo(0, 0)')
    await page.waitForTimeout(900)
    f1 = await flips()
    if (f1.length !== 2 || f1[1].small) throw new Error('док не вырос при прокрутке вверх: ' + JSON.stringify(f1))

    // Быстрые качели сигналов «вниз — вверх» схлопываются: одно сжатие сразу, последнее решение — после паузы.
    await page.evaluate(() => {
      const w = document.querySelector('webview.wv.on')
      for (const dir of ['down', 'up', 'down', 'up', 'down', 'up']) w.dispatchEvent(Object.assign(new Event('ipc-message'), { channel: 'scroll', args: [dir] }))
    })
    await page.waitForTimeout(1200)
    const f2 = (await flips()).slice(2)
    if (f2.length !== 2 || !f2[0].small || f2[1].small) throw new Error('качели сигналов не схлопнулись: ' + JSON.stringify(f2))
    if (f2[1].at - f2[0].at < 400) throw new Error('док сменил размер раньше паузы: ' + (f2[1].at - f2[0].at) + ' мс')
    await command({ type: 'close-tab' })
    await page.waitForTimeout(500)
  },
  async dockDrag() {
    // Вкладку дока тянут мышью: вверх из дока и отпустить — закрылась; вернуть — осталась;
    // вдоль острова — переставилась. Обычный щелчок по-прежнему просто переключает вкладку.
    // Тянем только свои две вкладки, чтобы порядок остальных не менялся для следующих шагов.
    const wasActive = await page.evaluate(() => document.querySelector('.dk-t.on')?.dataset.id)
    for (const name of ['Тянуть 1', 'Тянуть 2']) {
      await command({ type: 'open-url', url: 'data:text/html;charset=utf-8,' + encodeURIComponent(`<meta charset="utf-8"><title>${name}</title><body>${name}</body>`) })
      await page.waitForTimeout(400)
    }
    await page.waitForTimeout(800)
    const idOf = (title) =>
      page.evaluate((t) => [...document.querySelectorAll('.dk-t')].find((e) => e.querySelector('.dk-main')?.getAttribute('aria-label') === t)?.dataset.id, title)
    const ids = () => page.evaluate(() => [...document.querySelectorAll('.dk-t')].map((e) => e.dataset.id))
    // Вкладок может быть больше, чем влезает в док: остальные — в «+N».
    const total = () => page.evaluate(() => document.querySelectorAll('.dk-t').length + Number(document.querySelector('.dk-more')?.textContent.replace('+', '') || 0))
    const center = async (sel) => {
      const b = await page.locator(sel).boundingBox()
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    }
    const pull = async (sel, to, shotName) => {
      const a = await center(sel)
      await page.mouse.move(a.x, a.y)
      await page.mouse.down()
      await page.mouse.move(a.x + 3, a.y - 3)
      await page.mouse.move(to.x, to.y, { steps: 10 })
      await page.waitForTimeout(450)
      if (shotName) await shot(shotName)
      return a
    }
    const victim = await idOf('Тянуть 1')
    const keep = await idOf('Тянуть 2')
    if (!victim || !keep) throw new Error('свои вкладки не видны в доке')
    // 1. Вверх из дока — «отпустите — закроется», отпустили — вкладки нет.
    const count = await total()
    const a = await pull(`.dk-t[data-id="${victim}"]`, { x: (await center(`.dk-t[data-id="${victim}"]`)).x + 40, y: 180 }, '04e-dock-drag-out')
    if (!(await page.$('.dk-ghost.out'))) throw new Error('над страницей значок не показал «отпустите — закроется»')
    await page.mouse.up()
    await page.waitForTimeout(600)
    if ((await ids()).includes(victim) || (await total()) !== count - 1) throw new Error('утащенная из дока вкладка не закрылась')
    if (await page.$('.dk-ghost')) throw new Error('призрак вкладки остался после закрытия')
    // 2. Утащили и вернули на место — вкладка осталась, порядок тот же.
    let before = await ids()
    const back = await pull(`.dk-t[data-id="${keep}"]`, { x: a.x, y: 200 })
    await page.mouse.move(back.x, back.y, { steps: 8 })
    await page.waitForTimeout(250)
    await page.mouse.up()
    await page.waitForTimeout(600)
    let after = await ids()
    if (after.join() !== before.join()) throw new Error('вкладка, которую вернули в док, пропала или переехала: ' + JSON.stringify({ before, after }))
    // 3. Вдоль острова перед первой видимой вкладкой — переставилась туда.
    before = await ids()
    const first = await center(`.dk-t[data-id="${before[0]}"]`)
    await pull(`.dk-t[data-id="${keep}"]`, { x: first.x - 16, y: first.y }, '04f-dock-drag-reorder')
    if (!(await page.$('.dk-tabs.dropping .dk-t.gap-before'))) throw new Error('над доком не раскрылся зазор для вкладки')
    await page.mouse.up()
    await page.waitForTimeout(600)
    after = await ids()
    if (after[0] !== keep) throw new Error('вкладка не переставилась: ' + JSON.stringify({ before, after }))
    // 4. Щелчок без жеста переключает вкладку.
    const other = after.find((id) => id !== keep)
    await page.click(`.dk-t[data-id="${other}"] .dk-main`)
    await page.waitForTimeout(300)
    if (!(await page.$(`.dk-t.on[data-id="${other}"]`))) throw new Error('щелчок по вкладке дока перестал её выбирать')
    // Убираем свою вкладку и возвращаем прежнюю активную.
    await page.click(`.dk-t[data-id="${keep}"] .dk-main`, { button: 'middle' })
    await page.waitForTimeout(400)
    if (wasActive && (await page.$(`.dk-t[data-id="${wasActive}"]`))) await page.click(`.dk-t[data-id="${wasActive}"] .dk-main`)
    await page.waitForTimeout(300)
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
    // Ярлыки и избранное: переключатели «в цвете темы» и ручки перетаскивания в списках.
    await page.evaluate(() => [...document.querySelectorAll('.settings h2')].find((h) => h.textContent === 'Ярлыки новой вкладки')?.scrollIntoView({ block: 'start' }))
    await page.waitForTimeout(500)
    if ((await page.locator('.sc-list .sc-item[draggable="true"]').count()) < 2) throw new Error('в списках настроек нет перетаскиваемых строк')
    await shot('08b-settings-tiles')
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
  await assertHidden()
  for (const [name, fn] of Object.entries(steps)) {
    if (only.length && !only.includes(name)) continue
    console.log('шаг', name)
    await fn()
  }
  await assertHidden()
} catch (e) {
  failed = true
  console.error('ОШИБКА:', e.message)
  await shot('99-failure').catch(() => {})
} finally {
  fs.writeFileSync(path.join(out, 'console.log'), logs.join('\n'))
  if (slowSrv) (await slowSrv).srv.close()
  await app.close().catch(() => {})
  fs.rmSync(profile, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
