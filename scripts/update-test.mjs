// Тест автообновления: настоящий установщик NSIS, настоящее обновление. Собираются два установщика
// (0.0.1 и 0.0.2) под тестовым именем MasakiUpdateTest — свой appId, свой exe, свой ключ удаления в
// реестре, без ярлыков и без build/installer.nsh (его удаление стёрло бы регистрацию настоящего
// Masaki браузером). 0.0.1 ставится тихо во временную папку, находит 0.0.2 на локальном сервере
// выпусков (MASAKI_UPDATE_URL), скачивает её в фоне; «Обновить Masaki» в меню ставит её, а новую
// версию тест запускает сам — с теми же вкладками. В конце тестовый Masaki удаляется.
//
// Запустить новую версию после установки установщик умеет и сам (у пользователя так и есть), но
// запускает её с окружением Windows — без MASAKI_PROFILE, то есть с профилем пользователя (так уже
// было 2026-10-13). Поэтому здесь MASAKI_UPDATE_NO_RELAUNCH, а у тестовой сборки ещё и своё имя
// программы (productName в метаданных) — даже без MASAKI_PROFILE её папка не %APPDATA%\Masaki.
//
// npm run test:update (долго: два установщика). Снимки — test-output/update-*.png.

import { _electron as electron } from 'playwright'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'test-output')
fs.mkdirSync(out, { recursive: true })
if (process.platform !== 'win32') {
  console.log('Обновление ставит установщик NSIS — тест только для Windows')
  process.exit(0)
}

const NAME = 'MasakiUpdateTest'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-update-'))
const installDir = path.join(tmp, 'install')
const profile = path.join(tmp, 'profile')
const exe = path.join(installDir, NAME + '.exe')
const updaterCache = path.join(process.env.LOCALAPPDATA, 'masaki-updatetest-updater')
const failures = []

function check(cond, msg) {
  if (cond) console.log('  ok —', msg)
  else {
    console.log('  ПРОВАЛ —', msg)
    failures.push(msg)
  }
}

async function waitFor(fn, what, ms = 30000) {
  const until = Date.now() + ms
  for (;;) {
    const v = await Promise.resolve()
      .then(fn)
      .catch(() => null)
    if (v) return v
    if (Date.now() > until) throw new Error('не дождались: ' + what)
    await new Promise((r) => setTimeout(r, 300))
  }
}

const ps = (cmd) => execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim()
// Версия файла у electron-builder — четыре числа («0.0.1.0»): сравниваем первые три.
const fileVersion = () => ps(`(Get-Item '${exe}').VersionInfo.ProductVersion`).split('.').slice(0, 3).join('.')
const runningPids = () =>
  ps(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${exe}' } | ForEach-Object { $_.ProcessId }`)
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
const killAll = () => {
  for (const pid of runningPids()) {
    try {
      process.kill(pid)
    } catch {}
  }
}

// ---------- Два установщика ----------

console.log('Сборка')
execFileSync(process.execPath, [path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'], { cwd: root, stdio: 'ignore' })
const emptyNsh = path.join(tmp, 'empty.nsh')
fs.writeFileSync(emptyNsh, '; тестовый установщик: ни регистрации, ни её удаления\n')
function installer(version) {
  const dir = path.join(tmp, 'v' + version)
  execFileSync(
    process.execPath,
    [
      path.join(root, 'node_modules', 'electron-builder', 'cli.js'),
      '--win',
      'nsis',
      '--publish',
      'never',
      `-c.extraMetadata.version=${version}`,
      // Своё имя пакета — свой кэш загрузок обновлений (%LOCALAPPDATA%\masaki-updatetest-updater);
      // своё имя программы — своя папка данных и никакой регистрации браузером под именем Masaki.
      '-c.extraMetadata.name=masaki-updatetest',
      `-c.extraMetadata.productName=${NAME}`,
      '-c.appId=app.masaki.updatetest',
      `-c.productName=${NAME}`,
      `-c.directories.output=${dir}`,
      '-c.nsis.createDesktopShortcut=false',
      '-c.nsis.createStartMenuShortcut=false',
      '-c.nsis.runAfterFinish=false',
      `-c.nsis.shortcutName=${NAME}`,
      `-c.nsis.uninstallDisplayName=${NAME}`,
      `-c.nsis.include=${emptyNsh}`,
      `-c.nsis.artifactName=${NAME}-Setup-\${version}.\${ext}`
    ],
    { cwd: root, stdio: 'ignore' }
  )
  return dir
}
const v1 = installer('0.0.1')
const v2 = installer('0.0.2')
const latest = fs.readFileSync(path.join(v2, 'latest.yml'), 'utf8')
check(/^version: 0\.0\.2$/m.test(latest) && /sha512:/.test(latest), 'latest.yml рядом с установщиком: версия и sha512')
check(fs.existsSync(path.join(v2, `${NAME}-Setup-0.0.2.exe.blockmap`)), 'blockmap для частичных обновлений')

// ---------- Сервер выпусков с 0.0.2 ----------

let served = 0
const server = http.createServer((req, res) => {
  const file = path.join(v2, decodeURIComponent(new URL(req.url, 'http://x').pathname).slice(1))
  if (!file.startsWith(v2) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end()
    return
  }
  if (file.endsWith('.exe')) served++
  res.writeHead(200, { 'content-length': fs.statSync(file).size })
  fs.createReadStream(file).pipe(res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const feed = `http://127.0.0.1:${server.address().port}/`

const env = {
  ...process.env,
  MASAKI_PROFILE: profile,
  MASAKI_TEST_INACTIVE: '1',
  MASAKI_UPDATE_URL: feed,
  MASAKI_UPDATE_DELAY: '1500',
  MASAKI_UPDATE_NO_RELAUNCH: '1'
}

let app
try {
  console.log('Установка 0.0.1')
  spawnSync(path.join(v1, `${NAME}-Setup-0.0.1.exe`), ['/S', `/D=${installDir}`], { stdio: 'ignore' })
  check(fs.existsSync(exe) && fileVersion() === '0.0.1', `установлена 0.0.1 (${fs.existsSync(exe) ? fileVersion() : 'нет exe'})`)
  check(fs.readdirSync(installDir).some((f) => /^Uninstall .+\.exe$/.test(f)), 'рядом деинсталлятор — Masaki знает, что он установлен')

  console.log('Обновление')
  app = await electron.launch({ executablePath: exe, env, colorScheme: null, timeout: 60000 })
  const page = await app.firstWindow()
  await page.waitForSelector('.stage', { timeout: 30000 })
  const fixture = pathToFileURL(path.join(root, 'scripts', 'fixtures', 'app-like.html')).href
  await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].webContents.send('command', { type: 'open-url', url }), fixture)
  await waitFor(() => page.locator('.has-update').count(), 'точка обновления на кнопке меню', 60000)
  check(served === 1, 'новая версия скачана в фоне, без спроса')
  const shot = async (name) => {
    await page.waitForTimeout(500)
    const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(b64, 'base64'))
    console.log(`  снимок test-output/${name}.png`)
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('command', { type: 'settings' }))
  const about = page.locator('section', { has: page.locator('h2', { hasText: 'О Masaki' }) })
  await about.scrollIntoViewIfNeeded()
  check(/Версия 0\.0\.2 скачана/.test(await about.innerText()), 'в настройках — «Версия 0.0.2 скачана», кнопка «Перезапустить»')
  await shot('update-settings')
  await page.locator('.has-update').first().click()
  await page.waitForSelector('.upd-mi')
  check(/Обновить Masaki/.test(await page.locator('.upd-mi').innerText()), 'в меню — «Обновить Masaki»')
  await shot('update-menu')

  const closed = new Promise((r) => app.once('close', r))
  await page.locator('.upd-mi').click()
  await closed
  app = null
  check(true, '«Обновить Masaki» закрыл окно')
  await waitFor(() => fs.existsSync(exe) && fileVersion() === '0.0.2' && !runningPids().length, 'установщик 0.0.2', 120000)
  check(true, 'поставлена 0.0.2')

  console.log('Новая версия')
  app = await electron.launch({ executablePath: exe, env, colorScheme: null, timeout: 60000 })
  const after = await app.firstWindow()
  await after.waitForSelector('.stage', { timeout: 30000 })
  check((await app.evaluate(({ app }) => app.getVersion())) === '0.0.2', 'работает 0.0.2')
  const restored = await waitFor(
    () => app.evaluate(({ webContents }) => webContents.getAllWebContents().some((w) => w.getURL().includes('app-like.html'))),
    'вкладка, открытая до обновления',
    20000
  ).catch(() => false)
  check(restored, 'вкладки вернулись после обновления')
  await waitFor(() => after.locator('.ib.has-update').count().then((n) => n === 0), 'точки больше нет', 10000).catch(() => null)
  check((await after.locator('.ib.has-update').count()) === 0, 'новее версии нет — точки на меню нет')
} catch (e) {
  failures.push(e.message)
  console.error('ОШИБКА:', e.message)
} finally {
  await app?.close().catch(() => {})
  killAll()
  server.close()
  console.log('Удаление')
  const uninstaller = fs.existsSync(installDir) && fs.readdirSync(installDir).find((f) => /^Uninstall .+\.exe$/.test(f))
  if (uninstaller) {
    spawnSync(path.join(installDir, uninstaller), ['/S'], { stdio: 'ignore' })
    await waitFor(() => !fs.existsSync(exe), 'удаление', 60000).catch((e) => failures.push(e.message))
  }
  // Деинсталлятор сначала удаляет файлы, а запись в списке программ убирает последней.
  const listed = () =>
    /DisplayName/.test(spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', NAME], { encoding: 'utf8' }).stdout ?? '')
  check(await waitFor(() => !listed(), 'запись в списке программ', 30000).catch(() => false), 'тестовый Masaki удалён и из списка программ')
  fs.rmSync(updaterCache, { recursive: true, force: true })
  fs.rmSync(path.join(process.env.APPDATA, NAME), { recursive: true, force: true })
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
}

console.log(failures.length ? `\nПровалов: ${failures.length}` : '\nВсё прошло')
process.exit(failures.length ? 1 : 0)
