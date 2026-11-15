// Удаление истории, адреса и карты: два настоящих профиля + подставной Google Диск.
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockGoogle } from './mock-google.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mock = await startMockGoogle()
const profiles = [0, 1].map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-removal-sync-')))
let a, b
const until = async (fn, label) => {
  const end = Date.now() + 20000
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 150)) }
  throw new Error(label)
}
const launch = async (profile, signIn = true) => {
  const env = { ...process.env, MASAKI_PROFILE: profile, MASAKI_TEST_HEADLESS: '1', MASAKI_TEST_INACTIVE: '1', MASAKI_TEST_PLAIN_STORAGE: '1', MASAKI_SYNC_MOCK: mock.url, MASAKI_SYNC_CLIENT: 'masaki-test.apps.googleusercontent.com:test-secret' }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: [root], cwd: root, env, colorScheme: null })
  const page = await app.firstWindow(); await page.waitForSelector('.stage'); await page.waitForTimeout(500)
  if (signIn) {
    assert.equal((await page.evaluate(() => window.masaki.sync.signIn(false))).ok, true)
    await until(async () => { const s = await page.evaluate(() => window.masaki.sync.state()); return s.account && s.status === 'idle' && s.lastSync > 0 }, 'sign in')
    await page.evaluate(() => window.masaki.sync.setOptions({ bookmarks: false, settings: false, tabs: false, history: true, passwords: true }))
    assert.equal((await page.evaluate(() => window.masaki.sync.setVaultKey('test-only-vault-phrase-2026'))).ok, true)
  }
  return { app, page }
}
const sync = async ({ page }) => {
  await page.evaluate(() => window.masaki.sync.syncNow())
  await until(async () => (await page.evaluate(() => window.masaki.sync.state())).status === 'idle', 'sync')
}
const watchdog = setTimeout(() => { a?.app.process().kill(); b?.app.process().kill(); process.exit(1) }, 120000)
try {
  a = await launch(profiles[0])
  const entry = { url: 'https://remove.example.test', title: 'Test', time: Date.now() - 10000 }
  await a.page.evaluate((e) => window.masaki.history.add(e), entry)
  await a.page.evaluate(() => window.masaki.autofill.saveAddress({ name: 'Test', street: 'Test Street', city: 'Test City' }))
  await a.page.evaluate(() => window.masaki.autofill.saveCard({ holder: 'Test', number: '4242424242424242', exp: '12/29' }))
  await sync(a)
  await until(() => mock.file('history.json')?.entries.some((e) => e.url === entry.url), 'history uploaded')
  b = await launch(profiles[1]); await sync(b)
  await until(async () => (await b.page.evaluate(() => window.masaki.autofill.cards())).length === 1, 'card at B')
  assert.equal((await b.page.evaluate(() => window.masaki.autofill.addresses())).length, 1)
  assert.ok((await b.page.evaluate(() => window.masaki.history.list())).some((e) => e.url === entry.url))
  const address = (await a.page.evaluate(() => window.masaki.autofill.addresses()))[0]
  const card = (await a.page.evaluate(() => window.masaki.autofill.cards()))[0]
  await a.page.evaluate(([entry, address, card]) => {
    window.masaki.history.remove(entry); window.masaki.autofill.remove('address', address.id); window.masaki.autofill.remove('card', card.id)
  }, [entry, address, card])
  await sync(a)
  await until(() => mock.file('history.json')?.removed?.includes(entry.url + '|' + entry.time), 'tombstone uploaded')
  await sync(b)
  await until(async () => !(await b.page.evaluate(() => window.masaki.history.list())).some((e) => e.url === entry.url), 'history removal at B')
  assert.equal((await b.page.evaluate(() => window.masaki.autofill.addresses())).length, 0)
  assert.equal((await b.page.evaluate(() => window.masaki.autofill.cards())).length, 0)
  await sync(b); await sync(a)
  assert.equal(mock.file('history.json').entries.some((e) => e.url === entry.url), false, 'старый список B не воскресил запись')
  await b.app.close(); b = null
  b = await launch(profiles[1], false)
  assert.equal((await b.page.evaluate(() => window.masaki.history.list())).some((e) => e.url === entry.url), false)
  assert.equal((await b.page.evaluate(() => window.masaki.autofill.addresses())).length, 0)
  assert.equal((await b.page.evaluate(() => window.masaki.autofill.cards())).length, 0)
  console.log('OK: история, адрес и карта удалены на втором профиле, не возвращаются после слияния и перезапуска')
} finally {
  await a?.app.close().catch(() => {}); await b?.app.close().catch(() => {}); clearTimeout(watchdog)
  await mock.close()
  for (const profile of profiles) fs.rmSync(profile, { recursive: true, force: true })
}
