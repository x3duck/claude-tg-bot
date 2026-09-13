import http from 'node:http'
import { serveStatic } from '../src/web-static.ts'

const port = Number(process.env.PREVIEW_PORT || 3101)
http.createServer((req, res) => {
  try { serveStatic(new URL(req.url, 'http://localhost'), res) }
  catch { res.writeHead(404).end() }
}).listen(port, '127.0.0.1', () => console.log(`Mini App demo: http://127.0.0.1:${port}/?demo=1`))
