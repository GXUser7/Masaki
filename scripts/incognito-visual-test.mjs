// Узкая регрессия: цветные обои не отменяют графитовый вид инкогнито, шапка не сжимает кнопки окна.
// Запуск после сборки: node scripts/incognito-visual-test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'test-output')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-incog-visual-'))
const settings = { scheme: 'light', palette: 'lime', background: 'custom', sidebarCollapsed: false }
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(settings))
// Однотонная жёлтая картинка — тот же случай, когда обои окрашивали всё приватное окно.
fs.writeFileSync(path.join(profile, 'custom-wallpaper.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAE0lEQVR4nGP8/4wBK2DCLjxYJQB/NAH1VblrWwAAAABJRU5ErkJggg==', 'base64'))
const before = fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')
const env = { ...process.env, MASAKI_PROFILE: profile, MASAKI_TEST_INACTIVE: '1', MASAKI_TEST_HEADLESS: '1' }
delete env.ELECTRON_RUN_AS_NODE
let app
try {
  app = await electron.launch({ args: [root, '--incognito'], cwd: root, env, colorScheme: null, timeout: 30000 })
  const page = await app.firstWindow()
  await page.waitForSelector('.ntp-incog', { timeout: 20000 })
  await page.waitForTimeout(700)
  const rendered = await page.evaluate(async () => {
    const settings = await window.masaki.settings.get()
    const app = document.querySelector('.app')
    const header = document.querySelector('.side-top')
    const brand = header.querySelector('.brand.incog')
    const toggle = header.querySelector('button')
    const buttons = [...header.querySelectorAll('button')].map((b) => {
      const r = b.getBoundingClientRect()
      return { width: r.width, right: r.right, top: r.top, bottom: r.bottom }
    })
    return {
      scheme: settings.scheme, palette: settings.palette, background: settings.background,
      dark: app.classList.contains('dark'), wallpaper: !!document.querySelector('.wall-img'),
      wall: getComputedStyle(app).backgroundColor,
      brandRight: brand.getBoundingClientRect().right,
      toggleLeft: toggle.getBoundingClientRect().left,
      headerRight: header.getBoundingClientRect().right,
      brandText: brand.textContent,
      buttons
    }
  })
  assert.equal(rendered.scheme, 'dark')
  assert.equal(rendered.palette, 'graphite')
  assert.equal(rendered.background, 'shapes')
  assert.equal(rendered.dark, true)
  assert.equal(rendered.wallpaper, false, 'цветные обои просочились в приватное окно')
  const rgb = rendered.wall.match(/\d+/g).slice(0, 3).map(Number)
  assert.ok(Math.max(...rgb) - Math.min(...rgb) < 8 && Math.max(...rgb) < 50, 'фон не тёмный графитовый')
  assert.ok(rendered.brandText.includes('Инкогнито'))
  assert.ok(rendered.brandRight <= rendered.toggleLeft + 1, 'метка заезжает на кнопку панели')
  for (const b of rendered.buttons) {
    assert.ok(b.width >= 31.5, 'кнопка окна сжалась')
    assert.ok(b.right <= rendered.headerRight + 1, 'кнопка окна вышла за шапку')
  }
  const shot = async (name) => {
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
    fs.writeFileSync(path.join(out, name), Buffer.from(png, 'base64'))
  }
  await shot('incog-visual-sidebar.png')
  await page.click('.side-top button[aria-label="Свернуть панель"]')
  await page.waitForSelector('.cap-incog')
  await page.waitForTimeout(900)
  assert.equal(await page.locator('.cap-incog').isVisible(), true)
  await shot('incog-visual-dock.png')
  await app.close()
  app = null
  assert.equal(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'), before, 'вид обычного профиля изменился')
  console.log('Инкогнито: графитовый фон вместо цветных обоев, шапка и док — ок')
} finally {
  if (app) await app.close().catch(() => {})
  fs.rmSync(profile, { recursive: true, force: true })
}
