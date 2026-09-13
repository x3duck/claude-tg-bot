import fs from 'node:fs'
import path from 'node:path'
import type { ChatState } from './state.ts'

export function requireIdle(busy: boolean): void {
  if (busy) throw new Error('Сначала останови выполнение или дождись его завершения')
}

export function changeDirectory(state: ChatState, current: string, input: string, busy: boolean): void {
  requireIdle(busy)
  const value = input.trim()
  if (!value || value === '~') {
    state.cwd = null
    return
  }
  const target = path.resolve(current, value.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'))
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error('Нет такой директории')
  state.cwd = target
}

export function changeSession(state: ChatState, sessionId: string | null, busy: boolean): boolean {
  requireIdle(busy)
  if (sessionId === null) {
    state.sessionId = null
    return true
  }
  const target = state.sessions.find((session) => session.id === sessionId)
  if (!target) throw new Error('Сессия не найдена')
  if (!target.cwd || !fs.existsSync(target.cwd) || !fs.statSync(target.cwd).isDirectory()) {
    throw new Error('Рабочая папка сессии недоступна')
  }
  const switching = state.sessionId !== target.id
  state.sessionId = target.id
  state.cwd = target.cwd
  return switching
}
