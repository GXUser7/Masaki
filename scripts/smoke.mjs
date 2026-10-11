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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'test-output')
fs.mkdirSync(out, { recursive: true })
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-test-'))
const only = process.argv.slice(2)

const app = await electron.launch({
  args: [root],
  cwd: root,
  env: { ...process.env, MASAKI_TEST_INACTIVE: '1', MASAKI_PROFILE: profile },
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
async function inTab(code) {
  const id = await page.evaluate(() => document.querySelector('webview.wv.on')?.getWebContentsId())
  return app.evaluate(({ webContents }, [id, code]) => webContents.fromId(id).executeJavaScript(code), [id, code])
}
const fileUrl = (f) => 'file:///' + f.split(path.sep).join('/')

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
    const xbutton = (n) => {
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
    xbutton(2)
    let t = await titleNow()
    if (t !== 'Вторая') throw new Error('кнопка мыши «вперёд» (WM_XBUTTON) не сработала: ' + t)
    xbutton(1)
    t = await titleNow()
    if (t !== 'Первая') throw new Error('кнопка мыши «назад» (WM_XBUTTON) не сработала: ' + t)

    // Страница, которой боковая кнопка нужна самой (preventDefault), её и получает — как в Chrome.
    await inTab(`window.addEventListener('mouseup', (e) => e.button === 3 && e.preventDefault(), { once: true }); 1`)
    xbutton(2)
    if ((await titleNow()) !== 'Вторая') throw new Error('«вперёд» перед проверкой preventDefault не сработал')
    await inTab(`window.addEventListener('mouseup', (e) => e.button === 3 && e.preventDefault(), { once: true }); 1`)
    xbutton(1)
    t = await titleNow()
    if (t !== 'Вторая') throw new Error('страница отменила кнопку «назад», а Masaki всё равно ушёл назад: ' + t)
    xbutton(1)
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
  if (slowSrv) (await slowSrv).srv.close()
  await app.close().catch(() => {})
  fs.rmSync(profile, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
