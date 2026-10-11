// YouCloud в Masaki: мост вместо расширения, мини-плеер с обложкой и поиск из палитры.
// Нужен сайт YouCloud: по умолчанию его дев-сервер (YouCloud/web: npm run dev → localhost:5190),
// или YOUCLOUD_URL=https://youcloud.inkerror67.workers.dev/ для живого сайта.
// Запуск: npm run test:youcloud. Снимки — в test-output/yc-*.png.
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'test-output')
fs.mkdirSync(out, { recursive: true })
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-test-'))
const SITE = process.env.YOUCLOUD_URL ?? 'http://localhost:5190/'
const dev = SITE.startsWith('http://localhost')

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

let failed = 0
const check = (ok, what, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'ок ' : 'ОШИБКА'}  ${what}${detail ? ' — ' + detail : ''}`)
}

async function shot(name) {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(b64, 'base64'))
  console.log('снимок', name)
}
const command = (c) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('command', c), c)
/** Выражение во вкладке YouCloud (в мире страницы). */
const inSite = (code) =>
  app.evaluate(({ webContents }, [site, code]) => {
    const g = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL().startsWith(site))
    return g ? g.executeJavaScript(code, true) : 'нет вкладки YouCloud'
  }, [new URL(SITE).origin, code])

/** Сообщение мосту так, как его шлёт сайт (lib/extension.ts), и ответ на него. */
const ask = (message, ms = 25000) =>
  inSite(`new Promise((res) => {
    const id = Math.floor(Math.random() * 1e9)
    const h = (e) => { if (e.data && e.data.yc === 'ext' && e.data.kind === 'response' && e.data.id === id) { removeEventListener('message', h); res(e.data) } }
    addEventListener('message', h)
    postMessage({ yc: 'page', id, ...${JSON.stringify(message)} }, location.origin)
    setTimeout(() => res('нет ответа'), ${ms})
  })`)

try {
  await page.waitForSelector('.ntp', { timeout: 30000 })
  await command({ type: 'open-url', url: SITE })
  await page.waitForSelector('webview.wv.on', { timeout: 20000 })
  await page.waitForTimeout(6000)

  // 1. Сайт видит «расширение» — это Masaki.
  const hello = await inSite(`new Promise((res) => {
    const h = (e) => { if (e.data && e.data.yc === 'ext' && e.data.kind === 'hello') { removeEventListener('message', h); res(e.data) } }
    addEventListener('message', h)
    postMessage({ yc: 'page', kind: 'ping' }, location.origin)
    setTimeout(() => res('нет ответа'), 3000)
  })`)
  check(hello?.host === 'masaki', 'мост отвечает на ping', JSON.stringify(hello))
  check((await inSite('document.documentElement.dataset.host')) === 'masaki', 'сайт понял, что он в Masaki')
  await shot('yc-01-site')

  // 2. Яндекс и YouTube — с IP пользователя, с заголовками, которые странице не поставить.
  const ya = await ask({ kind: 'fetch', request: { url: 'https://api.music.yandex.net/landing3/chart' } })
  check(ya?.status === 200, 'Яндекс через мост', ya?.status ?? JSON.stringify(ya))
  const vr = {
    videoId: 'dQw4w9WgXcQ',
    context: { client: { clientName: 'ANDROID_VR', clientVersion: '1.62.27', deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32, osName: 'Android', osVersion: '12L', hl: 'ru' } }
  }
  const yt = await ask({
    kind: 'fetch',
    request: {
      url: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(vr),
      overrides: { 'user-agent': 'com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip', origin: null, referer: null }
    }
  })
  let play = null
  try {
    play = JSON.parse(yt.body).playabilityStatus?.status
  } catch {
    // не JSON
  }
  check(yt?.status === 200 && !!play, 'YouTube player через мост', `${yt?.status} ${play}`)
  // Звук YouTube: ссылку находит yt-dlp через ретранслятор Masaki (тот же выход в сеть, что у вкладок),
  // и её должен сыграть <audio> во вкладке — иначе при VPN «только для Masaki» ссылка не играет.
  const st = await ask({ kind: 'yt-stream', videoId: 'dQw4w9WgXcQ' }, 90000)
  const streamUrl = st?.value?.url ?? ''
  check(/googlevideo\.com/.test(streamUrl), 'yt-dlp нашёл звук YouTube (через ретранслятор)', streamUrl ? 'ok' : JSON.stringify(st))
  if (streamUrl) {
    const playable = await inSite(`new Promise((res) => {
      const a = new Audio()
      a.preload = 'metadata'
      a.onloadedmetadata = () => res('ok ' + Math.round(a.duration) + ' с')
      a.onerror = () => res('ошибка ' + (a.error && a.error.code))
      a.src = ${JSON.stringify(streamUrl)}
      setTimeout(() => res('нет ответа'), 20000)
    })`)
    check(String(playable).startsWith('ok'), 'ссылка yt-dlp играет во вкладке', playable)
  }
  const denied = await ask({ kind: 'fetch', request: { url: 'https://example.com/' } })
  check(String(denied?.error).includes('not allowed'), 'чужой хост мост не пускает', denied?.error)
  const account = await ask({ kind: 'call', name: 'yt-account' })
  check(account?.value === false, 'вход в YouTube — по куки Masaki (в чистом профиле его нет)', JSON.stringify(account?.value))

  // 3. Музыка в фоне: мини-плеер с обложкой и кнопками сайта.
  if (dev) {
    const started = await inSite(`(async () => {
      const state = await import('/src/lib/state.svelte.ts')
      const sc = await import('/src/lib/services/soundcloud.ts')
      const ids = (await sc.searchTracks('lofi hip hop', 5)).map((t) => sc.putScTrack(t))
      state.playQueue(ids, 0)
      for (let i = 0; i < 40 && !state.player.playing; i++) await new Promise((r) => setTimeout(r, 500))
      return state.player.playing
    })()`)
    check(started === true, 'трек SoundCloud играет в YouCloud')
    await page.waitForTimeout(1500)
    await command({ type: 'new-tab' })
    await page.waitForSelector('.mplayer.rich', { timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(2500)
    const before = await page.locator('.mplayer.rich .mp-t b').first().textContent().catch(() => null)
    check(!!before, 'мини-плеер показывает название трека', before ?? '')
    check((await page.locator('.mplayer.rich .mp-art img').count()) > 0, 'в мини-плеере обложка')
    check((await page.locator('.mplayer.rich.tinted').count()) > 0, 'мини-плеер в цвете обложки')
    await shot('yc-02-miniplayer')
    const next = page.locator('.mplayer.rich .mp-ib[aria-label="Следующий трек"]').first()
    check((await next.count()) > 0, 'есть «следующий трек» сайта')
    if (await next.count()) {
      await next.click()
      await page.waitForFunction((t) => document.querySelector('.mplayer.rich .mp-t b')?.textContent !== t, before, { timeout: 15000 }).catch(() => {})
      const after = await page.locator('.mplayer.rich .mp-t b').first().textContent().catch(() => null)
      check(!!after && after !== before, '«следующий» переключил трек сайта', `${before} → ${after}`)
    }
    await page.locator('.mplayer.rich .mp-btn').first().click()
    await page.waitForTimeout(1500)
    const paused = await inSite(`import('/src/lib/state.svelte.ts').then((s) => s.player.playing)`)
    check(paused === false, 'пауза из мини-плеера остановила плеер сайта')
    await shot('yc-03-paused')
  }

  // 4. Палитра: запрос можно искать в YouCloud.
  await command({ type: 'palette', withUrl: false })
  await page.waitForSelector('.cmd')
  await page.keyboard.type('daft punk', { delay: 15 })
  await page.waitForTimeout(800)
  const row = page.locator('.cmd .row', { hasText: 'Найти в YouCloud' })
  check((await row.count()) > 0, 'в палитре есть «Найти в YouCloud»')
  await shot('yc-04-palette')
  if (await row.count()) {
    await row.first().click()
    await page.waitForTimeout(2500)
    const hash = await inSite('location.hash')
    check(String(hash).startsWith('#/search/daft'), 'палитра открыла поиск YouCloud', hash)
    const field = await inSite(`document.querySelector('.topbar input')?.value`)
    check(field === 'daft punk', 'запрос в строке поиска сайта', field)
    await page.waitForTimeout(3000)
    await shot('yc-05-search')
  }
} catch (e) {
  failed++
  console.log('ОШИБКА', e)
}

const errors = logs.filter((l) => l.startsWith('[pageerror]') || l.startsWith('[error]'))
if (errors.length) console.log('Ошибки интерфейса:\n' + errors.join('\n'))
await app.close()
fs.rmSync(profile, { recursive: true, force: true })
console.log(failed ? `Не прошло: ${failed}` : 'Всё прошло')
process.exit(failed ? 1 : 0)
