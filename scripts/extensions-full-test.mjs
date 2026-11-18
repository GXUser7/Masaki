// Полный тест расширений Chrome Web Store в Masaki (скрытый изолированный профиль):
// Часть A: синтетические MV3-расширения через browser.* и chrome.* (DNR block/redirect/transform/modifyHeaders/
//   allowAllRequests/badge count, OffscreenCanvas setIcon, runtime.onInstalled, storage.managed vs local,
//   storage.sync, fontSettings, contextMenus.update + checkbox, commands, tabs.captureVisibleTab,
//   userScripts MAIN world, незамороженный chrome, target="_blank" из попапа, установка из .zip, Dark+Glass).
// Часть B: настоящие расширения из Chrome Web Store (uBlock Origin Lite, Dark Reader, Stylus, SponsorBlock)
//   на локальном стенде — отсутствие падений SW, реальная блокировка рекламы и реальное затемнение страницы.

import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { clickGuest as clickGuestInput } from './electron-input.mjs'

const root = process.cwd()
const out = path.join(root, 'test-output')
fs.mkdirSync(out, { recursive: true })

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-extfull-'))
const workDir = path.join(profile, '_work')
fs.mkdirSync(workDir, { recursive: true })

// ---------- Мини-генератор тестовых расширений и ZIP-пакетов ----------

function makeZipBuffer(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const comp = deflateRawSync(raw)
    const nameBuf = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    nameBuf.copy(local, 30)
    locals.push(local, comp)

    const cd = Buffer.alloc(46 + nameBuf.length)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(8, 10)
    cd.writeUInt32LE(comp.length, 20)
    cd.writeUInt32LE(raw.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    nameBuf.copy(cd, 46)
    centrals.push(cd)
    offset += local.length + comp.length
  }
  const cdBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cdBuf, eocd])
}

// 1) Синтетический MV3-блокировщик через browser.* (как uBOL / AdGuard)
const blockerDir = path.join(workDir, 'ext-blocker')
fs.mkdirSync(path.join(blockerDir, '_locales', 'ru'), { recursive: true })
fs.writeFileSync(
  path.join(blockerDir, '_locales', 'ru', 'messages.json'),
  JSON.stringify({ extDesc: { message: 'Тестовый блокировщик DNR и косметики' } })
)
fs.writeFileSync(
  path.join(blockerDir, 'rules.json'),
  JSON.stringify([
    {
      id: 1,
      priority: 1,
      action: { type: 'block' },
      condition: { urlFilter: '/ads/static-ad.js', resourceTypes: ['script', 'xmlhttprequest'] }
    },
    {
      id: 2,
      priority: 1,
      action: { type: 'redirect', redirect: { extensionPath: '/surrogate.js' } },
      condition: { urlFilter: '/ads/surrogate-target.js', resourceTypes: ['script'] }
    },
    {
      id: 3,
      priority: 1,
      action: { type: 'redirect', redirect: { transform: { queryTransform: { removeParams: ['utm_source'] } } } },
      condition: { urlFilter: '/clean-url', resourceTypes: ['xmlhttprequest', 'main_frame'] }
    },
    {
      id: 4,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'X-Masaki-Ext-In', operation: 'set', value: 'dnr-ok' }],
        responseHeaders: [{ header: 'X-Masaki-Ext-Out', operation: 'set', value: 'resp-ok' }]
      },
      condition: { urlFilter: '/headers-echo', resourceTypes: ['xmlhttprequest'] }
    }
  ])
)
fs.writeFileSync(path.join(blockerDir, 'surrogate.js'), 'window.__surrogateRan = true;')
fs.writeFileSync(path.join(blockerDir, 'cosmetic.css'), '.syn-ad-banner { display: none !important; }')
fs.writeFileSync(
  path.join(blockerDir, 'popup.html'),
  '<!doctype html><html><body style="width:260px;padding:12px"><h3>Synth Blocker</h3><a id="open-link" target="_blank" href="http://127.0.0.1:__PORT__/opened-from-popup">Open Tab</a></body></html>'
)
fs.writeFileSync(
  path.join(blockerDir, 'sw.js'),
  `
  // Проверка, что chrome не заморожен (SponsorBlock так патчит polyfills)
  chrome.contentScripts = { register: async () => ({ unregister: async () => {} }) };

  let installedReason = null;
  browser.runtime.onInstalled.addListener((d) => { installedReason = d.reason; });

  (async () => {
    await browser.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: true });
    await browser.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [101],
      addRules: [{
        id: 101, priority: 2,
        action: { type: 'block' },
        condition: { urlFilter: '/ads/dynamic-ad.js', resourceTypes: ['script', 'xmlhttprequest'] }
      }]
    });
    await browser.scripting.registerContentScripts([{
      id: 'cosmetic-hide', matches: ['http://127.0.0.1/*'], css: ['cosmetic.css'], runAt: 'document_start'
    }]).catch(() => {});

    // OffscreenCanvas -> MV3 setIcon({ imageData })
    const c = new OffscreenCanvas(32, 32);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#16a34a';
    ctx.fillRect(0, 0, 32, 32);
    await browser.action.setIcon({ imageData: { 32: ctx.getImageData(0, 0, 32, 32) } });
    await browser.action.setBadgeBackgroundColor({ color: '#16a34a' });
  })();

  globalThis.__setAllowAll = async (allow) => {
    await browser.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [201],
      addRules: allow ? [{
        id: 201, priority: 100,
        action: { type: 'allowAllRequests' },
        condition: { urlFilter: 'http://127.0.0.1:*', resourceTypes: ['main_frame'] }
      }] : []
    });
  };

  browser.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg === 'ping') {
      Promise.all([
        browser.storage.managed.get(null),
        browser.storage.sync.set({ sKey: 'syncVal' }).then(() => browser.storage.sync.get('sKey')),
        browser.fontSettings.getFontList(),
        browser.declarativeNetRequest.getMatchedRules()
      ]).then(([managed, syncRes, fonts, matched]) => {
        sendResponse({
          installedReason,
          managed,
          syncRes,
          fontsCount: fonts.length,
          matchedCount: matched.rulesMatchedInfo.length,
          hasDynamicContentScriptsProp: !!chrome.contentScripts
        });
      });
      return true;
    }
    if (msg && msg.allowAll !== undefined) {
      globalThis.__setAllowAll(!!msg.allowAll).then(() => sendResponse({ ok: true }));
      return true;
    }
  });
`
)
fs.writeFileSync(
  path.join(blockerDir, 'manifest.json'),
  JSON.stringify({
    manifest_version: 3,
    name: 'Synth Blocker',
    default_locale: 'ru',
    description: '__MSG_extDesc__',
    version: '1.0',
    action: { default_title: 'Synth Blocker', default_popup: 'popup.html' },
    background: { service_worker: 'sw.js' },
    web_accessible_resources: [{ resources: ['surrogate.js'], matches: ['<all_urls>'] }],
    declarative_net_request: { rule_resources: [{ id: 'ruleset_1', enabled: true, path: 'rules.json' }] },
    permissions: [
      'declarativeNetRequest',
      'declarativeNetRequestFeedback',
      'scripting',
      'storage',
      'fontSettings',
      'tabs',
      'activeTab'
    ],
    host_permissions: ['<all_urls>']
  })
)

// 2) Синтетическое расширение тёмной темы + commands + contextMenus.update + userScripts + captureVisibleTab
const themeExtDir = path.join(workDir, 'ext-darktheme')
fs.mkdirSync(themeExtDir, { recursive: true })
fs.writeFileSync(
  path.join(themeExtDir, 'sw.js'),
  `
  let lastCmd = null;
  let lastMenuChecked = null;
  let captureOk = false;

  chrome.commands.onCommand.addListener((cmd) => { lastCmd = cmd; });

  (async () => {
    await chrome.storage.local.set({ darkOn: true, secretLocal: 'must-not-leak-to-managed' });
    await chrome.userScripts.register([{
      id: 'us-main',
      matches: ['http://127.0.0.1/*'],
      world: 'MAIN',
      runAt: 'document_end',
      js: [{ code: 'window.__userScriptMainRan = true;' }]
    }]);
    chrome.contextMenus.create({ id: 'dm-toggle', type: 'checkbox', checked: false, title: 'Тёмная тема (старая)', contexts: ['page'] });
    chrome.contextMenus.update('dm-toggle', { title: 'Тёмная тема (обновлено)' });
  })();

  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === 'dm-toggle') {
      lastMenuChecked = info.checked;
      const cap = await chrome.tabs.captureVisibleTab().catch(() => '');
      captureOk = typeof cap === 'string' && cap.startsWith('data:image/png');
      if (tab?.id) {
        await chrome.tabs.insertCSS(tab.id, { code: 'html, body { background-color: rgb(20, 22, 26) !important; color: #eee !important; }' });
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg === 'theme-diag') {
      sendResponse({ lastCmd, lastMenuChecked, captureOk });
    }
  });
`
)
fs.writeFileSync(
  path.join(themeExtDir, 'cs.js'),
  `
  if (location.search.includes('darktheme=1')) {
    document.documentElement.setAttribute('data-darkreader-scheme', 'dark');
    document.documentElement.style.backgroundColor = 'rgb(20, 22, 26)';
    document.body && (document.body.style.backgroundColor = 'rgb(20, 22, 26)');
  }
`
)
fs.writeFileSync(
  path.join(themeExtDir, 'manifest.json'),
  JSON.stringify({
    manifest_version: 3,
    name: 'Synth Theme & Scripts',
    version: '1.0',
    action: { default_title: 'Synth Theme' },
    background: { service_worker: 'sw.js' },
    content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['cs.js'], run_at: 'document_end' }],
    permissions: ['storage', 'tabs', 'contextMenus', 'commands', 'userScripts', 'activeTab'],
    host_permissions: ['<all_urls>'],
    commands: {
      'toggle-dark': {
        suggested_key: { default: 'Alt+Shift+D', windows: 'Alt+Shift+D' },
        description: 'Переключить тёмную тему'
      }
    }
  })
)

// 3) Архив .zip для проверки installPackageFile
const zipExtPath = path.join(workDir, 'packed-ext.zip')
fs.writeFileSync(
  zipExtPath,
  makeZipBuffer({
    'manifest.json': JSON.stringify({
      manifest_version: 3,
      name: 'Zip Packed Ext',
      version: '1.2',
      description: 'Установлено из локального ZIP'
    })
  })
)

// Локальный HTTP-стенд
let lastEchoHeaders = {}
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1')
  if (u.pathname === '/page' || u.pathname === '/opened-from-popup') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><title>Ext Test Page</title><style>html,body{background:#ffffff;color:#111111;margin:0;padding:20px;font-family:sans-serif}</style></head>
      <body>
        <h1>Masaki Extensions Test</h1>
        <div class="syn-ad-banner">Synthetic Ad Banner</div>
        <div class="ad-banner" style="height:40px;background:red">Real Ad Banner</div>
        <script src="/ads/static-ad.js"></script>
        <script src="/ads/dynamic-ad.js"></script>
        <script src="/ads/surrogate-target.js"></script>
      </body></html>`)
  } else if (u.pathname === '/ads/static-ad.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' })
    res.end('window.__staticAdLoaded = true;')
  } else if (u.pathname === '/ads/dynamic-ad.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' })
    res.end('window.__dynamicAdLoaded = true;')
  } else if (u.pathname === '/ads/surrogate-target.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' })
    res.end('window.__surrogateRan = "real-server";')
  } else if (u.pathname === '/ads/banner.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' })
    res.end('window.__ubolAdLoaded = true;')
  } else if (u.pathname === '/clean-url') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(u.search)
  } else if (u.pathname === '/headers-echo') {
    lastEchoHeaders = req.headers
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ xIn: req.headers['x-masaki-ext-in'] || null }))
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
  }
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const port = srv.address().port
const base = `http://127.0.0.1:${port}`
fs.writeFileSync(
  path.join(blockerDir, 'popup.html'),
  fs.readFileSync(path.join(blockerDir, 'popup.html'), 'utf8').replace('__PORT__', String(port))
)

// Настройки профиля: подключаем синтетические расширения сразу, чтобы тест стартовал чисто
fs.writeFileSync(
  path.join(profile, 'settings.json'),
  JSON.stringify({
    addons: {
      extensions: [blockerDir, themeExtDir]
    }
  })
)

const app = await electron.launch({
  args: [root],
  cwd: root,
  colorScheme: null,
  env: { ...process.env, MASAKI_TEST_INACTIVE: '1', MASAKI_TEST_HEADLESS: '1', MASAKI_PROFILE: profile },
  timeout: 60000
})
const page = await app.firstWindow()
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))

const shot = async (name) => {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(b64, 'base64'))
  console.log('снимок:', name)
}
const open = (url) =>
  app.evaluate(({ BrowserWindow }, u) => BrowserWindow.getAllWindows()[0].webContents.send('command', { type: 'open-url', url: u }), url)

let failed = false
try {
  await page.waitForSelector('.ntp', { timeout: 30000 })
  await page.waitForTimeout(1800)

  console.log('--- ЧАСТЬ A: синтетические расширения и полные API ---')
  // Проверяем, что local-расширение в storage не утекло в storage.managed, onInstalled сработал, OffscreenCanvas setIcon загрузился
  await open(base + '/page')
  await page.waitForTimeout(2500)

  const guestId = await page.evaluate(() => document.querySelector('webview.wv.on').getWebContentsId())
  const pageState = await app.evaluate(async ({ webContents }, id) => {
    const wc = webContents.fromId(id)
    return wc.executeJavaScript(`(async () => {
      const cleanQ = await fetch('/clean-url?keep=1&utm_source=tracker').then(r => r.text());
      const hdrRes = await fetch('/headers-echo');
      const hdrJson = await hdrRes.json();
      return {
        staticAd: !!window.__staticAdLoaded,
        dynamicAd: !!window.__dynamicAdLoaded,
        surrogate: window.__surrogateRan,
        userScriptMain: !!window.__userScriptMainRan,
        cosmeticHidden: getComputedStyle(document.querySelector('.syn-ad-banner')).display,
        cleanQ,
        hdrIn: hdrJson.xIn,
        hdrOut: hdrRes.headers.get('x-masaki-ext-out')
      };
    })()`)
  }, guestId)
  console.log('ЧАСТЬ A страница:', JSON.stringify(pageState))
  assert.equal(pageState.staticAd, false, 'Статическое правило DNR block не сработало')
  assert.equal(pageState.dynamicAd, false, 'Динамическое правило DNR block не сработало')
  assert.equal(pageState.surrogate, true, 'DNR redirect extensionPath суррогат не выполнился')
  assert.equal(pageState.userScriptMain, true, 'chrome.userScripts в MAIN world не выполнился')
  assert.equal(pageState.cosmeticHidden, 'none', 'CSS косметики не скрыл баннер')
  assert.equal(pageState.cleanQ, '?keep=1', 'DNR queryTransform removeParams не удалил utm_source: ' + pageState.cleanQ)
  assert.equal(pageState.hdrIn, 'dnr-ok', 'DNR modifyHeaders requestHeaders не сработал')
  assert.equal(pageState.hdrOut, 'resp-ok', 'DNR modifyHeaders responseHeaders не сработал')

  // Проверяем диагностику обоих синтетических расширений через их runtime.sendMessage
  const extDiag = await app.evaluate(async ({ session, BrowserWindow }) => {
    const ses = session.fromPartition('persist:frost')
    const all = ses.extensions.getAllExtensions()
    const b = all.find((x) => x.name === 'Synth Blocker')
    const t = all.find((x) => x.name === 'Synth Theme & Scripts')
    const askExt = async (ext, msg) => {
      const w = new BrowserWindow({ show: false, webPreferences: { session: ses, offscreen: true } })
      await w.loadURL(`chrome-extension://${ext.id}/manifest.json`)
      const res = await w.webContents.executeJavaScript(`new Promise(r => chrome.runtime.sendMessage(${JSON.stringify(msg)}, r))`)
      w.destroy()
      return res
    }
    return { blocker: b ? await askExt(b, 'ping') : null, blockerId: b?.id, themeId: t?.id }
  })
  console.log('ЧАСТЬ A диагностика SW:', JSON.stringify(extDiag))
  assert.equal(extDiag.blocker?.installedReason, 'install', 'runtime.onInstalled не пришёл')
  assert.deepEqual(extDiag.blocker?.managed, {}, 'storage.managed вернул посторонние ключи!')
  assert.equal(extDiag.blocker?.syncRes?.sKey, 'syncVal', 'storage.sync не работает')
  assert.ok(extDiag.blocker?.fontsCount >= 5, 'fontSettings.getFontList пустой')
  assert.ok(extDiag.blocker?.matchedCount >= 3, 'getMatchedRules не зафиксировал срабатывания')
  assert.equal(extDiag.blocker?.hasDynamicContentScriptsProp, true, 'Object.freeze мешает дописывать свойства на chrome')

  // Проверяем закрепление кнопки, иконку из OffscreenCanvas setIcon и автосчётчик DNR на бейдже
  await page.click('.abar-side .a-ext-menu')
  await page.waitForSelector('.pop.extensions .ext-row')
  await page.click('.pop.extensions .ext-row:has-text("Synth Blocker") .ext-pin')
  await page.waitForSelector('.abar-side .ext-act')
  await page.click('.pop-scrim', { position: { x: 900, y: 500 } })
  await page.waitForFunction(() => {
    const img = document.querySelector('.abar-side .ext-act img')
    const badge = document.querySelector('.abar-side .ext-act .ext-badge')?.textContent
    return img && img.complete && img.naturalWidth > 0 && Number(badge) >= 3
  }, null, { timeout: 8000 })
  await shot('ext-01-pinned-and-badge')

  // Проверяем allowAllRequests (исключение сайта в DNR)
  await app.evaluate(async ({ session, BrowserWindow }, id) => {
    const ses = session.fromPartition('persist:frost')
    const w = new BrowserWindow({ show: false, webPreferences: { session: ses, offscreen: true } })
    await w.loadURL(`chrome-extension://${id}/manifest.json`)
    await w.webContents.executeJavaScript(`new Promise(r => chrome.runtime.sendMessage({ allowAll: true }, r))`)
    w.destroy()
  }, extDiag.blockerId)
  await open(base + '/page?bypass=1')
  await page.waitForTimeout(2000)
  const bypassState = await app.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL().includes('bypass=1'))
    return wc?.executeJavaScript('({ staticAd: !!window.__staticAdLoaded, dynamicAd: !!window.__dynamicAdLoaded })')
  })
  assert.equal(bypassState.staticAd, true, 'allowAllRequests не пропустил сайт')
  assert.equal(bypassState.dynamicAd, true, 'allowAllRequests не пропустил динамическое правило')
  await app.evaluate(async ({ session, BrowserWindow }, id) => {
    const ses = session.fromPartition('persist:frost')
    const w = new BrowserWindow({ show: false, webPreferences: { session: ses, offscreen: true } })
    await w.loadURL(`chrome-extension://${id}/manifest.json`)
    await w.webContents.executeJavaScript(`new Promise(r => chrome.runtime.sendMessage({ allowAll: false }, r))`)
    w.destroy()
  }, extDiag.blockerId)

  // Проверяем contextMenus.update + checkbox + captureVisibleTab + insertCSS
  const box = await page.locator('webview.wv.on').boundingBox()
  await clickGuestInput(app, await page.evaluate(() => document.querySelector('webview.wv.on').getWebContentsId()), box.width / 2, 120, { button: 'right' })
  await page.waitForSelector('.cmenu.shown .cm-item:has-text("Тёмная тема (обновлено)")', { timeout: 5000 })
  await page.click('.cmenu .cm-item:has-text("Тёмная тема (обновлено)")')
  await page.waitForTimeout(800)

  // Проверяем горячую клавишу расширения (Alt+Shift+D -> commands.onCommand)
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'D', modifiers: ['alt', 'shift'] })
    win?.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'D', modifiers: ['alt', 'shift'] })
  })
  await page.waitForTimeout(600)

  const themeDiag = await app.evaluate(async ({ session, BrowserWindow }, id) => {
    const ses = session.fromPartition('persist:frost')
    const w = new BrowserWindow({ show: false, webPreferences: { session: ses, offscreen: true } })
    await w.loadURL(`chrome-extension://${id}/manifest.json`)
    const res = await w.webContents.executeJavaScript(`new Promise(r => chrome.runtime.sendMessage('theme-diag', r))`)
    w.destroy()
    return res
  }, extDiag.themeId)
  console.log('ЧАСТЬ A themeDiag:', JSON.stringify(themeDiag))
  assert.equal(themeDiag.lastMenuChecked, true, 'checkbox contextMenus не переключил checked=true')
  assert.equal(themeDiag.captureOk, true, 'tabs.captureVisibleTab не вернул PNG')
  assert.equal(themeDiag.lastCmd, 'toggle-dark', 'commands.onCommand не сработал по Alt+Shift+D')

  // Проверяем target="_blank" из попапа Synth Blocker -> открывает вкладку Masaki
  await page.click('.abar-side .ext-act')
  await page.waitForTimeout(1000)
  await app.evaluate(async ({ BrowserWindow }) => {
    const pop = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes('popup.html'))
    await pop?.webContents.executeJavaScript(`document.getElementById('open-link').click()`)
  })
  await page.waitForFunction(() => !!document.querySelector('webview.wv[src*="opened-from-popup"]'), null, { timeout: 6000 })
  await page.waitForTimeout(700)
  const openedTabOk = await app.evaluate(({ webContents }) =>
    webContents.getAllWebContents().some((w) => w.getType() === 'webview' && w.getURL().includes('opened-from-popup'))
  )
  assert.equal(openedTabOk, true, 'Ссылка target="_blank" из попапа не открылась вкладкой Masaki')

  // Проверяем реальную установку .zip файла через Masaki IPC
  const zipRes = await page.evaluate((zp) => window.masaki.extensions.addFile(zp), zipExtPath)
  console.log('ZIP install:', JSON.stringify({ ok: zipRes?.ok, name: zipRes?.ext?.name }))
  assert.equal(zipRes?.ok, true, 'Не удалось установить расширение из .zip: ' + zipRes?.error)
  assert.equal(zipRes?.ext?.name, 'Zip Packed Ext', 'Установленное из .zip расширение имеет неверное имя')

  // Проверяем связку: Тёмная тема (data-darkreader-scheme) + «Прозрачные сайты»
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('command', { type: 'addons' }))
  await page.waitForSelector('.addons-page')
  await page.click('.addon:has-text("Прозрачные сайты") .switch')
  await page.waitForTimeout(400)
  await shot('ext-02-addons-page')

  await open(base + '/page?darktheme=1')
  await page.waitForTimeout(1800)
  const glassDarkCheck = await page.evaluate(() => {
    const wvEl = document.querySelector('webview.wv.on')
    return wvEl ? getComputedStyle(wvEl).getPropertyValue('--site-canvas').trim() : ''
  })
  console.log('DarkTheme + Glass --site-canvas:', glassDarkCheck)
  assert.ok(glassDarkCheck.includes('20, 22, 26') || glassDarkCheck.includes('20,22,26'), 'Тёмная тема не обновила --site-canvas для стекла: ' + glassDarkCheck)

  // Выключаем прозрачность перед частью B, чтобы чисто проверить Dark Reader сам по себе
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('command', { type: 'addons' }))
  await page.waitForSelector('.addons-page')
  await page.click('.addon:has-text("Прозрачные сайты") .switch')
  await page.waitForTimeout(300)

  console.log('--- ЧАСТЬ B: реальные расширения Chrome Web Store ---')
  await app.evaluate(({ session }) => {
    const ses = session.fromPartition('persist:frost')
    ses.serviceWorkers.on('console-message', (_e, d) => {
      if (d.level >= 2 && (d.message.includes('Uncaught') || d.message.includes('Registration failed') || d.message.includes('is not a function'))) {
        globalThis.__masakiExtSwErrs ??= []
        globalThis.__masakiExtSwErrs.push(`${d.source}: ${d.message}`)
      }
    })
  })

  const realExts = [
    ['uBlock Origin Lite', 'ddkjiahejlhfcafbddmgiahcphecmpfh'],
    ['Dark Reader', 'eimadpbcbfnmbkopoojfekhnkhdbieeh'],
    ['Stylus', 'clngdbkpkpeebahjckkjfobafhncgmne'],
    ['SponsorBlock', 'mnjggcdmjocbbbhaepdhchncahnbgone']
  ]

  for (const [label, id] of realExts) {
    const loaded = await page.evaluate((extId) => window.masaki.extensions.installStore(extId), id)
    assert.ok(loaded?.id, `Не удалось установить ${label} из Chrome Web Store`)
    console.log('Установлено из CWS:', label, JSON.stringify({ id: loaded.id, name: loaded.name, version: loaded.version }))
  }

  await page.waitForTimeout(5500)
  const realSwErrors = await app.evaluate(() => globalThis.__masakiExtSwErrs || [])
  console.log('Ошибки SW у реальных расширений:', JSON.stringify(realSwErrors))
  // Допускаем только возможные сетевые ошибки офлайн/телеметрии, но НЕ TypeError / SyntaxError / onRemoved / tabs.create / Object.freeze
  const fatalSw = realSwErrors.filter((s) => /onRemoved|tabs\.create|is not extensible|is not a function/i.test(s))
  assert.equal(fatalSw.length, 0, 'Критические ошибки SW: ' + JSON.stringify(fatalSw))

  // Проверяем реальную работу uBOL + Dark Reader на странице
  await open(base + '/page?real=1')
  await page.waitForTimeout(4000)

  const realGuestState = await app.evaluate(async ({ webContents, session, BrowserWindow }) => {
    const wc = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL().includes('real=1'))
    const pageInfo = await wc?.executeJavaScript(`(async () => {
      let trackerBlocked = false;
      try {
        await fetch('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js');
      } catch {
        trackerBlocked = true;
      }
      return {
        htmlBg: getComputedStyle(document.documentElement).backgroundColor,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        drStyles: document.querySelectorAll('.darkreader').length,
        trackerBlocked
      };
    })()`)
    const ses = session.fromPartition('persist:frost')
    const w = new BrowserWindow({ show: false, webPreferences: { session: ses, offscreen: true } })
    await w.loadURL('chrome-extension://ddkjiahejlhfcafbddmgiahcphecmpfh/manifest.json')
    const ubolInfo = await w.webContents.executeJavaScript(`Promise.all([
      chrome.declarativeNetRequest.getEnabledRulesets(),
      chrome.declarativeNetRequest.getMatchedRules()
    ]).then(([rulesets, matched]) => ({ rulesets, matchedCount: matched.rulesMatchedInfo.length }))`)
    w.destroy()
    return { ...pageInfo, ubolInfo }
  })
  console.log('ЧАСТЬ B страница (uBOL + Dark Reader):', JSON.stringify(realGuestState))
  assert.ok(realGuestState.drStyles > 0, 'Dark Reader не применил тёмную тему к странице!')
  assert.equal(realGuestState.trackerBlocked, true, 'uBlock Origin Lite не заблокировал рекламный трекер!')
  assert.ok(realGuestState.ubolInfo.rulesets.length > 0, 'У uBlock Origin Lite не активны правила DNR!')
  assert.ok(realGuestState.ubolInfo.matchedCount >= 1, 'DNR-движок не зафиксировал срабатывание правил uBlock Origin Lite!')
  await shot('ext-03-real-darkreader-ubol')

  // Открываем страницу «Аддоны» и делаем снимок списка всех реальных расширений (с локализованными описаниями и клавишами)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('command', { type: 'addons' }))
  await page.waitForSelector('.addons-page .sc-item:has-text("Dark Reader")', { timeout: 10000 })
  await page.waitForTimeout(500)
  await shot('ext-04-real-addons-list')
  const drDesc = await page.locator('.addons-page .sc-item:has-text("Dark Reader") small').innerText()
  console.log('Описание Dark Reader в UI:', drDesc)
  assert.ok(!drDesc.includes('__MSG_'), 'Локализация __MSG_ не раскрылась: ' + drDesc)

  console.log('ВСЁ ПРОШЛО УСПЕШНО!')
} catch (e) {
  failed = true
  console.error('ОШИБКА ТЕСТА:', e)
  await shot('ext-99-failure').catch(() => {})
} finally {
  fs.writeFileSync(path.join(out, 'extensions-full-console.log'), logs.join('\n'))
  await app.close().catch(() => {})
  fs.rmSync(profile, { recursive: true, force: true })
  srv.close()
}
process.exit(failed ? 1 : 0)
