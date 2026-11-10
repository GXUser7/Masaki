// Узкая проверка темы мини-плеера в настоящем Electron, с подставной музыкой на localhost.
// После сборки: node scripts/miniplayer-theme-test.mjs. Профиль пользователя не используется.
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'test-output')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-player-theme-'))
fs.mkdirSync(output, { recursive: true })
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ scheme: 'dark', palette: 'mint', sidebarCollapsed: false, addons: { adblock: { enabled: false } } }))
const site = http.createServer((req, res) => {
  if (req.url === '/clip.webm') {
    res.setHeader('content-type', 'video/webm')
    return fs.createReadStream(path.join(root, 'scripts/fixtures/clip.webm')).pipe(res)
  }
  if (req.url?.startsWith('/cover-')) {
    res.setHeader('content-type', 'image/svg+xml')
    const color = req.url.includes('red') ? '#fc1537' : '#1554fc'
    return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="${color}"/><circle cx="256" cy="256" r="110" fill="white"/></svg>`)
  }
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(`<!doctype html><meta charset="utf-8"><title>Музыка для проверки темы</title><h1>Подставной музыкальный сайт</h1><script>
    window.player = new Audio('/clip.webm'); player.muted = true; player.loop = true;
    window.setCover = tone => navigator.mediaSession.metadata = new MediaMetadata({title:'Проверка мини-плеера',artist:'Masaki Band',artwork:[{src:location.origin+'/cover-'+tone+'.svg',sizes:'512x512',type:'image/svg+xml'}]});
    setCover('red');
    navigator.mediaSession.setActionHandler('pause',()=>player.pause());
    navigator.mediaSession.setActionHandler('play',()=>player.play());
    player.onplay=()=>navigator.mediaSession.playbackState='playing';
    player.onpause=()=>navigator.mediaSession.playbackState='paused';
    player.play();
  </script>`)
})
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve))
const origin = `http://localhost:${site.address().port}`
let app
let page
let settings
let mainId
const watchdog = setTimeout(() => { console.error('Мини-плеер: превышено 90 секунд'); app?.process().kill(); process.exit(1) }, 90_000)
const command = c => app.evaluate(({ BrowserWindow }, [id, c]) => BrowserWindow.fromId(id).webContents.send('command', c), [mainId, c])
const inMusic = code => app.evaluate(({ webContents }, [origin, code]) => {
  const contents = webContents.getAllWebContents().find(w => w.getType() === 'webview' && w.getURL().startsWith(origin))
  if (!contents) throw new Error('Музыкальная вкладка не найдена')
  return contents.executeJavaScript(code, true)
}, [origin, code])
async function theme(patch) {
  settings = { ...settings, ...patch }
  await app.evaluate(({ BrowserWindow }, [id, next]) => BrowserWindow.fromId(id).webContents.send('settings-changed', next), [mainId, settings])
  await page.waitForTimeout(750)
}
async function appearance(selector) {
  return page.locator(selector).evaluate(el => {
    const computed = getComputedStyle(el)
    const play = getComputedStyle(el.querySelector('.mp-btn'))
    const probe = document.createElement('span')
    probe.style.cssText = `background:var(${el.classList.contains('dock') ? '--glass-pop' : '--glass-hi'});color:var(--primary)`
    el.append(probe)
    const expected = getComputedStyle(probe)
    const value = { background: computed.backgroundColor, button: play.backgroundColor, text: computed.color, expectedBackground: expected.backgroundColor, expectedButton: expected.color }
    probe.remove()
    return value
  })
}
async function cover(tone) {
  const before = await page.locator('.mplayer.rich:visible .mp-art img').getAttribute('src')
  const previous = await inMusic('navigator.mediaSession.metadata.artwork[0].src')
  await inMusic(`setCover(${JSON.stringify(tone)})`)
  if (!previous.endsWith(`/cover-${tone}.svg`)) await page.waitForFunction(before => [...document.querySelectorAll('.mplayer.rich .mp-art img')].some(img => img.src !== before && img.src.startsWith('data:') && img.complete && img.naturalWidth > 0), before)
  await page.waitForTimeout(700)
}
async function shot(name) {
  const png = await app.evaluate(async ({ BrowserWindow }, id) => (await BrowserWindow.fromId(id).capturePage()).toPNG().toString('base64'), mainId)
  fs.writeFileSync(path.join(output, `miniplayer-${name}.png`), Buffer.from(png, 'base64'))
}
try {
  const env = { ...process.env, MASAKI_PROFILE: profile, MASAKI_TEST_INACTIVE: '1', MASAKI_TEST_HEADLESS: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [root], cwd: root, env, colorScheme: null, timeout: 60_000 })
  page = await app.firstWindow()
  mainId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id)
  await page.waitForSelector('.stage')
  settings = await page.evaluate(() => window.masaki.settings.get())
  await command({ type: 'open-url', url: origin })
  await page.waitForFunction(() => !!document.querySelector('webview.wv.on'))
  await page.waitForTimeout(1200)
  await command({ type: 'new-tab' })
  await page.waitForSelector('.side .mplayer.rich')
  await page.waitForFunction(() => [...document.querySelectorAll('.mplayer.rich .mp-art img')].some(img => img.complete && img.naturalWidth > 0 && img.src.startsWith('data:')))

  for (const sidebarCollapsed of [false, true]) {
    const selector = sidebarCollapsed ? '.mplayer.rich.dock:visible' : '.side .mplayer.rich'
    await theme({ sidebarCollapsed, scheme: 'dark', palette: 'mint' })
    await cover('red')
    const red = await appearance(selector)
    assert.equal(red.background, red.expectedBackground, 'подложка использует стекло общей темы')
    assert.equal(red.button, red.expectedButton, 'кнопка использует основной цвет общей темы')
    await cover('blue')
    assert.deepEqual(await appearance(selector), red, 'смена обложки не перекрашивает мини-плеер')
    await shot(sidebarCollapsed ? 'dock-dark' : 'sidebar-dark')
    await theme({ palette: 'violet' })
    const violet = await appearance(selector)
    assert.notEqual(violet.button, red.button, 'кнопка реагирует на смену палитры Masaki')
    assert.equal(violet.button, violet.expectedButton)
    await theme({ scheme: 'light' })
    const light = await appearance(selector)
    assert.notEqual(light.background, red.background, 'плеер реагирует на светлую тему')
    assert.equal(light.background, light.expectedBackground)
    await shot(sidebarCollapsed ? 'dock-light' : 'sidebar-light')
    console.log(`ок: ${sidebarCollapsed ? 'док' : 'панель'} — обе обложки, смена палитры, тёмная и светлая темы`)
  }
  console.log('Мини-плеер: все проверки общей темы прошли')
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  await app?.close().catch(() => {})
  await new Promise(resolve => site.close(resolve))
  if (!path.resolve(profile).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(profile).startsWith('masaki-player-theme-')) throw new Error('Небезопасный путь тестового профиля')
  fs.rmSync(profile, { recursive: true, force: true })
}
