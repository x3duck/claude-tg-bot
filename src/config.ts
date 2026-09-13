import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

try {
  process.loadEnvFile(path.join(ROOT, '.env'))
} catch {
  // .env не обязателен — переменные могут прийти из systemd
}

function required(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`[config] не задана переменная окружения ${name} (см. .env.example)`)
    process.exit(1)
  }
  return v
}

export const BOT_TOKEN = required('BOT_TOKEN')

export const ALLOWED_USER_IDS = new Set(
  (process.env.ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n)),
)

if (ALLOWED_USER_IDS.size === 0) {
  console.error('[config] ALLOWED_USER_IDS пуст — бот никого не пустит. Укажи свой Telegram user id.')
  process.exit(1)
}

export const WORKSPACES_DIR = process.env.WORKSPACES_DIR ?? path.join(ROOT, 'workspaces')
export const DATA_FILE = process.env.DATA_FILE ?? path.join(ROOT, 'data', 'state.json')
export const WEB_PORT = Number(process.env.WEB_PORT ?? 3100)
export const PUBLIC_URL = (process.env.PUBLIC_URL ?? '').replace(/\/$/, '')

export const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? 'claude-opus-5'

export const MODELS: { id: string; label: string }[] = [
  { id: 'claude-fable-5', label: 'Fable 5 — самая сильная, дорогая' },
  { id: 'claude-opus-5', label: 'Opus 5 — максимум качества' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5 — быстрее и дешевле' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 — самый быстрый' },
]

/** Где живут OAuth-креды CLI — оттуда берётся токен для запроса лимитов подписки. */
export const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
export const CREDENTIALS_FILE =
  process.env.CLAUDE_CREDENTIALS_FILE ?? path.join(CLAUDE_CONFIG_DIR, '.credentials.json')
export const USAGE_URL = process.env.CLAUDE_USAGE_URL ?? 'https://api.anthropic.com/api/oauth/usage'
export const USAGE_TIMEOUT_MS = 15_000

/** Лимит Bot API на отправку документа. */
export const MAX_SEND_BYTES = 50 * 1024 * 1024
/** Лимит Bot API на скачивание присланного файла. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024

/** Безопасный размер куска текста (лимит Telegram — 4096 символов). */
export const CHUNK_LIMIT = 3000

/** Как часто перерисовывать сообщение с прогрессом. */
export const PROGRESS_INTERVAL_MS = 2000

/** Сколько последних строк лога показывать в прогрессе. */
export const PROGRESS_TAIL = 12

export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  '.next',
  '.cache',
  'target',
  '.claude',
])
