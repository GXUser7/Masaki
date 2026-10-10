// Быстрый замер: запускает Masaki и выполняет выражение из argv в окне интерфейса.
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-probe-'))
const app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, MASAKI_PROFILE: profile }, timeout: 60000 })
const page = await app.firstWindow()
await page.waitForSelector(process.argv[3] || '.ntp', { timeout: 30000 })
await page.waitForTimeout(1500)
try { console.log(JSON.stringify(await page.evaluate(process.argv[2]), null, 1)) } catch (e) { console.log('ERR', e.message) }
await app.close()
fs.rmSync(profile, { recursive: true, force: true })
