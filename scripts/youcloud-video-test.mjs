// Проверяет прокидку видеопотоков YouTube (yt-dlp, capability yt-video) и изоляцию кэша аудио/видео
// в изолированном профиле Masaki без обращений к настоящему YouTube и GitHub.
// После сборки (`npx electron-vite build`): node scripts/youcloud-video-test.mjs
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'masaki-yc-video-'))
const site = 'https://youcloud.inkerror67.workers.dev/'
const ytDir = path.join(profile, 'yt-dlp')
fs.mkdirSync(ytDir, { recursive: true })
const logFile = path.join(profile, 'ytdlp-calls.jsonl')

function goCommand() {
  for (const c of [process.env.GO, 'go', 'C:\\Program Files\\Go\\bin\\go.exe', '/usr/local/go/bin/go'].filter(Boolean)) {
    try {
      execFileSync(c, ['version'], { stdio: 'ignore' })
      return c
    } catch {
      // не этот путь
    }
  }
  throw new Error('Для стенда yt-dlp.exe в тесте нужен Go')
}

// Собираем нативный бинарный стенд yt-dlp, чтобы не зависеть от cmd.exe с символом «<» в аргументах.
const stubGo = path.join(profile, 'fake-yt-dlp.go')
const stubExe = path.join(ytDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
fs.writeFileSync(
  stubGo,
  `package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"
)

type call struct {
	ID     string \`json:"id"\`
	Format string \`json:"format"\`
	Live   bool   \`json:"live"\`
	Video  bool   \`json:"video"\`
}

func main() {
	args := os.Args[1:]
	var fmtArg, rawURL string
	for i := 0; i < len(args); i++ {
		if args[i] == "-f" && i+1 < len(args) {
			fmtArg = args[i+1]
			i++
		}
	}
	if len(args) > 0 {
		rawURL = args[len(args)-1]
	}
	u, _ := url.Parse(rawURL)
	id := ""
	if u != nil {
		id = u.Query().Get("v")
	}
	live := strings.Contains(fmtArg, "m3u8")
	video := strings.Contains(fmtArg, "bestvideo") || strings.Contains(fmtArg, "height<=720")
	entry, _ := json.Marshal(call{ID: id, Format: fmtArg, Live: live, Video: video})
	if logPath := os.Getenv("YOUCLOUD_TEST_LOG"); logPath != "" {
		f, _ := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if f != nil {
			_, _ = f.Write(append(entry, '\\n'))
			_ = f.Close()
		}
	}
	exp := time.Now().Unix() + 21600
	mode := "audio"
	if video {
		mode = "video"
	}
	if id == "livestream1" {
		if !live {
			fmt.Fprintln(os.Stderr, "ERROR: [youtube] "+id+": No video formats found!")
			os.Exit(1)
		}
		fmt.Printf("{\\"url\\":\\"https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/%d/id/%s.1/mode/%s/index.m3u8\\",\\"is_live\\":true}\\n", exp, id, mode)
		return
	}
	fmt.Printf("{\\"url\\":\\"https://rr1---sn-test.googlevideo.com/videoplayback?expire=%d&id=%s&mode=%s\\"}\\n", exp, id, mode)
}
`,
)
execFileSync(goCommand(), ['build', '-buildvcs=false', '-o', stubExe, stubGo], { cwd: profile, stdio: 'inherit' })
fs.writeFileSync(path.join(ytDir, 'state.json'), JSON.stringify({ checkedAt: Date.now(), sha256: 'fixture' }))

const env = {
  ...process.env,
  MASAKI_PROFILE: profile,
  MASAKI_TEST_INACTIVE: '1',
  MASAKI_TEST_HEADLESS: '1',
  YOUCLOUD_TEST_LOG: logFile,
}
delete env.ELECTRON_RUN_AS_NODE

const request = (data, responseKind = 'response') => `new Promise(resolve => {
  const id = Math.random().toString(36)
  const handler = (event) => {
    const data = event.data
    if (event.source !== window || event.origin !== location.origin || data?.yc !== 'ext' || data.kind !== ${JSON.stringify(responseKind)}) return
    if (data.kind === 'response' && data.id !== id) return
    clearTimeout(timer)
    removeEventListener('message', handler)
    resolve(data)
  }
  const timer = setTimeout(() => { removeEventListener('message', handler); resolve(null) }, 30_000)
  addEventListener('message', handler)
  postMessage({ yc: 'page', id, ...${JSON.stringify(data)} }, location.origin)
})`

const evaluateGuest = (origin, script) =>
  app.evaluate(
    ({ webContents }, args) => {
      const guest = webContents.getAllWebContents().find((wc) => wc.getType() === 'webview' && wc.getURL().startsWith(args.origin))
      return guest?.executeJavaScript(args.script, true)
    },
    { origin, script },
  )

async function until(check, label) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('Не дождались: ' + label)
}

const calls = () =>
  fs.existsSync(logFile)
    ? fs
        .readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []

let app
let server
try {
  const hostName = new URL(site).hostname
  const certFile = path.join(profile, 'cert.pem')
  const keyFile = path.join(profile, 'key.pem')
  const genCertGo = path.join(profile, 'gen-cert.go')
  fs.writeFileSync(
    genCertGo,
    `package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"time"
)

func main() {
	host, certOut, keyOut := os.Args[1], os.Args[2], os.Args[3]
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	tmpl := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "YouCloud Video Fixture"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{host},
	}
	der, _ := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	cf, _ := os.Create(certOut)
	_ = pem.Encode(cf, &pem.Block{Type: "CERTIFICATE", Bytes: der})
	_ = cf.Close()
	kf, _ := os.Create(keyOut)
	_ = pem.Encode(kf, &pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	_ = kf.Close()
}
`,
  )
  execFileSync(goCommand(), ['run', genCertGo, hostName, certFile, keyFile], { cwd: profile, stdio: 'ignore' })
  const cert = fs.readFileSync(certFile)
  const publicKey = new X509Certificate(cert).publicKey.export({ format: 'der', type: 'spki' })
  const fixtureKey = createHash('sha256').update(publicKey).digest('base64')

  server = createServer({ key: fs.readFileSync(keyFile), cert }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>YouCloud Video Fixture</title>')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))

  const hostRules = [`MAP ${hostName} 127.0.0.1:${server.address().port}`, 'MAP * ~NOTFOUND']
  const linux = process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless', '--disable-gpu'] : []
  app = await electron.launch({
    args: [...linux, '--no-proxy-server', '--host-resolver-rules=' + hostRules.join(','), '--ignore-certificate-errors-spki-list=' + fixtureKey, root],
    cwd: root,
    env,
    timeout: 45_000,
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.stage')

  await app.evaluate(({ BrowserWindow }, target) => {
    BrowserWindow.getAllWindows()[0].webContents.send('command', { type: 'open-url', url: target })
  }, site)
  await until(() => evaluateGuest(site, 'document.readyState === "complete"').catch(() => false), site)

  const ask = (data) => evaluateGuest(site, request(data))

  const hello = await evaluateGuest(site, request({ kind: 'ping' }, 'hello'))
  assert.equal(hello.host, 'masaki')
  assert.equal(hello.version, '0.13.0')
  assert.ok(hello.capabilities.includes('yt-video'), 'Мост 0.13.0 должен объявлять yt-video capability')

  // 1. Аудио-поток
  const audio1 = await ask({ kind: 'yt-stream', videoId: 'dQw4w9WgXcQ' })
  assert.match(audio1?.value?.url ?? '', /mode=audio/)
  assert.equal(calls().filter((c) => c.id === 'dQw4w9WgXcQ' && !c.video).length, 1)

  // 2. Видео-поток того же ролика: не бьёт аудио-кэш, передаёт <=720p видео-селектор
  const video1 = await ask({ kind: 'yt-stream', videoId: 'dQw4w9WgXcQ', video: true })
  assert.match(video1?.value?.url ?? '', /mode=video/)
  const vidCalls1 = calls().filter((c) => c.id === 'dQw4w9WgXcQ' && c.video)
  assert.equal(vidCalls1.length, 1)
  assert.match(vidCalls1[0].format, /bestvideo\[height<=720\]/)

  // 3. Повторный видео-запрос берётся из видео-кэша
  const video2 = await ask({ kind: 'yt-stream', videoId: 'dQw4w9WgXcQ', video: true })
  assert.equal(video2?.value?.url, video1?.value?.url)
  assert.equal(calls().filter((c) => c.id === 'dQw4w9WgXcQ' && c.video).length, 1)

  // 4. fresh=true для видео сбрасывает только видео-кэш, аудио-кэш сохраняется
  const videoFresh = await ask({ kind: 'yt-stream', videoId: 'dQw4w9WgXcQ', video: true, fresh: true })
  assert.match(videoFresh?.value?.url ?? '', /mode=video/)
  assert.equal(calls().filter((c) => c.id === 'dQw4w9WgXcQ' && c.video).length, 2)
  const audioCached = await ask({ kind: 'yt-stream', videoId: 'dQw4w9WgXcQ' })
  assert.equal(audioCached?.value?.url, audio1?.value?.url)
  assert.equal(calls().filter((c) => c.id === 'dQw4w9WgXcQ' && !c.video).length, 1)

  // 5. Прямой эфир (видео): HLS playlist + videoLiveArgs
  const liveVid = await ask({ kind: 'yt-stream', videoId: 'livestream1', live: true, video: true })
  assert.equal(liveVid?.value?.live, true)
  assert.match(liveVid?.value?.url ?? '', /\/mode\/video\/index\.m3u8$/)
  const liveCalls = calls().filter((c) => c.id === 'livestream1' && c.video && c.live)
  assert.equal(liveCalls.length, 1)
  assert.match(liveCalls[0].format, /height<=720.*m3u8/)

  console.log('Masaki YouCloud video bridge: capability 0.13.0, video/audio cache isolation, fresh reset and live HLS passed')
} finally {
  await app?.close()
  server?.close()
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 })
}
