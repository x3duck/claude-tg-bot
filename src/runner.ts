import { query } from '@anthropic-ai/claude-agent-sdk'
import type { ModelUsage, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Workspace } from './workspace.ts'

export type RunEvent =
  | { type: 'session'; sessionId: string; model: string }
  | { type: 'tool'; label: string }
  | { type: 'note'; text: string }
  | { type: 'partial'; text: string }

export type RunResult = {
  ok: boolean
  text: string
  sessionId: string | null
  costUsd: number
  inputTokens: number
  outputTokens: number
  durationMs: number
  turns: number
  toolCalls: number
}

/**
 * Суммирует токены по всем моделям, задействованным в запросе, — включая
 * подагентов и служебные вызовы вроде компактификации.
 */
function sumTokens(modelUsage: Record<string, ModelUsage> | undefined): {
  input: number
  output: number
} {
  let input = 0
  let output = 0
  for (const u of Object.values(modelUsage ?? {})) {
    input += (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0)
    output += u.outputTokens ?? 0
  }
  return { input, output }
}

export type RunParams = {
  prompt: string
  cwd: string
  model: string
  ws: Workspace
  resume: string | null
  abort: AbortController
  onEvent: (e: RunEvent) => void
}

function systemPromptAppend(ws: Workspace, cwd: string): string {
  return [
    'Ты работаешь как агент внутри Telegram-бота: пользователь пишет тебе промты в мессенджере.',
    '',
    `Рабочая директория: ${cwd}`,
    `Файлы, присланные пользователем, складываются в: ${ws.inbox}`,
    `Папка результатов: ${ws.outbox}`,
    '',
    `Всё, что окажется в ${ws.outbox}, автоматически отправляется пользователю в Telegram как документ.`,
    'Клади туда готовые артефакты — отчёты, картинки, архивы, экспорты — и только их.',
    'Не клади в эту папку промежуточные, служебные и черновые файлы, исходники проекта и логи.',
    '',
    'Оформление ответа:',
    '- Пиши по-русски, кратко, обычным текстом. Telegram поддерживает **жирный**, *курсив*, `код` и блоки кода.',
    '- Не используй таблицы и вложенные списки глубже двух уровней — они нечитаемы в мессенджере.',
    '- Начинай с результата: что получилось или что ты выяснил. Детали — после.',
    '- Не пересказывай каждый свой шаг: пользователь видит ход выполнения отдельно.',
    '',
    'Пользователь может быть не у экрана и не может ответить посреди задачи.',
    'Мелкие решения (имена, форматирование, выбор между равнозначными вариантами) принимай сам и упоминай в ответе.',
    'Спрашивай только тогда, когда без ответа работа станет бессмысленной.',
  ].join('\n')
}

/** Короткая подпись инструмента для показа в чате. */
export function toolLabel(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown): string => (typeof v === 'string' ? v : '')
  const clip = (v: string, n = 120): string => (v.length > n ? `${v.slice(0, n)}…` : v)

  switch (name) {
    case 'Bash':
    case 'BashOutput':
      return `🖥 ${clip(s(input.command) || s(input.description))}`
    case 'Read':
      return `📖 ${clip(s(input.file_path))}`
    case 'Write':
      return `📝 ${clip(s(input.file_path))}`
    case 'Edit':
    case 'NotebookEdit':
      return `✏️ ${clip(s(input.file_path))}`
    case 'Glob':
      return `🔍 ${clip(s(input.pattern))}`
    case 'Grep':
      return `🔍 ${clip(s(input.pattern))}`
    case 'WebFetch':
      return `🌐 ${clip(s(input.url))}`
    case 'WebSearch':
      return `🌐 поиск: ${clip(s(input.query))}`
    case 'Task':
    case 'Agent':
      return `🤖 подагент: ${clip(s(input.description) || s(input.subagent_type))}`
    case 'TodoWrite':
      return '🗒 план обновлён'
    case 'Skill':
      return `🧩 навык: ${clip(s(input.skill) || s(input.command))}`
    default:
      return `🔧 ${name}`
  }
}

export async function runPrompt(p: RunParams): Promise<RunResult> {
  const started = Date.now()
  let sessionId: string | null = p.resume
  let toolCalls = 0
  let lastText = ''

  const options: Options = {
    cwd: p.cwd,
    model: p.model,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['user', 'project', 'local'],
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: systemPromptAppend(p.ws, p.cwd),
    },
    additionalDirectories: [p.ws.root],
    abortController: p.abort,
    includePartialMessages: true,
    stderr: (data: string) => {
      const line = data.trim()
      if (line) console.error('[claude]', line)
    },
  }

  if (p.resume) options.resume = p.resume

  const q = query({ prompt: p.prompt, options })

  let result: RunResult = {
    ok: false,
    text: '',
    sessionId,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    turns: 0,
    toolCalls: 0,
  }
  let partialText = ''

  for await (const msg of q as AsyncIterable<SDKMessage>) {
    switch (msg.type) {
      case 'stream_event': {
        if (msg.parent_tool_use_id !== null) break
        if (msg.event.type === 'message_start') partialText = ''
        if (msg.event.type === 'content_block_delta' && msg.event.delta.type === 'text_delta') {
          partialText += msg.event.delta.text
          p.onEvent({ type: 'partial', text: partialText })
        }
        break
      }
      case 'system': {
        if (msg.subtype === 'init') {
          sessionId = msg.session_id
          p.onEvent({ type: 'session', sessionId: msg.session_id, model: msg.model })
        }
        break
      }
      case 'assistant': {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            toolCalls += 1
            p.onEvent({
              type: 'tool',
              label: toolLabel(block.name, (block.input ?? {}) as Record<string, unknown>),
            })
          } else if (block.type === 'text' && block.text.trim()) {
            lastText = block.text
          }
        }
        break
      }
      case 'result': {
        const text = msg.subtype === 'success' ? msg.result : lastText
        const tokens = sumTokens(msg.modelUsage)
        result = {
          ok: msg.subtype === 'success' && !msg.is_error,
          text: (text ?? '').trim(),
          sessionId: sessionId ?? msg.session_id,
          costUsd: msg.total_cost_usd ?? 0,
          inputTokens: tokens.input,
          outputTokens: tokens.output,
          durationMs: msg.duration_ms ?? Date.now() - started,
          turns: msg.num_turns ?? 0,
          toolCalls,
        }
        if (!result.ok && !result.text) {
          result.text = `Выполнение прервано (${msg.subtype}).`
        }
        break
      }
      default:
        break
    }
  }

  if (!result.sessionId) result.sessionId = sessionId
  if (!result.durationMs) result.durationMs = Date.now() - started
  result.toolCalls = toolCalls
  return result
}
