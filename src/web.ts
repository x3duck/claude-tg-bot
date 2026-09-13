import { createHmac, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type WebBridge = {
  port: number
  botToken: string
  allowedUsers: Set<number>
  getOverview: (userId: number, refreshStatus: boolean) => Promise<unknown>
  createTopic: (userId: number, name: string) => Promise<unknown>
  deleteAllTopics: (userId: number) => Promise<unknown>
  patchTopic: (userId: number, scopeId: string, patch: Record<string, unknown>) => Promise<unknown>
  deleteTopic: (userId: number, scopeId: string) => Promise<unknown>
  stopTopic: (userId: number, scopeId: string) => Promise<unknown>
  newSession: (userId: number, scopeId: string) => Promise<unknown>
  getFile: (userId: number, scopeId: string, fileId: string) => Promise<{ path: string; name: string }>
}

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

function authenticate(header: string | undefined, botToken: string, allowedUsers: Set<number>): number | null {
  if (!header?.startsWith('tma ')) return null
  const raw = header.slice(4)
  const params = new URLSearchParams(raw)
  const hash = params.get('hash')
  const authDate = Number(params.get('auth_date'))
  const userRaw = params.get('user')
  if (!hash || !authDate || !userRaw || Math.abs(Date.now() / 1000 - authDate) > 86_400) return null
  params.delete('hash')
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest()
  const expected = createHmac('sha256', secret).update(check).digest()
  let actual: Buffer
  try {
    actual = Buffer.from(hash, 'hex')
  } catch {
    return null
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
  try {
    const user = JSON.parse(userRaw) as { id?: number }
    return user.id && allowedUsers.has(user.id) ? user.id : null
  } catch {
    return null
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk.toString()
    if (raw.length > 65_536) throw new Error('Тело запроса слишком большое')
  }
  return raw ? JSON.parse(raw) as Record<string, unknown> : {}
}

function serveStatic(url: URL, res: http.ServerResponse): void {
  const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '')
  const file = path.resolve(WEB_ROOT, relative)
  if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + path.sep)) {
    res.writeHead(403).end()
    return
  }
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    res.writeHead(404).end()
    return
  }
  if (!stat.isFile()) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  fs.createReadStream(file).pipe(res)
}

export function startWebServer(bridge: WebBridge): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/health') {
      sendJson(res, 200, { ok: true })
      return
    }
    if (!url.pathname.startsWith('/api/')) {
      serveStatic(url, res)
      return
    }

    const userId = authenticate(req.headers.authorization, bridge.botToken, bridge.allowedUsers)
    if (!userId) {
      sendJson(res, 401, { error: 'Открой Mini App через Telegram' })
      return
    }

    try {
      if (req.method === 'GET' && url.pathname === '/api/overview') {
        sendJson(res, 200, await bridge.getOverview(userId, url.searchParams.get('refresh') === 'status'))
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/topics') {
        const body = await readJson(req)
        sendJson(res, 200, await bridge.createTopic(userId, typeof body.name === 'string' ? body.name : ''))
        return
      }
      if (req.method === 'DELETE' && url.pathname === '/api/topics') {
        sendJson(res, 200, await bridge.deleteAllTopics(userId))
        return
      }
      const fileMatch = url.pathname.match(/^\/api\/topics\/([^/]+)\/files\/([^/]+)$/)
      if (req.method === 'GET' && fileMatch) {
        const file = await bridge.getFile(userId, decodeURIComponent(fileMatch[1]!), decodeURIComponent(fileMatch[2]!))
        const stat = fs.statSync(file.path)
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': stat.size,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        fs.createReadStream(file.path).pipe(res)
        return
      }
      const match = url.pathname.match(/^\/api\/topics\/([^/]+)(?:\/(stop|new-session))?$/)
      if (match) {
        const scopeId = decodeURIComponent(match[1]!)
        const action = match[2]
        if (req.method === 'PATCH' && !action) {
          sendJson(res, 200, await bridge.patchTopic(userId, scopeId, await readJson(req)))
          return
        }
        if (req.method === 'DELETE' && !action) {
          sendJson(res, 200, await bridge.deleteTopic(userId, scopeId))
          return
        }
        if (req.method === 'POST' && action === 'stop') {
          sendJson(res, 200, await bridge.stopTopic(userId, scopeId))
          return
        }
        if (req.method === 'POST' && action === 'new-session') {
          sendJson(res, 200, await bridge.newSession(userId, scopeId))
          return
        }
      }
      sendJson(res, 404, { error: 'Не найдено' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sendJson(res, 400, { error: message })
    }
  })
  server.listen(bridge.port, '127.0.0.1', () => console.log(`[web] http://127.0.0.1:${bridge.port}`))
  return server
}
