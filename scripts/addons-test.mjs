// Тест аддонов и функций Chrome в меню: прозрачные сайты, видео, QR, блокировщик, расширение.
import { _electron as electron } from 'playwright'
import { clickGuest as clickGuestInput } from './electron-input.mjs'
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
  JSON.stringify({ addons: { extensions: [path.join(fixtures, 'ext-banner'), path.join(fixtures, 'ext-action')] } })
)

const headless = process.env.MASAKI_TEST_HEADLESS !== '0'
const app = await electron.launch({ args: [root], cwd: root, colorScheme: null, env: { ...process.env, MASAKI_TEST_INACTIVE: '1', MASAKI_TEST_HEADLESS: headless ? '1' : '0', MASAKI_PROFILE: profile }, timeout: 60000 })
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

async function clickInGuest(x, y, options) {
  const wcId = await page.evaluate(() => document.querySelector('webview.wv.on').getWebContentsId())
  await clickGuestInput(app, wcId, x, y, options)
}

let failed = false
try {
  await page.waitForSelector('.ntp', { timeout: 30000 })
  await page.waitForTimeout(1200)

  console.log('шаг Canvas обычной страницы без аддона')
  await open(fileUrl('glass-theme.html'))
  await page.waitForFunction(() => {
    const w = document.querySelector('webview.wv.on')
    return w && getComputedStyle(w).backgroundColor === 'rgb(255, 255, 255)'
  })
  await page.waitForTimeout(500)
  await shot('19-page-canvas')
  const normalGuest = await page.evaluate(() => document.querySelector('webview.wv.on').getWebContentsId())
  const normal = await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript(`({
    prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
    rootBg: getComputedStyle(document.documentElement).backgroundColor,
    glass: !!window.__masakiGlass
  })`), normalGuest)
  if (!normal.prefersDark || normal.glass || normal.rootBg !== 'rgba(0, 0, 0, 0)') throw new Error('Подложка изменила CSS или предпочтение темы сайта: ' + JSON.stringify(normal))
  await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript(`
    document.documentElement.style.colorScheme = 'dark'; document.body.style.color = 'CanvasText';
    document.querySelector('header').style.backgroundColor = 'Canvas'; 1
  `), normalGuest)
  await page.waitForFunction(() => {
    const color = getComputedStyle(document.querySelector('webview.wv.on')).backgroundColor
    return color !== 'rgb(255, 255, 255)' && color !== 'rgba(0, 0, 0, 0)'
  })
  await page.waitForTimeout(500)
  await shot('19b-page-dark-canvas')
  await open(fileUrl('glass-theme.html') + '?light')
  await page.waitForFunction(() => getComputedStyle(document.querySelector('webview.wv.on')).backgroundColor === 'rgb(255, 255, 255)')
  await page.click('.tab:not(.on):has-text("Тема прозрачного сайта")', { button: 'right' })
  await page.click('.cm-item:has-text("Открыть рядом с текущей")')
  await page.waitForSelector('.split-div')
  const paneColors = await page.$$eval('webview.wv.pane', (nodes) => nodes.map((n) => getComputedStyle(n).backgroundColor))
  if (paneColors.length !== 2 || !paneColors.includes('rgb(255, 255, 255)') || !paneColors.some((c) => /^rgb\(/.test(c) && c.match(/\d+/g).every((n) => Number(n) < 128))) throw new Error('Половины split потеряли собственные фоны: ' + JSON.stringify(paneColors))
  await page.waitForTimeout(500)
  await shot('19c-page-split-canvas')
  await page.click('.tab.on', { button: 'right' })
  await page.click('.cm-item:has-text("Убрать разделение экрана")')
  await page.locator('.tab.on .x').click()
  await page.waitForFunction(() => [...document.querySelectorAll('.tab')].filter((t) => t.textContent.includes('Тема прозрачного сайта')).length === 1)
  await page.locator('.tab.on .x').click()
  await page.waitForSelector('.ntp')

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

  console.log('шаг светлый Canvas и контрастные секции')
  await open(fileUrl('glass-theme.html'))
  await page.waitForTimeout(2500)
  const inTheme = (code) =>
    app.evaluate(async ({ webContents }, code) => {
      const g = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL().includes('glass-theme.html'))
      return g?.executeJavaScript(code)
    }, code)
  const theme = await inTheme(`({
    prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
    base: window.__masakiGlass.apply(true),
    inverse: getComputedStyle(document.querySelector('.inverse')).backgroundColor,
    text: getComputedStyle(document.body).color
  })`)
  console.log('Canvas сайта:', JSON.stringify(theme))
  if (!theme?.prefersDark || theme.base !== '255,255,255') throw new Error('Светлый сайт с прозрачными html/body получил тёмную подложку: ' + JSON.stringify(theme))
  if (theme.inverse !== 'rgb(18, 19, 23)' || theme.text !== 'rgb(18, 19, 23)') throw new Error('Аддон испортил контрастную секцию или цвет текста: ' + JSON.stringify(theme))
  if (!(await page.$('.card.page.glassy:not(.match)'))) throw new Error('Светлый сайт ошибочно получил тёмное стекло панели')
  await shot('22e-glass-canvas')
  // У сайтов с явным color-scheme:dark системный Canvas уже тёмный. Смена предпочтения
  // браузера не должна заставлять нас считать все прозрачные документы светлыми.
  const darkCanvas = await inTheme(`(() => {
    window.__masakiGlass.remove()
    document.documentElement.style.colorScheme = 'dark'
    return window.__masakiGlass.apply(true)
  })()`)
  if (!darkCanvas || !darkCanvas.split(',').every((x) => Number(x) < 128)) throw new Error('Явный тёмный color-scheme потерял тёмный Canvas: ' + darkCanvas)
  const mixed = await inTheme(`(() => {
    window.__masakiGlass.remove()
    document.documentElement.style.backgroundColor = '#121317'
    document.body.style.color = '#fff'
    const base = window.__masakiGlass.apply(true)
    return { base, light: getComputedStyle(document.querySelector('.light')).backgroundColor }
  })()`)
  if (mixed?.base !== '18,19,23' || mixed.light !== 'rgb(255, 255, 255)') throw new Error('Светлая секция на тёмном сайте потеряла свой фон: ' + JSON.stringify(mixed))

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

  // Затемнения «к фону» (как «Развернуть» под AI-обзором Google): градиент к цвету сайта — тоже
  // эффект фона, а не деталь страницы. Иначе на светлых обоях остаётся тёмная плашка.
  console.log('шаг затемнения «к фону»')
  await open(fileUrl('glass-fade.html'))
  await page.waitForTimeout(2500)
  await shot('22d-glass-fade')
  const inFade = (code) =>
    app.evaluate(async ({ webContents }, code) => {
      const g = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL().includes('glass-fade.html'))
      return g?.executeJavaScript(code)
    }, code)
  const fadeState = `(() => {
    const q = (s) => document.querySelector(s)
    const st = (s, p) => getComputedStyle(q(s), p)
    return {
      fade: [st('.fade').backgroundImage, st('.fade').backgroundColor],
      strip: st('.strip').backgroundColor,
      more: st('.more').backgroundColor,
      after: [st('.clip2', '::after').backgroundImage, st('.clip2', '::after').backgroundColor],
      before: [st('.clip3', '::before').backgroundImage, st('.clip3', '::before').backgroundColor],
      own: st('.own').backgroundColor,
      accent: st('.own', '::before').backgroundImage,
      hero: st('.hero').backgroundImage,
      marks: document.querySelectorAll('[data-masaki-glass-pseudo]').length,
      styles: document.querySelectorAll('style').length
    }
  })()`
  const fade = await inFade(fadeState)
  console.log('затемнения:', JSON.stringify(fade))
  if (!fade) throw new Error('страница glass-fade.html не открылась')
  if (fade.fade[0] !== 'none' || fade.fade[1] !== clearBg) throw new Error('Градиент «к фону» (div) остался непрозрачным: ' + JSON.stringify(fade.fade))
  if (fade.strip !== clearBg) throw new Error('Полоса цвета сайта под градиентом осталась непрозрачной')
  if (fade.after[0] !== 'none' || fade.after[1] !== clearBg) throw new Error('Затемнение в ::after осталось: ' + JSON.stringify(fade.after))
  if (fade.before[0] !== 'none' || fade.before[1] !== clearBg) throw new Error('Сплошная полоса в ::before осталась: ' + JSON.stringify(fade.before))
  if (fade.more === clearBg || fade.own !== 'rgb(53, 80, 107)') throw new Error('Прозрачность съела кнопку или карточку своего цвета')
  if (!fade.accent.includes('gradient') || !fade.hero.includes('gradient')) throw new Error('Прозрачность съела цветной градиент')
  // Помечены ровно два элемента (::after и ::before); акцент карточки пометки не получил.
  if (fade.marks !== 2) throw new Error('Пометок псевдоэлементов должно быть 2, а не ' + fade.marks)
  // Снятие аддона возвращает всё: пометки, правило-<style> и сами градиенты.
  await inFade('window.__masakiGlass.remove()')
  const fadeOff = await inFade(fadeState)
  if (fadeOff.marks !== 0 || fadeOff.styles !== fade.styles - 1) throw new Error('После снятия остались пометки или <style>: ' + JSON.stringify(fadeOff))
  if (!fadeOff.fade[0].includes('gradient') || !fadeOff.after[0].includes('gradient') || fadeOff.before[1] === clearBg) {
    throw new Error('Снятие аддона не вернуло затемнения: ' + JSON.stringify(fadeOff))
  }
  await shot('22d-glass-fade-off')

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
  await clickInGuest(40 + 200, 40 + 230, { button: 'right' })
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
  // Системное PiP-окно не относится к BrowserWindow и не умеет оставаться скрытым.
  if (headless) {
    console.log('пропуск — системное окно «Картинка в картинке» в скрытом режиме')
  } else {
    await clickInGuest(40 + 200, 40 + 230, { button: 'right' })
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
  }

  console.log('шаг QR-код')
  await clickInGuest(box.width - 120, box.height - 80, { button: 'right' })
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

  // Кнопка расширения (chrome.action): «пазл» у адреса, список, закрепление, бейдж, всплывающее окно.
  console.log('шаг кнопка расширения')
  if (!exts.some((n) => n.includes('Masaki test action'))) throw new Error('тестовое расширение с кнопкой не загрузилось: ' + exts.join(', '))
  await page.waitForSelector('.abar-side .a-ext-menu', { timeout: 10000 })
  await page.click('.abar-side .a-ext-menu')
  await page.waitForSelector('.pop.extensions .ext-row')
  const rows = await page.$$eval('.pop.extensions .ext-row-t', (els) => els.map((e) => e.textContent))
  if (!rows.some((t) => t.includes('Masaki test action'))) throw new Error('в списке расширений нет тестового: ' + rows.join(', '))
  await page.waitForTimeout(400)
  await shot('27-ext-menu')
  await page.click('.pop.extensions .ext-row:has-text("Masaki test action") .ext-pin')
  await page.waitForSelector('.abar-side .ext-act')
  await page.click('.pop-scrim', { position: { x: 900, y: 500 } })
  // Бейдж ставит фон расширения (service worker) — ждём, пока дойдёт.
  await page.waitForFunction(() => document.querySelector('.abar-side .ext-act .ext-badge')?.textContent === '3', null, { timeout: 8000 })
  const iconOk = await page.$eval('.abar-side .ext-act img', (img) => img.complete && img.naturalWidth > 0)
  if (!iconOk) throw new Error('значок кнопки расширения не загрузился (crx://)')
  await shot('27b-ext-pinned')

  const popupUrl = () =>
    app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().includes('popup.html'))
      return w ? { url: w.webContents.getURL(), bounds: w.getBounds(), visible: w.isVisible(), ready: !w.webContents.isLoadingMainFrame() } : null
    })
  await page.click('.abar-side .ext-act')
  let pop = null
  for (let i = 0; i < 20 && !(pop?.ready && pop.bounds.width >= 100 && pop.bounds.height >= 100); i++) {
    await page.waitForTimeout(250)
    pop = await popupUrl()
  }
  console.log('окно расширения:', JSON.stringify(pop))
  if (!pop?.ready || pop.bounds.width < 100 || pop.bounds.height < 100) throw new Error('всплывающее окно расширения не загрузилось: ' + JSON.stringify(pop))
  if (headless && pop.visible) throw new Error('Тест показал окно расширения поверх рабочего стола')
  if (!headless && !pop.visible) throw new Error('Видимое окно расширения не показалось')
  const popPng = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('popup.html'))
    return (await w.capturePage()).toPNG().toString('base64')
  })
  fs.writeFileSync(path.join(out, '27c-ext-popup.png'), Buffer.from(popPng, 'base64'))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('popup.html'))?.destroy())

  // Пункт расширения в контекстном меню страницы: щелчок доходит до фона расширения.
  console.log('шаг меню расширения')
  const wvBox = await page.locator('webview.wv.on').boundingBox()
  await clickInGuest(wvBox.width / 2, 200, { button: 'right' })
  await page.waitForSelector('.cmenu.shown .cm-item:has-text("Проверить в Masaki")', { timeout: 5000 })
  await page.waitForTimeout(300)
  await shot('27d-ext-context-menu')
  await page.click('.cmenu .cm-item:has-text("Проверить в Masaki")')
  await page.waitForFunction(() => document.querySelector('.abar-side .ext-act .ext-badge')?.textContent === 'ok', null, { timeout: 5000 })

  // Отключить и включить на странице «Аддоны»: кнопка пропадает и возвращается.
  console.log('шаг отключение расширения')
  await openAddons()
  await page.waitForSelector('.addons-page .sc-item:has-text("Masaki test action")')
  await shot('27e-ext-addons')
  await page.click('.addons-page .sc-item:has-text("Masaki test action") .switch')
  await page.waitForFunction(() => !document.querySelector('.abar-side .ext-act'), null, { timeout: 5000 })
  if (!(await page.$('.addons-page .sc-item.ext-off:has-text("Masaki test action")'))) throw new Error('отключённое расширение пропало из списка')
  await page.click('.addons-page .sc-item:has-text("Masaki test action") .switch')
  await page.waitForSelector('.abar-side .ext-act', { timeout: 8000 })
  const hidden = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible() && !w.isFocused()))
  if (headless && !hidden) throw new Error('Тест показал окно или перехватил фокус')
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
