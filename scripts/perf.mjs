// Замер плавности: интервалы между кадрами при сворачивании и разворачивании боковой панели.
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const root = process.cwd()
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-perf-'))
const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, MASAKI_TEST_INACTIVE: '1', MASAKI_PROFILE: profile }, timeout: 60000 })
const page = await app.firstWindow()
await page.waitForSelector('.ntp', { timeout: 30000 })
const where = process.argv[2] || 'site'
await page.waitForTimeout(1500)
if (where === 'site') {
  await page.click('.fakebox'); await page.keyboard.type('example.com'); await page.keyboard.press('Enter')
  await page.waitForTimeout(3500)
}
async function measure(label, action) {
  const stats = await page.evaluate(async (act) => {
    const frames = []
    let last = performance.now()
    let run = true
    const tick = (t) => { frames.push(t - last); last = t; if (run) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    await new Promise((r) => setTimeout(r, 150))
    document.querySelector(act).click()
    await new Promise((r) => setTimeout(r, 900))
    run = false
    const f = frames.slice(2)
    const avg = f.reduce((a, b) => a + b, 0) / f.length
    return { frames: f.length, avg: +avg.toFixed(1), max: +Math.max(...f).toFixed(1), janky: f.filter((x) => x > 25).length }
  }, action)
  console.log(label, JSON.stringify(stats))
}
for (let i = 0; i < 2; i++) {
  await measure('свернуть', '.side-top .ib[aria-label^="Свернуть панель"]')
  await page.waitForTimeout(500)
  await measure('развернуть', '.capsule .cap-side')
  await page.waitForTimeout(500)
}
await app.close()
fs.rmSync(profile, { recursive: true, force: true })
