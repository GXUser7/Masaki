// Рисует иконку Masaki (печенька M3 + снежинка-цветок) и сохраняет build/icon.png 512×512.
// Запуск: npm run icon
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const f = (n) => (Math.round(n * 10) / 10).toString()
function shape(r, N = 240) {
  let d = ''
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2 - Math.PI / 2
    const R = r(t)
    d += (i ? 'L' : 'M') + f(100 + R * Math.cos(t)) + ' ' + f(100 + R * Math.sin(t))
  }
  return d + 'Z'
}
const cookie = shape((t) => 90 + 7 * Math.cos(9 * t))
const flake = shape((t) => 40 + 15 * Math.cos(6 * t))
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="512" height="512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9EF2E4"/><stop offset="1" stop-color="#5FB8C9"/></linearGradient></defs>
  <path d="${cookie}" fill="url(#g)"/>
  <path d="${flake}" fill="#00504A"/>
  <circle cx="100" cy="100" r="11" fill="#9EF2E4"/>
</svg>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;background:transparent">${svg}</body>`))
  await new Promise((r) => setTimeout(r, 400))
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 })
  const out = path.join(__dirname, '..', 'build', 'icon.png')
  fs.writeFileSync(out, img.resize({ width: 512, height: 512 }).toPNG())
  console.log('icon ->', out)
  app.quit()
})
