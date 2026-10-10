// Снимки для README: чистый временный профиль, фон «Фигуры», локальные демо-страницы (никаких
// чужих сайтов и личных данных). Запуск: npm run screens → docs/screens/*.png.
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'docs', 'screens')
fs.mkdirSync(out, { recursive: true })
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-screens-'))
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ scheme: 'dark', palette: 'mint', glass: 'l', background: 'shapes' }))

// ---------- Демо-страницы ----------
const css = `body{margin:0;font:17px/1.6 system-ui,sans-serif;background:#fbfaf7;color:#1d1b20}
header{display:flex;align-items:center;gap:14px;padding:18px 48px;border-bottom:1px solid #eee}
header b{font-size:20px}header nav{margin-left:auto;display:flex;gap:22px;color:#666;font-size:15px}
.hero{height:260px;margin:28px 48px;border-radius:28px;background:linear-gradient(135deg,#ffd9a8,#ff9f7a 45%,#9f86ff)}
main{max-width:760px;margin:0 48px}h1{font-size:40px;line-height:1.15;margin:8px 0 14px}p{color:#3c3a40}`
const pages = {
  '/article': `<!doctype html><meta charset="utf-8"><title>Как работает сон — Наука просто</title><style>${css}</style>
<header><b>Наука просто</b><nav><span>Статьи</span><span>Подкасты</span><span>О нас</span></nav></header>
<div class="hero"></div><main><small>12 минут чтения</small><h1>Зачем мозгу сон и что происходит ночью</h1>
<p>Пока мы спим, мозг не отдыхает: он сортирует впечатления дня, переносит важное в долговременную память и избавляется от лишнего. Учёные до сих пор спорят, какая из этих задач главная.</p>
<p>Медленный сон отвечает за восстановление, быстрый — за эмоции и сны. За ночь мы проходим четыре–пять таких циклов.</p></main>`,
  '/todo': `<!doctype html><meta charset="utf-8"><title>Список дел</title><style>${css}li{margin:10px 0}</style>
<header><b>Дела</b></header><main><h1>Неделя</h1><ul><li>Дописать отчёт</li><li>Купить билеты</li><li>Позвонить маме</li></ul></main>`,
  '/music': `<!doctype html><meta charset="utf-8"><title>Плейлист для работы</title><style>${css}</style>
<header><b>Музыка</b></header><main><h1>Плейлист для работы</h1><p>Лоу-фай и эмбиент на три часа.</p></main>`,
  '/videos': `<!doctype html><meta charset="utf-8"><title>Видео</title>
<style>html,body{margin:0;background:#0f0f0f;color:#f1f1f1;font:15px system-ui,sans-serif}
header{position:sticky;top:0;height:60px;display:flex;align-items:center;gap:16px;padding:0 28px;background:#0f0f0f;font-weight:700;font-size:20px}
header input{margin-left:80px;width:420px;height:38px;border-radius:20px;border:1px solid #333;background:#121212;color:#eee;padding:0 18px}
main{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;padding:24px 28px}
.v{border-radius:14px;aspect-ratio:16/9;background:linear-gradient(135deg,#2a2a2a,#1c1c1c)}.v:nth-child(3n+1){background:linear-gradient(135deg,#3b2f52,#1e2a44)}.v:nth-child(3n+2){background:linear-gradient(135deg,#4a2f2a,#2a1f33)}
.t{margin-top:10px;font-weight:600}.s{color:#aaa;font-size:13px}</style>
<header>▶ Видео<input placeholder="Поиск"></header><main>${Array.from({ length: 6 }, (_, i) => `<div><div class="v"></div><div class="t">Ролик ${i + 1}: путешествие по северу</div><div class="s">Канал · ${i + 2} тыс. просмотров</div></div>`).join('')}</main>`,
  '/passkey': `<!doctype html><meta charset="utf-8"><title>Вход — Наука просто</title><style>${css}input{display:block;margin:12px 0;font:inherit;padding:10px 14px;width:320px;border:1px solid #ccc;border-radius:12px}</style>
<header><b>Наука просто</b></header><main><h1>Вход</h1><input autocomplete="username webauthn" placeholder="Почта"></main>
<script>window.go=()=>navigator.credentials.create({publicKey:{rp:{name:'Наука просто'},user:{id:new Uint8Array([1,2,3]),name:'anna@example.com',displayName:'Анна'},challenge:new Uint8Array(32),pubKeyCredParams:[{type:'public-key',alg:-7}]}}).catch(()=>{})</script>`
}
const site = http.createServer((req, res) => {
  const body = pages[new URL(req.url, 'http://x').pathname]
  res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(body ?? '')
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const SITE = `http://localhost:${site.address().port}`

// ---------- Masaki ----------
const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, MASAKI_TEST_INACTIVE: '1', MASAKI_PROFILE: profile }, timeout: 60000 })
const win = await app.firstWindow()
await win.waitForSelector('.stage', { timeout: 30000 })
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1440, height: 900 }))
const command = (c) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('command', c), c)
const wait = (ms) => win.waitForTimeout(ms)
async function shot(name) {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(b64, 'base64'))
  console.log('снимок', name)
}
async function inTab(code) {
  const id = await win.evaluate(() => document.querySelector('webview.wv.on')?.getWebContentsId())
  return app.evaluate(({ webContents }, [id, code]) => webContents.fromId(id).executeJavaScript(code, true), [id, code])
}
async function open(url) {
  await command({ type: 'open-url', url })
  for (let i = 0; i < 60; i++) {
    if ((await inTab('location.href + document.readyState').catch(() => '')) === url + 'complete') break
    await wait(250)
  }
  await wait(900)
}
async function run(cmd) {
  await command({ type: 'palette', withUrl: false })
  await win.waitForSelector('.cmd')
  await win.keyboard.type('>' + cmd)
  await wait(400)
  await win.keyboard.press('Enter')
  await wait(900)
}

try {
  await wait(2500)
  await shot('newtab')

  await open(SITE + '/music')
  await open(SITE + '/todo')
  await open(SITE + '/article')
  await shot('browser')

  await command({ type: 'palette', withUrl: false })
  await win.waitForSelector('.cmd')
  await win.keyboard.type('>')
  await wait(900)
  await shot('commands')
  await win.keyboard.press('Escape')
  await wait(500)

  await win.click('.side-top .ib[aria-label^="Свернуть панель"]')
  await wait(1200)
  await win.focus('.capsule .cap-side')
  await wait(900)
  await shot('capsule')
  await win.click('.capsule .cap-side')
  await wait(1200)

  await open(SITE + '/passkey')
  await inTab('go(); true')
  await win.waitForSelector('.pk-card', { timeout: 8000 })
  await wait(900)
  await shot('passkey')
  await win.click('.pk-card button:has-text("Отмена")')
  await wait(500)

  await run('прозрачные')
  await open(SITE + '/videos')
  await wait(1200)
  await shot('glass-sites')

  await run('светлая тема')
  await command({ type: 'new-tab' })
  await wait(1500)
  await shot('newtab-light')

  await command({ type: 'settings' })
  await win.waitForSelector('.clock-grid')
  await win.evaluate(() => document.querySelector('.clock-grid').scrollIntoView({ block: 'center' }))
  await wait(1500)
  await shot('clocks')
} finally {
  await app.close().catch(() => {})
  site.close()
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}
