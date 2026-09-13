import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { serveStatic } from './web-static.ts'
import { MAX_UPLOAD_BYTES, openWebFile, previewType } from './web-files.ts'

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
  listFiles: (userId: number, scopeId: string, root: string, relative: string, offset: number) => Promise<unknown>
  uploadFile: (userId: number, scopeId: string, name: string, data: Buffer) => Promise<unknown>
}

const DOWNLOAD_TTL_MS = 60_000

function authenticate(header: string | undefined, botToken: string, allowedUsers: Set<number>): number | null {
  if (!header?.startsWith('tma ')) return null
  const raw = header.slice(4)
  const params = new URLSearchParams(raw)
  const hash = params.get('hash')
  const authDate = Number(params.get('auth_date'))
  const userRaw = params.get('user')
  if (!hash || !/^[a-fA-F0-9]{64}$/.test(hash) || !authDate || !userRaw || Math.abs(Date.now() / 1000 - authDate) > 86_400) return null
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

async function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > maxBytes) {
      req.resume()
      throw new Error('Файл или тело запроса слишком большое')
    }
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req, 65_536)
  const value: unknown = raw.length ? JSON.parse(raw.toString('utf8')) : {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Ожидается JSON-объект')
  return value as Record<string, unknown>
}

function sendFile(res: http.ServerResponse, file: { path: string; name: string }, preview = false): void {
  const type = preview ? previewType(file.name) : null
  if (preview && !type) throw new Error('Предпросмотр этого формата недоступен. Скачай файл')
  const { fd, size } = openWebFile(file)
  if (type && size > type.maxBytes) {
    fs.closeSync(fd)
    throw new Error('Файл слишком большой для предпросмотра. Скачай его')
  }
  res.writeHead(200, {
    'content-type': type?.mime ?? 'application/octet-stream',
    'content-length': size,
    'content-disposition': `${preview ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; sandbox",
  })
  if (!size) {
    fs.closeSync(fd)
    res.end()
    return
  }
  const stream = fs.createReadStream(file.path, { fd, autoClose: true, start: 0, end: size - 1 })
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}


export function startWebServer(bridge: WebBridge): http.Server {
  const downloads = new Map<string, { userId: number; scopeId: string; fileId: string; expiresAt: number }>()
  const server = http.createServer(async (req, res) => {
    req.setTimeout(30_000, () => req.destroy())
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/health') {
        sendJson(res, 200, { ok: true })
        return
      }
      const downloadMatch = url.pathname.match(/^\/download\/([a-f0-9]{64})$/)
      if (req.method === 'GET' && downloadMatch) {
        const token = downloadMatch[1]!
        const download = downloads.get(token)
        if (!download || download.expiresAt < Date.now()) {
          downloads.delete(token)
          res.writeHead(404).end()
          return
        }
        try {
          if (!bridge.allowedUsers.has(download.userId)) throw new Error('Доступ закрыт')
          const file = await bridge.getFile(download.userId, download.scopeId, download.fileId)
          sendFile(res, file)
        } catch {
          downloads.delete(token)
          res.writeHead(404).end()
        }
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
      const filesMatch = url.pathname.match(/^\/api\/topics\/([^/]+)\/files$/)
      if (filesMatch && req.method === 'GET') {
        sendJson(res, 200, await bridge.listFiles(userId, decodeURIComponent(filesMatch[1]!),
          url.searchParams.get('root') ?? 'workspace', url.searchParams.get('path') ?? '', Number(url.searchParams.get('offset') ?? 0)))
        return
      }
      if (filesMatch && req.method === 'POST') {
        const data = await readBody(req, MAX_UPLOAD_BYTES)
        sendJson(res, 200, await bridge.uploadFile(userId, decodeURIComponent(filesMatch[1]!), url.searchParams.get('name') ?? '', data))
        return
      }
      const fileMatch = url.pathname.match(/^\/api\/topics\/([^/]+)\/files\/([^/]+)(\/preview)?$/)
      if (req.method === 'GET' && fileMatch) {
        const file = await bridge.getFile(userId, decodeURIComponent(fileMatch[1]!), decodeURIComponent(fileMatch[2]!))
        sendFile(res, file, Boolean(fileMatch[3]))
        return
      }
      if (req.method === 'POST' && fileMatch && !fileMatch[3]) {
        const scopeId = decodeURIComponent(fileMatch[1]!)
        const fileId = decodeURIComponent(fileMatch[2]!)
        await bridge.getFile(userId, scopeId, fileId)
        const now = Date.now()
        for (const [token, download] of downloads) {
          if (download.expiresAt < now) downloads.delete(token)
        }
        if (downloads.size >= 1000) downloads.delete(downloads.keys().next().value!)
        const token = randomBytes(32).toString('hex')
        downloads.set(token, { userId, scopeId, fileId, expiresAt: now + DOWNLOAD_TTL_MS })
        sendJson(res, 200, { url: `/download/${token}` })
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
      if (res.headersSent) res.destroy()
      else sendJson(res, 400, { error: message })
    }
  })
  server.listen(bridge.port, '127.0.0.1', () => console.log(`[web] http://127.0.0.1:${bridge.port}`))
  return server
}
