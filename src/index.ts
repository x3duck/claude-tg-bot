import path from 'node:path'
import fs from 'node:fs'
import { Bot, InputFile } from 'grammy'
import type { Context } from 'grammy'
import {
  ALLOWED_USER_IDS,
  BOT_TOKEN,
  MAX_SEND_BYTES,
  MODELS,
  PROGRESS_INTERVAL_MS,
  PROGRESS_TAIL,
} from './config.ts'
import { addUsage, deleteChat, getChat, rememberSession, resetSessionUsage, save, saveNow } from './state.ts'
import type { UsageTotals } from './state.ts'
import { bar, dot, fetchPlanUsage, fmtReset, UsageError } from './usage.ts'
import { renderForTelegram } from './telegram-md.ts'
import { runPrompt } from './runner.ts'
import {
  clearWorkspaceFiles,
  archiveWorkspace,
  collectArtifacts,
  downloadIncoming,
  fmtSize,
  listFiles,
  markSent,
  removeFile,
  workspaceFor,
} from './workspace.ts'
import type { DownloadedFile, IncomingFile } from './workspace.ts'
import { authStatus, startLogin } from './auth.ts'

const bot = new Bot(BOT_TOKEN)
let activeLogin: ReturnType<typeof startLogin> | null = null

bot.on('stopped_message_generation', async (ctx) => {
  const stopped = ctx.stoppedMessageGeneration
  if (!ALLOWED_USER_IDS.has(stopped.chat.id)) return
  const scopeId = `${stopped.chat.id}:${stopped.message_thread_id ?? 0}`
  const rt = runtimes.get(scopeId)
  if (!rt || draftScopes.get(stopped.draft_id) !== scopeId) return
  rt.queue.length = 0
  rt.abort?.abort()
})

/* ------------------------------------------------------------------ доступ */

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id
  if (!userId || !ALLOWED_USER_IDS.has(userId)) return // чужие не получают вообще ничего
  const chatType = ctx.chat?.type
  if (chatType && chatType !== 'private') return // только личка
  await next()
})

/* ---------------------------------------------------------------- очередь */

type Job = {
  prompt: string
  files: DownloadedFile[]
}

type Runtime = {
  queue: Job[]
  busy: boolean
  abort: AbortController | null
  lastListing: string[]
}

type ScopeId = string

const runtimes = new Map<ScopeId, Runtime>()

function scopeFor(ctx: Context): ScopeId {
  const chatId = ctx.chat?.id
  if (chatId === undefined) throw new Error('Нет Telegram chat id')
  const threadId = ctx.msg?.message_thread_id ?? 0
  return `${chatId}:${threadId}`
}

function runtimeFor(scopeId: ScopeId): Runtime {
  let rt = runtimes.get(scopeId)
  if (!rt) {
    rt = { queue: [], busy: false, abort: null, lastListing: [] }
    runtimes.set(scopeId, rt)
  }
  return rt
}

/** 12345 → «12.3k», чтобы строка итога не разъезжалась. */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function fmtCost(usd: number): string {
  if (usd <= 0) return '$0'
  return usd < 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(1)}`
}

function fmtDuration(ms: number): string {
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins} мин`
  return `${Math.floor(mins / 60)} ч ${mins % 60} мин`
}

function fmtTotals(t: UsageTotals): string {
  if (t.runs === 0) return 'пусто'
  return `${t.runs} запр. · ${fmtTokens(t.inputTokens)}→${fmtTokens(t.outputTokens)} токенов · ${fmtCost(t.costUsd)} · ${fmtDuration(t.durationMs)}`
}

function cwdFor(scopeId: ScopeId): string {
  const state = getChat(scopeId)
  const ws = workspaceFor(scopeId)
  if (state.cwd && fs.existsSync(state.cwd)) return state.cwd
  return ws.root
}

/* ---------------------------------------------------------- вывод прогресса */

let nextDraftId = Math.floor(Date.now() % 2_000_000_000) || 1
const draftScopes = new Map<number, ScopeId>()

class Progress {
  private lines: string[] = []
  private partial = ''
  private rendered = ''
  private timer: NodeJS.Timeout | null = null
  private closed = false
  private lastSentAt = 0
  private dirty = false
  private flushTask: Promise<void> | null = null

  private readonly ctx: Context
  private readonly draftId: number
  private readonly verbose: boolean

  constructor(ctx: Context, verbose: boolean) {
    this.ctx = ctx
    this.draftId = nextDraftId++
    draftScopes.set(this.draftId, scopeFor(ctx))
    this.verbose = verbose
    this.timer = setInterval(() => this.requestFlush(), Math.min(PROGRESS_INTERVAL_MS, 1000))
    this.requestFlush()
  }

  add(line: string): void {
    this.lines.push(line)
  }

  setPartial(text: string): void {
    this.partial = text
  }

  private compose(): string {
    const progress = this.lines.at(-1)
    if (this.partial) {
      const suffix = this.verbose && progress ? `\n\n⏳ ${progress}` : ''
      const room = 4000 - suffix.length
      const text = this.partial.length > room ? `…${this.partial.slice(-(room - 1))}` : this.partial
      return text + suffix
    }
    if (!this.verbose || this.lines.length === 0) return ''
    const tail = this.lines.slice(-PROGRESS_TAIL)
    const hidden = this.lines.length - tail.length
    const head = hidden > 0 ? `⏳ Работаю… (+${hidden} шагов выше)\n` : '⏳ Работаю…\n'
    return head + tail.map((l) => `· ${l}`).join('\n')
  }

  private requestFlush(): void {
    if (this.closed) return
    this.dirty = true
    if (!this.flushTask) this.flushTask = this.flush().finally(() => (this.flushTask = null))
  }

  private async flush(): Promise<void> {
    while (this.dirty && !this.closed) {
      this.dirty = false
      const text = this.compose().slice(0, 3800)
      if (text === this.rendered && Date.now() - this.lastSentAt < 20_000) continue
      this.rendered = text
      this.lastSentAt = Date.now()
      try {
        await this.ctx.api.sendMessageDraft(this.ctx.chat!.id, this.draftId, text, {
          message_thread_id: this.ctx.msg?.message_thread_id,
          can_stop: true,
          keep_on_stop: true,
        })
      } catch {
      }
    }
  }

  async finish(): Promise<void> {
    this.closed = true
    draftScopes.delete(this.draftId)
    if (this.timer) clearInterval(this.timer)
    try {
      await this.flushTask
    } catch {
    }
  }
}

/* ------------------------------------------------------------- отправка ответа */

async function sendAnswer(ctx: Context, markdown: string): Promise<void> {
  const chunks = renderForTelegram(markdown)
  const raw = markdown.split('\n')
  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      })
    } catch (err) {
      // Если разметка всё-таки не понравилась Telegram — шлём как есть
      console.error('[send] HTML отклонён, отправляю текстом:', err)
      const plain = chunk.replace(/<[^>]+>/g, '')
      await ctx.reply(plain.slice(0, 4000) || raw.join('\n').slice(0, 4000))
    }
  }
}

/* -------------------------------------------------------------- выполнение */

async function execute(ctx: Context, scopeId: ScopeId, job: Job): Promise<void> {
  const state = getChat(scopeId)
  const ws = workspaceFor(scopeId)
  const cwd = cwdFor(scopeId)
  const rt = runtimeFor(scopeId)

  const progress = new Progress(ctx, state.verbose)

  const abort = new AbortController()
  rt.abort = abort

  const since = Date.now()
  const filesNote =
    job.files.length > 0
      ? `\n\nПользователь приложил файлы:\n${job.files.map((f) => `- ${f.path}`).join('\n')}`
      : ''

  try {
    const result = await runPrompt({
      prompt: job.prompt + filesNote,
      cwd,
      model: state.model,
      ws,
      resume: state.sessionId,
      abort,
      onEvent: (e) => {
        if (e.type === 'session') {
          if (state.sessionId !== e.sessionId) {
            state.sessionId = e.sessionId
            rememberSession(scopeId, {
              id: e.sessionId,
              title: job.prompt.slice(0, 60),
              startedAt: new Date().toISOString(),
              cwd,
            })
            save()
          }
        } else if (e.type === 'tool') {
          progress.add(e.label)
        } else if (e.type === 'note') {
          progress.add(e.text)
        } else if (e.type === 'partial') {
          progress.setPartial(e.text)
        }
      },
    })

    if (result.sessionId && result.sessionId !== state.sessionId) {
      state.sessionId = result.sessionId
      save()
    }

    addUsage(scopeId, result)

    const secs = Math.round(result.durationMs / 1000)
    const summary = state.verbose
      ? `✅ ${secs} с · ${result.toolCalls} инстр. · ${fmtTokens(result.inputTokens)}→${fmtTokens(result.outputTokens)} токенов`
      : null
    await progress.finish()
    if (abort.signal.aborted) await ctx.reply('⏹ Остановлено')

    if (result.text) await sendAnswer(ctx, result.text)
    else if (!abort.signal.aborted) await ctx.reply('(модель не вернула текст)')
    if (!abort.signal.aborted && summary) await ctx.reply(summary)

    await sendArtifacts(ctx, ws, cwd, since, result.text)
  } catch (err) {
    const aborted = abort.signal.aborted || (err instanceof Error && err.name === 'AbortError')
    await progress.finish()
    if (aborted) await ctx.reply('⏹ Остановлено')
    if (!aborted) {
      console.error('[run] ошибка выполнения:', err)
      const message = err instanceof Error ? err.message : String(err)
      await ctx.reply(`❌ Не получилось выполнить:\n${message.slice(0, 1500)}`)
      if (/authenticate|oauth session expired|not logged in/i.test(message)) {
        await ctx.reply('Авторизация Claude истекла. Запусти /login прямо здесь.')
      }
    }
  } finally {
    rt.abort = null
  }
}

async function sendArtifacts(
  ctx: Context,
  ws: ReturnType<typeof workspaceFor>,
  cwd: string,
  since: number,
  finalText: string,
): Promise<void> {
  const artifacts = collectArtifacts(ws, cwd, since, finalText)
  for (const a of artifacts) {
    if (a.size > MAX_SEND_BYTES) {
      await ctx.reply(`📦 ${path.basename(a.path)} — ${fmtSize(a.size)}, слишком большой для Telegram.\n${a.path}`)
      continue
    }
    try {
      await ctx.replyWithDocument(new InputFile(a.path, path.basename(a.path)), {
        caption: a.source === 'outbox' ? undefined : path.relative(cwd, a.path),
      })
      markSent(ws, a.path)
    } catch (err) {
      console.error('[send] не удалось отправить файл', a.path, err)
      await ctx.reply(`⚠️ Не смог отправить ${path.basename(a.path)}: ${String(err).slice(0, 200)}`)
    }
  }
}

async function drain(ctx: Context, scopeId: ScopeId): Promise<void> {
  const rt = runtimeFor(scopeId)
  if (rt.busy) return
  rt.busy = true
  try {
    while (rt.queue.length > 0) {
      const job = rt.queue.shift()!
      await execute(ctx, scopeId, job)
    }
  } finally {
    rt.busy = false
  }
}

async function enqueue(ctx: Context, scopeId: ScopeId, job: Job): Promise<void> {
  const rt = runtimeFor(scopeId)
  rt.queue.push(job)
  if (rt.busy) {
    await ctx.reply(`⏳ Занят текущей задачей — поставил в очередь (${rt.queue.length}).`)
    return
  }
  void drain(ctx, scopeId)
}

/* ------------------------------------------------------------------ команды */

const COMMANDS = [
  { command: 'panel', description: 'Панель управления темой' },
  { command: 'new_topic', description: 'Создать новую тему' },
  { command: 'rename', description: 'Переименовать текущую тему' },
  { command: 'delete_topic', description: 'Удалить текущую тему' },
  { command: 'new', description: 'Новая Claude-сессия в этой теме' },
  { command: 'stop', description: 'Остановить задачу и очистить очередь' },
  { command: 'model', description: 'Выбрать модель' },
  { command: 'status', description: 'Состояние темы' },
  { command: 'files', description: 'Файлы темы' },
  { command: 'usage', description: 'Лимиты и расход' },
  { command: 'login', description: 'Обновить авторизацию Claude' },
  { command: 'auth_status', description: 'Проверить авторизацию Claude' },
  { command: 'help', description: 'Справка' },
] as const

function panelMarkup() {
  return {
    inline_keyboard: [
      [
        { text: '🆕 Новая тема', callback_data: 'panel:new_topic' },
        { text: '⏹ Stop', callback_data: 'panel:stop' },
      ],
      [
        { text: '🤖 Модель', callback_data: 'panel:model' },
        { text: '👁 Verbose', callback_data: 'panel:verbose' },
      ],
      [
        { text: '📁 Файлы', callback_data: 'panel:files' },
        { text: '🔐 Auth', callback_data: 'panel:auth' },
      ],
      [{ text: '🔄 Обновить', callback_data: 'panel:refresh' }],
    ],
  }
}

function panelText(scopeId: ScopeId): string {
  const state = getChat(scopeId)
  const rt = runtimeFor(scopeId)
  return [
    '<b>Панель темы</b>',
    `Модель: <code>${state.model}</code>`,
    `Папка: <code>${cwdFor(scopeId)}</code>`,
    `Сессия: ${state.sessionId ? `<code>${state.sessionId.slice(0, 8)}…</code>` : 'новая'}`,
    `Verbose: ${state.verbose ? 'on' : 'off'}`,
    `Очередь: ${rt.busy ? `работает + ${rt.queue.length}` : 'свободна'}`,
  ].join('\n')
}

async function renderPanel(ctx: Context): Promise<void> {
  try {
    await ctx.editMessageText(panelText(scopeFor(ctx)), { parse_mode: 'HTML', reply_markup: panelMarkup() })
  } catch (err) {
    if (!/message is not modified/i.test(String(err))) throw err
  }
}

async function createTopic(ctx: Context, requestedName: string): Promise<void> {
  const requested = requestedName.replace(/\s+/g, ' ').trim().slice(0, 128)
  const name = requested || 'Новая задача'
  const topic = await ctx.api.createForumTopic(ctx.chat!.id, name)
  const scopeId = `${ctx.chat!.id}:${topic.message_thread_id}`
  getChat(scopeId).topicNameImplicit = !requested
  save()
  await ctx.api.sendMessage(ctx.chat!.id, panelText(scopeId), {
    message_thread_id: topic.message_thread_id,
    parse_mode: 'HTML',
    reply_markup: panelMarkup(),
  })
}

const HELP = [
  '<b>Прокси к Claude Code</b>',
  '',
  'Просто пиши промт — он уйдёт в модель. Можно прикладывать файлы и картинки:',
  'подпись к файлу становится промтом.',
  '',
  '<b>Сессия</b>',
  '/panel — панель управления темой',
  '/new_topic &lt;название&gt; — создать отдельную тему',
  '/rename &lt;название&gt; — переименовать текущую тему',
  '/delete_topic — удалить тему и архивировать файлы',
  '/new — начать новую сессию (забыть контекст)',
  '/sessions — список последних сессий',
  '/resume &lt;n&gt; — вернуться к сессии из списка',
  '/stop — прервать то, что выполняется сейчас',
  '/tldr — переформулировать последний ответ короче',
  '',
  '<b>Настройки</b>',
  '/model — выбрать модель',
  '/cd &lt;путь&gt; — сменить рабочую директорию',
  '/pwd — где я сейчас работаю',
  '/verbose on|off — показывать ли ход выполнения',
  '/status — текущее состояние',
  '/usage — лимиты подписки и расход бота',
  '/auth_status — проверить авторизацию Claude',
  '/login — обновить авторизацию Claude',
  '',
  '<b>Файлы</b>',
  '/files — последние файлы рабочей папки',
  '/get &lt;n&gt; — прислать файл из списка',
  '/rm &lt;n&gt; — удалить файл из списка',
  '/clean — удалить все файлы чата',
  '',
  'Всё, что модель кладёт в папку <code>outbox</code>, приходит сюда автоматически.',
  'У каждой темы свои сессия, очередь, настройки и файлы.',
].join('\n')

bot.command('start', async (ctx) => {
  await ctx.reply(HELP, { parse_mode: 'HTML' })
})

bot.command('help', async (ctx) => {
  await ctx.reply(HELP, { parse_mode: 'HTML' })
})

bot.command('panel', async (ctx) => {
  await ctx.reply(panelText(scopeFor(ctx)), { parse_mode: 'HTML', reply_markup: panelMarkup() })
})

bot.command('new_topic', async (ctx) => {
  try {
    await createTopic(ctx, ctx.match)
    await ctx.reply('🆕 Новая тема создана — открой её в списке тем.')
  } catch (err) {
    await ctx.reply(`Не удалось создать тему: ${String(err).slice(0, 300)}`)
  }
})

bot.command('rename', async (ctx) => {
  const threadId = ctx.msg?.message_thread_id
  const name = ctx.match.replace(/\s+/g, ' ').trim().slice(0, 128)
  if (!threadId) {
    await ctx.reply('General topic переименовать через бота нельзя.')
    return
  }
  if (!name) {
    await ctx.reply('Укажи название: /rename Новое название')
    return
  }
  await ctx.api.editForumTopic(ctx.chat.id, threadId, { name })
  const state = getChat(scopeFor(ctx))
  state.topicNameImplicit = false
  save()
  await ctx.reply(`Тема переименована: ${name}`)
})

bot.command('delete_topic', async (ctx) => {
  if (!ctx.msg?.message_thread_id) {
    await ctx.reply('General topic удалить нельзя.')
    return
  }
  await ctx.reply('Удалить тему и её сообщения? Рабочие файлы будут перенесены в архив.', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🗑 Удалить тему', callback_data: 'topic_delete:yes' }],
        [{ text: 'Отмена', callback_data: 'topic_delete:no' }],
      ],
    },
  })
})

bot.callbackQuery(/^topic_delete:(yes|no)$/, async (ctx) => {
  if (ctx.match[1] === 'no') {
    await ctx.answerCallbackQuery('Отменено')
    await ctx.editMessageText('Удаление отменено.')
    return
  }
  const threadId = ctx.msg?.message_thread_id
  if (!threadId) {
    await ctx.answerCallbackQuery({ text: 'General topic удалить нельзя', show_alert: true })
    return
  }
  const scopeId = scopeFor(ctx)
  const rt = runtimeFor(scopeId)
  rt.queue.length = 0
  rt.abort?.abort()
  archiveWorkspace(scopeId)
  deleteChat(scopeId)
  runtimes.delete(scopeId)
  await ctx.answerCallbackQuery('Удаляю тему')
  await ctx.api.deleteForumTopic(ctx.chat!.id, threadId)
})

bot.callbackQuery(/^panel:(.+)$/, async (ctx) => {
  const action = ctx.match[1]
  const scopeId = scopeFor(ctx)
  if (action === 'new_topic') {
    await ctx.answerCallbackQuery('Создаю новую тему')
    await createTopic(ctx, '')
    return
  }
  if (action === 'stop') {
    const rt = runtimeFor(scopeId)
    rt.queue.length = 0
    rt.abort?.abort()
    await ctx.answerCallbackQuery('Останавливаю')
    await renderPanel(ctx)
    return
  }
  if (action === 'verbose') {
    const state = getChat(scopeId)
    state.verbose = !state.verbose
    save()
    await ctx.answerCallbackQuery(`Verbose: ${state.verbose ? 'on' : 'off'}`)
    await renderPanel(ctx)
    return
  }
  if (action === 'model') {
    await ctx.answerCallbackQuery()
    await ctx.editMessageText('Выбери модель:', {
      reply_markup: {
        inline_keyboard: [
          ...MODELS.map((m) => [{ text: m.label, callback_data: `panel_model:${m.id}` }]),
          [{ text: '← Назад', callback_data: 'panel:refresh' }],
        ],
      },
    })
    return
  }
  if (action === 'files') {
    const ws = workspaceFor(scopeId)
    const files = listFiles(ws, cwdFor(scopeId))
    runtimeFor(scopeId).lastListing = files.map((f) => f.path)
    const text = files.length
      ? files.slice(0, 15).map((f, i) => `${i + 1}. ${path.basename(f.path)} — ${fmtSize(f.size)}`).join('\n')
      : 'Файлов пока нет.'
    await ctx.answerCallbackQuery()
    await ctx.editMessageText(text, { reply_markup: { inline_keyboard: [[{ text: '← Назад', callback_data: 'panel:refresh' }]] } })
    return
  }
  if (action === 'auth') {
    await ctx.answerCallbackQuery({
      text: (await authStatus()) ? 'Claude авторизован' : 'Нужен вход: отправь /login',
      show_alert: true,
    })
    return
  }
  await ctx.answerCallbackQuery()
  await renderPanel(ctx)
})

bot.callbackQuery(/^panel_model:(.+)$/, async (ctx) => {
  const id = ctx.match[1]
  if (!MODELS.some((m) => m.id === id)) {
    await ctx.answerCallbackQuery('Неизвестная модель')
    return
  }
  getChat(scopeFor(ctx)).model = id
  save()
  await ctx.answerCallbackQuery(`Модель: ${id}`)
  await renderPanel(ctx)
})

bot.command('auth_status', async (ctx) => {
  await ctx.reply((await authStatus()) ? '✅ Claude авторизован.' : '⚠️ Claude требует входа. Запусти /login.')
})

bot.command('login', async (ctx) => {
  if (activeLogin) {
    await ctx.reply('Вход уже запущен. Открой присланную ссылку или отправь /auth_code.')
    return
  }
  if (await authStatus()) {
    await ctx.reply('✅ Claude уже авторизован.')
    return
  }

  await ctx.reply('Запускаю вход Claude…')
  activeLogin = startLogin({
    onUrl: (url) => {
      void ctx.reply(
        `Скопируй ссылку и открой её в браузере:\n\n${url}\n\nЕсли сайт покажет код, пришли его командой /auth_code КОД`,
        { link_preview_options: { is_disabled: true } },
      )
    },
    onDone: (ok, message) => {
      activeLogin = null
      void ctx.reply(`${ok ? '✅' : '⚠️'} ${message}`)
    },
  })
})

bot.command('auth_code', async (ctx) => {
  const code = ctx.match.trim()
  try {
    await ctx.deleteMessage()
  } catch {}
  if (!activeLogin) {
    await ctx.reply('Нет ожидающего входа. Сначала запусти /login.')
    return
  }
  if (!code) {
    await ctx.reply('Пришли код так: /auth_code &lt;код&gt;', { parse_mode: 'HTML' })
    return
  }
  activeLogin.stdin.write(`${code}\n`)
  await ctx.reply('Код передан Claude, проверяю вход…')
})

bot.command('new', async (ctx) => {
  const scopeId = scopeFor(ctx)
  const state = getChat(scopeId)
  state.sessionId = null
  save()
  resetSessionUsage(scopeId)
  await ctx.reply('🆕 Начал новую сессию. Прежний контекст забыт.')
})

bot.command('usage', async (ctx) => {
  const state = getChat(scopeFor(ctx))
  const lines: string[] = []

  try {
    const usage = await fetchPlanUsage()
    lines.push(`<b>Лимиты подписки</b>${usage.plan ? ` (${usage.plan})` : ''}`)
    if (usage.rows.length === 0) {
      lines.push('Сервер не вернул ни одного лимита.')
    }
    for (const row of usage.rows) {
      const reset = fmtReset(row.resetsAt)
      const mark = row.active ? ' ←' : ''
      lines.push(
        `${dot(row.percent)} ${row.title} — ${row.percent}%${mark}\n<code>${bar(row.percent)}</code>${reset ? ` ${reset}` : ''}`,
      )
    }
    if (usage.extraUsage) {
      const { usedCredits, monthlyLimit, currency } = usage.extraUsage
      lines.push(
        `💳 Докупленные лимиты: ${usedCredits ?? 0}${monthlyLimit ? ` из ${monthlyLimit}` : ''} ${currency ?? ''}`.trim(),
      )
    }
  } catch (err) {
    const message = err instanceof UsageError ? err.message : String(err)
    lines.push(`<b>Лимиты подписки</b>\n⚠️ ${message}`)
  }

  lines.push('')
  lines.push('<b>Расход бота</b>')
  lines.push(`Сессия: ${fmtTotals(state.usage.session)}`)
  lines.push(`Всего в чате: ${fmtTotals(state.usage.total)}`)
  lines.push('<i>Стоимость считается по прайсу API, с подписки деньги не списываются.</i>')

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
})

bot.command('status', async (ctx) => {
  const scopeId = scopeFor(ctx)
  const state = getChat(scopeId)
  const rt = runtimeFor(scopeId)
  const lines = [
    `<b>Модель:</b> ${state.model}`,
    `<b>Директория:</b> <code>${cwdFor(scopeId)}</code>`,
    `<b>Сессия:</b> ${state.sessionId ? `<code>${state.sessionId.slice(0, 8)}…</code>` : 'новая'}`,
    `<b>Ход выполнения:</b> ${state.verbose ? 'показываю' : 'скрыт'}`,
    `<b>Очередь:</b> ${rt.busy ? `выполняется, в очереди ${rt.queue.length}` : 'свободен'}`,
  ]
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
})

bot.command('stop', async (ctx) => {
  const rt = runtimeFor(scopeFor(ctx))
  const queued = rt.queue.length
  rt.queue.length = 0
  if (rt.abort) {
    rt.abort.abort()
    await ctx.reply(`⏹ Прерываю${queued > 0 ? ` и очищаю очередь (${queued})` : ''}.`)
  } else if (queued > 0) {
    await ctx.reply(`⏹ Очередь очищена (${queued}).`)
  } else {
    await ctx.reply('Сейчас ничего не выполняется.')
  }
})

bot.command('verbose', async (ctx) => {
  const state = getChat(scopeFor(ctx))
  const arg = ctx.match.trim().toLowerCase()
  if (arg === 'on' || arg === 'off') state.verbose = arg === 'on'
  else state.verbose = !state.verbose
  save()
  await ctx.reply(state.verbose ? 'Показываю ход выполнения.' : 'Скрыл ход выполнения — только финальный ответ.')
})

bot.command('pwd', async (ctx) => {
  await ctx.reply(`<code>${cwdFor(scopeFor(ctx))}</code>`, { parse_mode: 'HTML' })
})

bot.command('cd', async (ctx) => {
  const scopeId = scopeFor(ctx)
  const state = getChat(scopeId)
  const arg = ctx.match.trim()
  const ws = workspaceFor(scopeId)

  if (!arg || arg === '~') {
    state.cwd = null
    save()
    await ctx.reply(`Вернулся в рабочую папку чата:\n<code>${ws.root}</code>`, { parse_mode: 'HTML' })
    return
  }

  const target = path.resolve(cwdFor(scopeId), arg.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'))
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    await ctx.reply(`Нет такой директории:\n<code>${target}</code>`, { parse_mode: 'HTML' })
    return
  }
  state.cwd = target
  save()
  await ctx.reply(`Работаю в:\n<code>${target}</code>`, { parse_mode: 'HTML' })
})

bot.command('model', async (ctx) => {
  const state = getChat(scopeFor(ctx))
  await ctx.reply(`Текущая модель: <b>${state.model}</b>\nВыбери другую:`, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: MODELS.map((m) => [
        { text: `${m.id === state.model ? '✅ ' : ''}${m.label}`, callback_data: `model:${m.id}` },
      ]),
    },
  })
})

bot.callbackQuery(/^model:(.+)$/, async (ctx) => {
  const id = ctx.match[1] as string
  if (!MODELS.some((m) => m.id === id)) {
    await ctx.answerCallbackQuery('Неизвестная модель')
    return
  }
  const state = getChat(scopeFor(ctx))
  state.model = id
  save()
  await ctx.answerCallbackQuery(`Модель: ${id}`)
  await ctx.editMessageText(`Модель переключена на <b>${id}</b>.`, { parse_mode: 'HTML' })
})

bot.command('tldr', async (ctx) => {
  const scopeId = scopeFor(ctx)
  const state = getChat(scopeId)
  if (!state.sessionId) {
    await ctx.reply('Нет активной сессии — сжимать нечего.')
    return
  }
  await enqueue(ctx, scopeId, { prompt: 'ELI18 TLDR', files: [] })
})

bot.command('sessions', async (ctx) => {
  const state = getChat(scopeFor(ctx))
  if (state.sessions.length === 0) {
    await ctx.reply('Сохранённых сессий пока нет.')
    return
  }
  const lines = state.sessions.slice(0, 10).map((s, i) => {
    const active = s.id === state.sessionId ? ' ← текущая' : ''
    const when = new Date(s.startedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
    return `${i + 1}. ${when} — ${s.title || '(без названия)'}${active}`
  })
  await ctx.reply(`${lines.join('\n')}\n\nВернуться: /resume &lt;номер&gt;`, { parse_mode: 'HTML' })
})

bot.command('resume', async (ctx) => {
  const scopeId = scopeFor(ctx)
  const state = getChat(scopeId)
  const n = Number(ctx.match.trim())
  const target = state.sessions[n - 1]
  if (!Number.isFinite(n) || !target) {
    await ctx.reply('Укажи номер из списка /sessions, например: /resume 2')
    return
  }
  const switching = state.sessionId !== target.id
  state.sessionId = target.id
  if (target.cwd && fs.existsSync(target.cwd)) state.cwd = target.cwd
  save()
  if (switching) resetSessionUsage(scopeId)
  await ctx.reply(`↩️ Вернулся к сессии: ${target.title || target.id.slice(0, 8)}`)
})

bot.command('files', async (ctx) => {
  const scopeId = scopeFor(ctx)
  const ws = workspaceFor(scopeId)
  const cwd = cwdFor(scopeId)
  const files = listFiles(ws, cwd)
  if (files.length === 0) {
    await ctx.reply('Файлов пока нет.')
    return
  }
  const rt = runtimeFor(scopeId)
  rt.lastListing = files.map((f) => f.path)
  const lines = files.map((f, i) => {
    const name = f.sent
      ? path.relative(ws.sent, f.path)
      : path.relative(cwd, f.path) || path.basename(f.path)
    return `${i + 1}. ${name} — ${fmtSize(f.size)}${f.sent ? ' ✓ уже отправлен' : ''}`
  })
  await ctx.reply(`${lines.join('\n')}\n\nЗабрать: /get <номер>`)
})

bot.command('get', async (ctx) => {
  const scopeId = scopeFor(ctx)
  const rt = runtimeFor(scopeId)
  const arg = ctx.match.trim()
  if (!arg) {
    await ctx.reply('Укажи номер из /files или путь к файлу.')
    return
  }

  const n = Number(arg)
  const target = Number.isFinite(n) ? rt.lastListing[n - 1] : path.resolve(cwdFor(scopeId), arg)

  if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    await ctx.reply('Не нашёл такой файл. Обнови список через /files.')
    return
  }
  const size = fs.statSync(target).size
  if (size > MAX_SEND_BYTES) {
    await ctx.reply(`Файл весит ${fmtSize(size)} — Telegram примет максимум ${fmtSize(MAX_SEND_BYTES)}.`)
    return
  }
  await ctx.replyWithDocument(new InputFile(target, path.basename(target)))
})

bot.command('rm', async (ctx) => {
  const scopeId = scopeFor(ctx)
  const rt = runtimeFor(scopeId)
  const ws = workspaceFor(scopeId)
  const arg = ctx.match.trim()

  if (!arg) {
    await ctx.reply('Укажи номер из /files, например: /rm 2')
    return
  }

  const n = Number(arg)
  const target = Number.isFinite(n) ? rt.lastListing[n - 1] : path.resolve(cwdFor(scopeId), arg)

  if (!target || !fs.existsSync(target)) {
    await ctx.reply('Не нашёл такой файл. Обнови список через /files.')
    return
  }

  try {
    removeFile(ws, target)
    rt.lastListing = rt.lastListing.filter((p) => p !== target)
    await ctx.reply(`🗑 Удалил ${path.basename(target)}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await ctx.reply(`Не могу удалить: ${message}`)
  }
})

bot.command('clean', async (ctx) => {
  const ws = workspaceFor(scopeFor(ctx))
  const count = listFiles(ws, ws.root).length
  if (count === 0) {
    await ctx.reply('В рабочей папке и так пусто.')
    return
  }
  await ctx.reply(`Удалить все файлы чата — inbox и outbox, включая отправленное (${count} шт.)?`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🗑 Да, удалить', callback_data: 'clean:yes' }],
        [{ text: 'Отмена', callback_data: 'clean:no' }],
      ],
    },
  })
})

bot.callbackQuery(/^clean:(yes|no)$/, async (ctx) => {
  if (ctx.match[1] === 'no') {
    await ctx.answerCallbackQuery('Отменено')
    await ctx.editMessageText('Отменил, всё на месте.')
    return
  }
  const scopeId = scopeFor(ctx)
  const removed = clearWorkspaceFiles(workspaceFor(scopeId))
  runtimeFor(scopeId).lastListing = []
  await ctx.answerCallbackQuery(`Удалено: ${removed}`)
  await ctx.editMessageText(`🗑 Удалил ${removed} файл(ов). Контекст сессии не тронут — для него /new.`)
})

/* -------------------------------------------------------- входящие сообщения */

type PendingGroup = {
  files: IncomingFile[]
  caption: string
  timer: NodeJS.Timeout
}

const mediaGroups = new Map<string, PendingGroup>()

function extractFiles(ctx: Context): IncomingFile[] {
  const m = ctx.message
  if (!m) return []
  const out: IncomingFile[] = []

  if (m.document) {
    out.push({
      fileId: m.document.file_id,
      name: m.document.file_name ?? 'document',
      size: m.document.file_size,
      kind: 'document',
    })
  }
  if (m.photo && m.photo.length > 0) {
    const best = m.photo[m.photo.length - 1]!
    out.push({ fileId: best.file_id, name: 'photo.jpg', size: best.file_size, kind: 'photo' })
  }
  if (m.video) {
    out.push({
      fileId: m.video.file_id,
      name: m.video.file_name ?? 'video.mp4',
      size: m.video.file_size,
      kind: 'video',
    })
  }
  if (m.audio) {
    out.push({
      fileId: m.audio.file_id,
      name: m.audio.file_name ?? 'audio.mp3',
      size: m.audio.file_size,
      kind: 'audio',
    })
  }
  if (m.voice) {
    out.push({ fileId: m.voice.file_id, name: 'voice.ogg', size: m.voice.file_size, kind: 'voice' })
  }
  if (m.video_note) {
    out.push({ fileId: m.video_note.file_id, name: 'video_note.mp4', size: m.video_note.file_size, kind: 'video' })
  }
  return out
}

async function handleIncoming(ctx: Context, files: IncomingFile[], text: string): Promise<void> {
  const scopeId = scopeFor(ctx)
  const ws = workspaceFor(scopeId)

  const downloaded: DownloadedFile[] = []
  for (const f of files) {
    try {
      downloaded.push(await downloadIncoming((id) => ctx.api.getFile(id), f, ws))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await ctx.reply(`⚠️ ${message}`)
    }
  }

  const prompt = text.trim() || (downloaded.length > 0 ? 'Посмотри приложенные файлы.' : '')
  if (!prompt) return

  const state = getChat(scopeId)
  const threadId = ctx.msg?.message_thread_id
  if (state.topicNameImplicit && threadId && !prompt.startsWith('/')) {
    const name = prompt.replace(/\s+/g, ' ').slice(0, 64)
    try {
      await ctx.api.editForumTopic(ctx.chat!.id, threadId, { name })
      state.topicNameImplicit = false
      save()
    } catch {}
  }

  if (downloaded.length > 0) {
    await ctx.reply(`📎 Принял ${downloaded.length} файл(ов) → inbox`)
  }

  await enqueue(ctx, scopeId, { prompt, files: downloaded })
}

bot.on('message:forum_topic_created', async (ctx) => {
  if (ctx.message.forum_topic_created.is_name_implicit) {
    getChat(scopeFor(ctx)).topicNameImplicit = true
    save()
  }
})

bot.on('message:forum_topic_edited', async (ctx) => {
  if (ctx.message.forum_topic_edited.name) {
    getChat(scopeFor(ctx)).topicNameImplicit = false
    save()
  }
})

bot.on('message:forum_topic_closed', async (ctx) => {
  const rt = runtimeFor(scopeFor(ctx))
  rt.queue.length = 0
  rt.abort?.abort()
})

bot.on('message', async (ctx) => {
  const m = ctx.message
  if (
    m.forum_topic_created ||
    m.forum_topic_edited ||
    m.forum_topic_closed ||
    m.forum_topic_reopened ||
    m.general_forum_topic_hidden ||
    m.general_forum_topic_unhidden
  ) {
    return
  }
  const files = extractFiles(ctx)
  const text = m.text ?? m.caption ?? ''

  if (files.length === 0 && !text.trim()) {
    await ctx.reply('Не понял, что с этим делать — пришли текст или файл с подписью.')
    return
  }

  // Альбом приходит несколькими апдейтами — собираем их вместе
  const groupId = m.media_group_id
  if (groupId) {
    const key = `${scopeFor(ctx)}:${groupId}`
    const existing = mediaGroups.get(key)
    if (existing) {
      existing.files.push(...files)
      if (text.trim()) existing.caption = text
      clearTimeout(existing.timer)
      existing.timer = setTimeout(() => {
        mediaGroups.delete(key)
        void handleIncoming(ctx, existing.files, existing.caption)
      }, 1500)
      return
    }
    const pending: PendingGroup = {
      files: [...files],
      caption: text,
      timer: setTimeout(() => {
        mediaGroups.delete(key)
        void handleIncoming(ctx, pending.files, pending.caption)
      }, 1500),
    }
    mediaGroups.set(key, pending)
    return
  }

  await handleIncoming(ctx, files, text)
})

/* ------------------------------------------------------------------- запуск */

bot.catch((err) => {
  console.error('[bot] необработанная ошибка:', err.error)
})

const shutdown = (signal: string): void => {
  console.log(`[bot] ${signal} — останавливаюсь`)
  saveNow()
  void bot.stop().finally(() => process.exit(0))
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))

console.log(`[bot] разрешённые пользователи: ${[...ALLOWED_USER_IDS].join(', ')}`)
try {
  await bot.api.setMyCommands(COMMANDS, { scope: { type: 'all_private_chats' } })
  await bot.api.setChatMenuButton({ menu_button: { type: 'commands' } })
} catch (err) {
  console.error('[bot] не удалось обновить меню команд:', err)
}
await bot.start({
  onStart: (info) => console.log(`[bot] запущен как @${info.username}`),
})
