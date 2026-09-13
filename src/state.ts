import fs from 'node:fs'
import path from 'node:path'
import { DATA_FILE, DEFAULT_MODEL } from './config.ts'

export type SessionRecord = {
  id: string
  title: string
  startedAt: string
  cwd: string
}

/** Что бот потратил: копится по чату целиком и отдельно по текущей сессии. */
export type UsageTotals = {
  runs: number
  costUsd: number
  inputTokens: number
  outputTokens: number
  durationMs: number
}

export type ChatState = {
  cwd: string | null
  model: string
  verbose: boolean
  topicName?: string
  topicNameImplicit?: boolean
  pinned?: boolean
  lastActivityAt?: string
  sessionId: string | null
  sessions: SessionRecord[]
  usage: { session: UsageTotals; total: UsageTotals }
}

function emptyTotals(): UsageTotals {
  return { runs: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 }
}

type Store = Record<string, ChatState>

let store: Store = {}

function load(): void {
  try {
    store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) as Store
  } catch {
    store = {}
  }
}

let saveTimer: NodeJS.Timeout | null = null

function flush(): void {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true })
  const tmp = `${DATA_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2))
  fs.renameSync(tmp, DATA_FILE)
}

export function save(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      flush()
    } catch (err) {
      console.error('[state] не удалось сохранить состояние:', err)
    }
  }, 300)
}

export function saveNow(options: { throwOnError?: boolean } = {}): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  try {
    flush()
  } catch (err) {
    console.error('[state] не удалось сохранить состояние:', err)
    if (options.throwOnError) throw err
  }
}

export function getChat(scopeId: string | number): ChatState {
  const key = String(scopeId)
  let s = store[key]
  if (!s && key.endsWith(':0')) {
    const legacyKey = key.slice(0, -2)
    s = store[legacyKey]
    if (s) {
      store[key] = s
      delete store[legacyKey]
      save()
    }
  }
  if (!s) {
    s = {
      cwd: null,
      model: DEFAULT_MODEL,
      verbose: true,
      sessionId: null,
      sessions: [],
      usage: { session: emptyTotals(), total: emptyTotals() },
    }
    store[key] = s
  }
  if (!s.usage) s.usage = { session: emptyTotals(), total: emptyTotals() }
  if (!s.usage.session) s.usage.session = emptyTotals()
  if (!s.usage.total) s.usage.total = emptyTotals()
  return s
}

export function addUsage(
  scopeId: string | number,
  run: { costUsd: number; inputTokens: number; outputTokens: number; durationMs: number },
): void {
  const s = getChat(scopeId)
  for (const t of [s.usage.session, s.usage.total]) {
    t.runs += 1
    t.costUsd += run.costUsd
    t.inputTokens += run.inputTokens
    t.outputTokens += run.outputTokens
    t.durationMs += run.durationMs
  }
  save()
}

/** Счётчик сессии обнуляется при /new и при переходе на другую сессию. */
export function resetSessionUsage(scopeId: string | number): void {
  getChat(scopeId).usage.session = emptyTotals()
  save()
}

export function rememberSession(scopeId: string | number, session: SessionRecord): void {
  const s = getChat(scopeId)
  const existing = s.sessions.find((x) => x.id === session.id)
  if (existing) {
    existing.title = session.title || existing.title
    existing.cwd = session.cwd
  } else {
    s.sessions.unshift(session)
    s.sessions = s.sessions.slice(0, 20)
  }
  save()
}

export function deleteChat(scopeId: string | number, options: { persist?: boolean } = {}): void {
  const key = String(scopeId)
  const previous = store[key]
  delete store[key]
  if (!options.persist) {
    save()
    return
  }
  try {
    saveNow({ throwOnError: true })
  } catch {
    if (previous) store[key] = previous
    save()
    throw new Error('Не удалось сохранить удаление треда. Повтори удаление')
  }
}

export function listChats(): [string, ChatState][] {
  return Object.entries(store)
}

load()
