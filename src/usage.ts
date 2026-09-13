import fs from 'node:fs'
import { CREDENTIALS_FILE, USAGE_TIMEOUT_MS, USAGE_URL } from './config.ts'

/**
 * Лимиты подписки берутся тем же путём, что и в /usage самого Claude Code:
 * OAuth-токен из ~/.claude/.credentials.json → api.anthropic.com/api/oauth/usage.
 * Токен не кешируется: CLI обновляет файл сам, читаем его на каждый запрос.
 */

export type LimitRow = {
  title: string
  percent: number
  resetsAt: string | null
  active: boolean
}

export type PlanUsage = {
  plan: string | null
  rows: LimitRow[]
  extraUsage: { usedCredits: number | null; monthlyLimit: number | null; currency: string | null } | null
}

type RawLimit = {
  kind?: string
  group?: string
  percent?: number
  resets_at?: string | null
  is_active?: boolean
  scope?: { model?: { display_name?: string | null } | null; surface?: string | null } | null
}

type RawUsage = {
  five_hour?: { utilization?: number; resets_at?: string | null } | null
  seven_day?: { utilization?: number; resets_at?: string | null } | null
  limits?: RawLimit[]
  extra_usage?: {
    is_enabled?: boolean
    used_credits?: number | null
    monthly_limit?: number | null
    currency?: string | null
  } | null
}

export class UsageError extends Error {}

function readToken(): { token: string; plan: string | null } {
  let raw: string
  try {
    raw = fs.readFileSync(CREDENTIALS_FILE, 'utf8')
  } catch {
    throw new UsageError(`Не нашёл файл авторизации ${CREDENTIALS_FILE}`)
  }
  let parsed: { claudeAiOauth?: { accessToken?: string; subscriptionType?: string } }
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    throw new UsageError('Файл авторизации испорчен — не разбирается как JSON')
  }
  const token = parsed.claudeAiOauth?.accessToken
  if (!token) throw new UsageError('В файле авторизации нет OAuth-токена (вход по API-ключу лимитов не показывает)')
  return { token, plan: parsed.claudeAiOauth?.subscriptionType ?? null }
}

function titleFor(l: RawLimit): string {
  const model = l.scope?.model?.display_name ?? null
  switch (l.kind) {
    case 'session':
      return 'Сессия (5 ч)'
    case 'weekly_all':
      return 'Неделя, всего'
    case 'weekly_scoped':
      return model ? `Неделя, ${model}` : 'Неделя, отдельный лимит'
    case 'weekly_opus':
      return 'Неделя, Opus'
    default:
      break
  }
  if (l.group === 'weekly') return model ? `Неделя, ${model}` : 'Неделя'
  return model ? `Лимит ${model}` : (l.kind ?? 'Лимит')
}

export async function fetchPlanUsage(): Promise<PlanUsage> {
  const { token, plan } = readToken()

  let res: Response
  try {
    res = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new UsageError(`Не достучался до api.anthropic.com: ${message}`)
  }

  if (res.status === 401 || res.status === 403) {
    throw new UsageError('Токен доступа не принят — он протухнет и обновится при следующем запуске claude')
  }
  if (!res.ok) {
    throw new UsageError(`Сервер ответил ${res.status}`)
  }

  const data = (await res.json()) as RawUsage

  const rows: LimitRow[] = []
  const addRow = (row: LimitRow) => {
    if (!rows.some((existing) => existing.title === row.title)) rows.push(row)
  }

  if (data.five_hour) {
    addRow({
      title: 'Сессия (5 ч)',
      percent: Math.round(data.five_hour.utilization ?? 0),
      resetsAt: data.five_hour.resets_at ?? null,
      active: false,
    })
  }
  if (data.seven_day) {
    addRow({
      title: 'Неделя, всего',
      percent: Math.round(data.seven_day.utilization ?? 0),
      resetsAt: data.seven_day.resets_at ?? null,
      active: false,
    })
  }
  for (const limit of data.limits ?? []) {
    addRow({
      title: titleFor(limit),
      percent: Math.round(limit.percent ?? 0),
      resetsAt: limit.resets_at ?? null,
      active: limit.is_active === true,
    })
  }

  const extra = data.extra_usage
  return {
    plan,
    rows,
    extraUsage:
      extra?.is_enabled === true
        ? {
            usedCredits: extra.used_credits ?? null,
            monthlyLimit: extra.monthly_limit ?? null,
            currency: extra.currency ?? null,
          }
        : null,
  }
}

/** «через 2 ч 14 мин» — абсолютное время зависело бы от таймзоны сервера. */
export function fmtReset(iso: string | null): string {
  if (!iso) return ''
  const ms = new Date(iso).getTime() - Date.now()
  if (!Number.isFinite(ms)) return ''
  if (ms <= 60_000) return 'сброс вот-вот'
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `сброс через ${mins} мин`
  const hours = Math.floor(mins / 60)
  const rest = mins % 60
  if (hours < 24) return `сброс через ${hours} ч${rest > 0 ? ` ${rest} мин` : ''}`
  const days = Math.floor(hours / 24)
  return `сброс через ${days} дн${hours % 24 > 0 ? ` ${hours % 24} ч` : ''}`
}

export function bar(percent: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)))
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled)
}

export function dot(percent: number): string {
  if (percent >= 90) return '🔴'
  if (percent >= 70) return '🟡'
  return '🟢'
}
