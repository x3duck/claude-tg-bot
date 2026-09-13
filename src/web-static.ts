import fs from 'node:fs'
import path from 'node:path'
import type { ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WEB_ROOT = path.join(ROOT, 'web')
const PDF_ROOT = path.join(ROOT, 'node_modules', 'pdfjs-dist')
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm',
}

export function serveStatic(url: URL, res: ServerResponse): void {
  const pathname = decodeURIComponent(url.pathname)
  let root = WEB_ROOT
  let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  if (pathname.startsWith('/vendor/')) {
    root = PDF_ROOT
    const asset = pathname.slice('/vendor/pdfjs/'.length)
    if (!pathname.startsWith('/vendor/pdfjs/')) relative = ''
    else if (asset === 'pdf.mjs') relative = 'build/pdf.min.mjs'
    else if (asset === 'pdf.worker.mjs') relative = 'build/pdf.worker.min.mjs'
    else if (/^cmaps\/[\w.-]+\.bcmap$/.test(asset)
      || /^standard_fonts\/[\w-]+\.(pfb|ttf)$/.test(asset)
      || /^wasm\/(?:jbig2|openjpeg|qcms_bg)\.wasm$/.test(asset)
      || /^wasm\/(?:jbig2|openjpeg)_nowasm_fallback\.js$/.test(asset)) relative = asset
    else relative = ''
  }
  try {
    if (!relative) throw new Error('Not found')
    const base = fs.realpathSync(root)
    const file = fs.realpathSync(path.resolve(base, relative))
    if (!file.startsWith(base + path.sep) || !fs.statSync(file).isFile()) throw new Error('Not found')
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    })
    const stream = fs.createReadStream(file)
    stream.on('error', () => res.destroy())
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  } catch {
    res.writeHead(404).end()
  }
}
