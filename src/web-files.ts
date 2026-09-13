import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { IGNORED_DIRS, WORKSPACES_DIR } from './config.ts'
import { safeName } from './workspace.ts'
import type { Workspace } from './workspace.ts'

export type FileContext = { workspace: Workspace; cwd: string }
export type FileRoot = 'workspace' | 'cwd'
export type PreviewKind = 'text' | 'markdown' | 'image' | 'pdf'
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
}
const TEXT_TYPES = new Set(['.txt', '.csv', '.tsv', '.json', '.js', '.ts', '.tsx', '.jsx', '.css', '.html', '.xml', '.yaml', '.yml', '.toml', '.py', '.sh', '.sql', '.log'])

export function previewType(name: string): { kind: PreviewKind; mime: string; maxBytes: number } | null {
  const ext = path.extname(name).toLowerCase()
  if (IMAGE_TYPES[ext]) return { kind: 'image', mime: IMAGE_TYPES[ext], maxBytes: MAX_UPLOAD_BYTES }
  if (ext === '.pdf') return { kind: 'pdf', mime: 'application/pdf', maxBytes: MAX_UPLOAD_BYTES }
  if (ext === '.md' || ext === '.markdown') return { kind: 'markdown', mime: 'text/plain; charset=utf-8', maxBytes: 1024 * 1024 }
  if (TEXT_TYPES.has(ext)) return { kind: 'text', mime: 'text/plain; charset=utf-8', maxBytes: 1024 * 1024 }
  return null
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

function rootPath(context: FileContext, root: string): string {
  if (root !== 'workspace' && root !== 'cwd') throw new Error('Неизвестная рабочая папка')
  return fs.realpathSync(root === 'workspace' ? context.workspace.root : context.cwd)
}

function resolveEntry(context: FileContext, root: string, relative: string): string {
  const base = rootPath(context, root)
  if (relative.length > 4096 || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0')) {
    throw new Error('Недопустимый путь')
  }
  const parts = relative ? relative.split('/') : []
  if (parts.some((part) => !part || part === '.' || part === '..' || (part.startsWith('.') && part !== '.sent') || IGNORED_DIRS.has(part))) {
    throw new Error('Недопустимый путь')
  }
  let target = base
  for (const part of parts) {
    target = path.join(target, part)
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Символические ссылки недоступны')
  }
  const real = fs.realpathSync(target)
  if (!inside(base, real)) throw new Error('Файл вне рабочей папки')
  const workspace = fs.realpathSync(context.workspace.root)
  const workspaces = fs.realpathSync(WORKSPACES_DIR)
  if (inside(workspaces, real) && !inside(workspace, real)) throw new Error('Папка другого треда недоступна')
  return real
}

function fileId(base: string, root: string, relative: string): string {
  return Buffer.from(JSON.stringify([root, relative, createHash('sha256').update(base).digest('hex').slice(0, 16)])).toString('base64url')
}

export function browseFiles(context: FileContext, root: string, relative: string, offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Некорректная страница')
  const directory = resolveEntry(context, root, relative)
  if (!fs.statSync(directory).isDirectory()) throw new Error('Папка не найдена')
  const base = rootPath(context, root)
  const entries = fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isFile() && !entry.isDirectory()) return []
    const relativePath = relative ? `${relative}/${entry.name}` : entry.name
    try {
      const target = resolveEntry(context, root, relativePath)
      const stat = fs.statSync(target)
      const kind = stat.isDirectory() ? 'directory' as const : 'file' as const
      return [{ id: fileId(base, root, relativePath), name: entry.name, kind, path: relativePath,
        size: stat.size, mtime: stat.mtimeMs, preview: kind === 'file' ? previewType(entry.name)?.kind ?? null : null }]
    } catch {
      return []
    }
  }).sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, 'ru', { numeric: true }))
  const end = offset + 100
  return { root, path: relative, parent: relative ? relative.split('/').slice(0, -1).join('/') : null,
    entries: entries.slice(offset, end), nextOffset: end < entries.length ? end : null }
}

export function resolveFile(context: FileContext, id: string): { path: string; name: string } {
  if (!/^[A-Za-z0-9_-]+$/.test(id) || id.length > 8192) throw new Error('Некорректный файл')
  let value: unknown
  try { value = JSON.parse(Buffer.from(id, 'base64url').toString('utf8')) } catch { throw new Error('Некорректный файл') }
  if (!Array.isArray(value) || value.length !== 3 || !value.every((part) => typeof part === 'string')) throw new Error('Некорректный файл')
  const [root, relative, fingerprint] = value as [string, string, string]
  const base = rootPath(context, root)
  if (fingerprint !== createHash('sha256').update(base).digest('hex').slice(0, 16)) throw new Error('Рабочая папка изменилась. Обнови список файлов')
  const target = resolveEntry(context, root, relative)
  if (!fs.statSync(target).isFile()) throw new Error('Файл не найден')
  return { path: target, name: path.basename(target) }
}

export function uploadFile(context: FileContext, requestedName: string, data: Buffer): { ok: true; name: string } {
  if (!requestedName.trim() || requestedName.includes('\0')) throw new Error('Укажи имя файла')
  if (data.length > MAX_UPLOAD_BYTES) throw new Error('Максимальный размер файла — 20 МБ')
  const inbox = resolveEntry(context, 'workspace', 'inbox')
  const name = `${randomUUID().slice(0, 8)}_${safeName(requestedName)}`
  const target = path.join(inbox, name)
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
  try {
    fs.writeFileSync(fd, data)
  } catch (error) {
    fs.closeSync(fd)
    fs.rmSync(target, { force: true })
    throw error
  }
  fs.closeSync(fd)
  return { ok: true, name }
}

export function openWebFile(file: { path: string; name: string }): { fd: number; size: number } {
  if (fs.realpathSync(file.path) !== file.path) throw new Error('Файл перемещён. Обнови список файлов')
  const fd = fs.openSync(file.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const stat = fs.fstatSync(fd)
    const current = fs.statSync(file.path)
    if (!stat.isFile() || stat.ino !== current.ino || stat.dev !== current.dev || fs.realpathSync(file.path) !== file.path) {
      throw new Error('Файл изменился. Обнови список файлов')
    }
    return { fd, size: stat.size }
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
}
