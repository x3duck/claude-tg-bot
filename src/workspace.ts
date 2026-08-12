import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { BOT_TOKEN, IGNORED_DIRS, MAX_DOWNLOAD_BYTES, MAX_SEND_BYTES, WORKSPACES_DIR } from './config.ts'

export type Workspace = {
  root: string
  inbox: string
  outbox: string
  sent: string
}

export function workspaceFor(chatId: number): Workspace {
  const root = path.join(WORKSPACES_DIR, String(chatId))
  const ws: Workspace = {
    root,
    inbox: path.join(root, 'inbox'),
    outbox: path.join(root, 'outbox'),
    sent: path.join(root, 'outbox', '.sent'),
  }
  fs.mkdirSync(ws.inbox, { recursive: true })
  fs.mkdirSync(ws.sent, { recursive: true })
  return ws
}

/** Убирает из имени всё, что может увести запись за пределы папки. */
export function safeName(name: string): string {
  const base = path.basename(name).replace(/[^\w.()\[\]\-\u0400-\u04FF]+/gu, '_').replace(/^\.+/, '')
  return base.length > 0 && base !== '.' && base !== '..' ? base.slice(0, 120) : 'file'
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_')
}

export type IncomingFile = {
  fileId: string
  name: string
  size?: number
  kind: string
}

export type DownloadedFile = {
  path: string
  name: string
  kind: string
}

/** Скачивает файл из Telegram в inbox рабочей папки. */
export async function downloadIncoming(
  getFile: (fileId: string) => Promise<{ file_path?: string; file_size?: number }>,
  file: IncomingFile,
  ws: Workspace,
): Promise<DownloadedFile> {
  if (file.size && file.size > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `файл «${file.name}» весит ${fmtSize(file.size)} — Bot API отдаёт максимум ${fmtSize(MAX_DOWNLOAD_BYTES)}`,
    )
  }

  const meta = await getFile(file.fileId)
  if (!meta.file_path) throw new Error(`Telegram не вернул путь к файлу «${file.name}»`)

  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${meta.file_path}`
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`не удалось скачать «${file.name}»: HTTP ${res.status}`)

  const ext = path.extname(file.name) || path.extname(meta.file_path)
  const stem = path.basename(safeName(file.name), ext) || file.kind
  let dest = path.join(ws.inbox, `${stamp()}_${stem}${ext}`)
  let i = 1
  while (fs.existsSync(dest)) dest = path.join(ws.inbox, `${stamp()}_${stem}_${i++}${ext}`)

  await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(dest))
  return { path: dest, name: path.basename(dest), kind: file.kind }
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function walk(dir: string, out: string[], depth = 0): void {
  if (depth > 6) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.sent') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue
      walk(full, out, depth + 1)
    } else if (e.isFile()) {
      out.push(full)
    }
  }
}

export type Artifact = {
  path: string
  size: number
  source: 'outbox' | 'mentioned'
}

/**
 * Собирает файлы-результаты: всё свежее из outbox плюс файлы, которые модель
 * явно назвала в финальном ответе.
 */
export function collectArtifacts(ws: Workspace, cwd: string, since: number, finalText: string): Artifact[] {
  const found = new Map<string, Artifact>()

  const outboxFiles: string[] = []
  walk(ws.outbox, outboxFiles)
  for (const f of outboxFiles) {
    if (f.startsWith(ws.sent + path.sep)) continue
    const st = safeStat(f)
    if (!st) continue
    if (st.mtimeMs + 1000 < since) continue
    found.set(f, { path: f, size: st.size, source: 'outbox' })
  }

  for (const candidate of mentionedPaths(finalText, cwd, ws.root)) {
    if (found.has(candidate)) continue
    const st = safeStat(candidate)
    if (!st || !st.isFile()) continue
    if (st.mtimeMs + 1000 < since) continue
    if (st.size === 0 || st.size > MAX_SEND_BYTES) continue
    found.set(candidate, { path: candidate, size: st.size, source: 'mentioned' })
  }

  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path))
}

function safeStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p)
  } catch {
    return null
  }
}

/** Достаёт из текста пути, которые лежат внутри рабочей директории или workspace. */
function mentionedPaths(text: string, cwd: string, wsRoot: string): string[] {
  const roots = [path.resolve(cwd), path.resolve(wsRoot)]
  const out = new Set<string>()
  const re = /[`"'(\s]([~./\w][\w./\-]*\.[A-Za-z0-9]{1,8})[`"')\s.,;:]/g
  const padded = ` ${text} `
  let m: RegExpExecArray | null
  while ((m = re.exec(padded)) !== null) {
    const raw = m[1]
    if (!raw || raw.length > 300) continue
    for (const root of roots) {
      const abs = path.resolve(root, raw.replace(/^~\//, ''))
      if (abs !== root && !abs.startsWith(root + path.sep)) continue
      if (abs.split(path.sep).some((seg) => IGNORED_DIRS.has(seg))) continue
      out.add(abs)
    }
  }
  return [...out]
}

/** Убирает отправленный файл из outbox, чтобы он не улетел повторно. */
export function markSent(ws: Workspace, file: string): void {
  if (!file.startsWith(ws.outbox + path.sep)) return
  const rel = path.relative(ws.outbox, file)
  const dest = path.join(ws.sent, rel)
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.renameSync(file, dest)
  } catch {
    // не критично: файл просто останется на месте
  }
}

/** Проверяет, что путь не уводит за пределы рабочей папки чата. */
export function insideWorkspace(ws: Workspace, target: string): boolean {
  const abs = path.resolve(target)
  return abs === ws.root || abs.startsWith(ws.root + path.sep)
}

/** Удаляет файл. Всё, что лежит вне рабочей папки чата, трогать отказывается. */
export function removeFile(ws: Workspace, target: string): void {
  if (!insideWorkspace(ws, target)) {
    throw new Error('файл вне рабочей папки чата — удалять отказываюсь')
  }
  fs.rmSync(path.resolve(target), { force: true })
}

/** Чистит inbox и outbox (включая уже отправленное). Возвращает число удалённых файлов. */
export function clearWorkspaceFiles(ws: Workspace): number {
  let removed = 0
  for (const dir of [ws.inbox, ws.outbox]) {
    const files: string[] = []
    walk(dir, files)
    for (const f of files) {
      try {
        fs.rmSync(f, { force: true })
        removed += 1
      } catch {
        // пропускаем то, что не удалось удалить
      }
    }
  }
  fs.mkdirSync(ws.sent, { recursive: true })
  return removed
}

export type ListedFile = { path: string; size: number; mtime: number; sent: boolean }

/**
 * Список файлов рабочей папки для команды /files.
 * Уже отправленные файлы показываются тоже — они никуда не делись,
 * просто лежат в outbox/.sent, чтобы не уйти в чат второй раз.
 */
export function listFiles(ws: Workspace, cwd: string): ListedFile[] {
  const files: string[] = []
  walk(ws.outbox, files)
  const inCwd: string[] = []
  walk(cwd, inCwd, 4)
  for (const f of inCwd) if (!files.includes(f)) files.push(f)

  return files
    .map((f) => {
      const st = safeStat(f)
      return st ? { path: f, size: st.size, mtime: st.mtimeMs, sent: f.startsWith(ws.sent + path.sep) } : null
    })
    .filter((x): x is ListedFile => x !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 30)
}
