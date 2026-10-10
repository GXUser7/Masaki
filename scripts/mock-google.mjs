// Подставной Google для test:sync: вход OAuth (сразу «разрешить»), выдача токенов и папка приложения
// на Диске (appDataFolder) в памяти. Настоящий Google в автотестах не трогаем.
import crypto from 'node:crypto'
import http from 'node:http'

export async function startMockGoogle() {
  const files = new Map() // id → { id, name, modifiedTime, body }
  const codes = new Map() // code → challenge
  const refresh = new Set()
  const tokens = new Set()
  let clock = Date.now()
  const stamp = () => new Date((clock = Math.max(clock + 1, Date.now()))).toISOString()
  const log = []
  const email = 'masaki.tester@example.com'

  const b64url = (s) => Buffer.from(s).toString('base64url')
  const idToken = () => `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ email, name: 'Тестовый Аккаунт', picture: '' }))}.`

  const read = (req) =>
    new Promise((resolve) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
  const json = (res, code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }
  const meta = (f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime })

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x')
    const body = await read(req)
    log.push(`${req.method} ${u.pathname}`)

    // Обычная страница — для проверки вкладок с других устройств.
    if (u.pathname.startsWith('/page/')) {
      const title = decodeURIComponent(u.pathname.slice(6))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:20px sans-serif;padding:40px">${title}</body>`)
    }

    if (u.pathname === '/o/oauth2/v2/auth') {
      const code = crypto.randomBytes(8).toString('hex')
      codes.set(code, u.searchParams.get('code_challenge'))
      if (!u.searchParams.get('scope')?.includes('drive.appdata')) return json(res, 400, { error: 'no scope' })
      const back = new URL(u.searchParams.get('redirect_uri'))
      back.searchParams.set('state', u.searchParams.get('state'))
      back.searchParams.set('code', code)
      res.writeHead(302, { Location: back.toString() })
      return res.end()
    }

    if (u.pathname === '/token') {
      const p = new URLSearchParams(body)
      if (p.get('client_secret') !== 'test-secret') return json(res, 401, { error: 'invalid_client' })
      if (p.get('grant_type') === 'authorization_code') {
        const challenge = codes.get(p.get('code'))
        codes.delete(p.get('code'))
        const ok = challenge && crypto.createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url') === challenge
        if (!ok) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE' })
        const rt = 'rt-' + crypto.randomBytes(6).toString('hex')
        const at = 'at-' + crypto.randomBytes(6).toString('hex')
        refresh.add(rt)
        tokens.add(at)
        return json(res, 200, {
          access_token: at,
          refresh_token: rt,
          expires_in: 3600,
          scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.appdata',
          id_token: idToken()
        })
      }
      if (p.get('grant_type') === 'refresh_token') {
        if (!refresh.has(p.get('refresh_token'))) return json(res, 400, { error: 'invalid_grant' })
        const at = 'at-' + crypto.randomBytes(6).toString('hex')
        tokens.add(at)
        return json(res, 200, { access_token: at, expires_in: 3600 })
      }
      return json(res, 400, { error: 'unsupported_grant_type' })
    }

    if (u.pathname === '/revoke') {
      refresh.delete(new URLSearchParams(body).get('token'))
      return json(res, 200, {})
    }

    const auth = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    if (u.pathname.startsWith('/drive/') || u.pathname.startsWith('/upload/')) {
      if (!tokens.has(auth)) return json(res, 401, { error: { message: 'Invalid Credentials' } })
    }

    if (u.pathname === '/drive/v3/files' && req.method === 'GET') {
      if (u.searchParams.get('spaces') !== 'appDataFolder') return json(res, 400, { error: { message: 'spaces' } })
      return json(res, 200, { files: [...files.values()].map(meta) })
    }
    const fileMatch = u.pathname.match(/^\/drive\/v3\/files\/([\w-]+)$/)
    if (fileMatch) {
      const f = files.get(fileMatch[1])
      if (req.method === 'DELETE') {
        files.delete(fileMatch[1])
        res.writeHead(f ? 204 : 404)
        return res.end()
      }
      if (!f) return json(res, 404, { error: { message: 'File not found' } })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(f.body)
    }
    if (u.pathname === '/upload/drive/v3/files' && req.method === 'POST') {
      const boundary = /boundary=([^;]+)/.exec(req.headers['content-type'] ?? '')?.[1]
      const parts = body.split('--' + boundary).slice(1, -1).map((part) => part.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, ''))
      const m = JSON.parse(parts[0])
      if (!m.parents?.includes('appDataFolder')) return json(res, 400, { error: { message: 'parents' } })
      const f = { id: 'f' + crypto.randomBytes(5).toString('hex'), name: m.name, modifiedTime: stamp(), body: parts[1] }
      files.set(f.id, f)
      return json(res, 200, meta(f))
    }
    const upMatch = u.pathname.match(/^\/upload\/drive\/v3\/files\/([\w-]+)$/)
    if (upMatch && req.method === 'PATCH') {
      const f = files.get(upMatch[1])
      if (!f) return json(res, 404, { error: { message: 'File not found' } })
      f.body = body
      f.modifiedTime = stamp()
      return json(res, 200, meta(f))
    }
    json(res, 404, { error: { message: 'not mocked: ' + req.method + ' ' + u.pathname } })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`
  return {
    url,
    log,
    file: (name) => {
      const f = [...files.values()].find((x) => x.name === name)
      return f ? JSON.parse(f.body) : null
    },
    names: () => [...files.values()].map((f) => f.name).sort(),
    /** Как будто пользователь отозвал доступ в аккаунте Google. */
    revokeAll: () => {
      refresh.clear()
      tokens.clear()
    },
    close: () => new Promise((r) => server.close(r))
  }
}
