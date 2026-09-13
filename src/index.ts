import path from 'node:path'
import fs from 'node:fs'
import { Bot, InputFile } from 'grammy'
import type { Context } from 'grammy'
import {
  ALLOWED_USER_IDS,
  BOT_TOKEN,
  MAX_SEND_BYTES,
  MODELS,
  PUBLIC_URL,
  PROGRESS_INTERVAL_MS,
  PROGRESS_TAIL,
  WEB_PORT,
} from './config.ts'
import { addUsage, deleteChat, getChat, listChats, rememberSession, resetSessionUsage, save, saveNow } from './state.ts'
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
import { startWebServer } from './web.ts'
import { browseFiles, resolveFile, uploadFile } from './web-files.ts'
import { changeDirectory, changeSession } from './topic-settings.ts'

const bot = new Bot(BOT_TOKEN)
let activeLogin: ReturnType<typeof startLogin> | null = null

/* ------------------------------------------------------------------ доступ */

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id
  if (!userId || !ALLOWED_USER_IDS.has(userId)) return // чужие не получают вообще ничего
  const chatType = ctx.chat?.type
  if (chatType && chatType !== 'private') return // только личка
  if (ctx.chat) {
    const scopeId = scopeFor(ctx)
    if (runtimes.get(scopeId)?.deleting || (deletedScopes.get(scopeId) ?? 0) > Date.now()) return
    deletedScopes.delete(scopeId)
  }
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
  run: { startedAt: number; action: string } | null
  draining: Promise<void> | null
  deleting: boolean
}

type ScopeId = string

const runtimes = new Map<ScopeId, Runtime>()
const deletedScopes = new Map<ScopeId, number>()

function scopeFor(ctx: Context): ScopeId {
  const chatId = ctx.chat?.id
  if (chatId === undefined) throw new Error('Нет Telegram chat id')
  const threadId = ctx.msg?.message_thread_id ?? 0
  return `${chatId}:${threadId}`
}

function runtimeFor(scopeId: ScopeId): Runtime {
  let rt = runtimes.get(scopeId)
  if (!rt) {
    rt = { queue: [], busy: false, abort: null, lastListing: [], run: null, draining: null, deleting: false }
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

class Progress {
  private lines: string[] = []
  private rendered = ''
  private timer: NodeJS.Timeout | null = null
  private closed = false

  private readonly ctx: Context
  private readonly messageId: number
  private readonly verbose: boolean

  constructor(ctx: Context, messageId: number, verbose: boolean) {
    this.ctx = ctx
    this.messageId = messageId
    this.verbose = verbose
    this.timer = setInterval(() => void this.flush(), PROGRESS_INTERVAL_MS)
  }

  add(line: string): void {
    this.lines.push(line)
    void this.flush()
  }

  private compose(): string {
    if (!this.verbose || this.lines.length === 0) return '⏳ Передаю задачу Claude…'
    const tail = this.lines.slice(-PROGRESS_TAIL)
    const hidden = this.lines.length - tail.length
    const head = hidden > 0 ? `⏳ Работаю… (+${hidden} шагов выше)\n` : '⏳ Работаю…\n'
    return head + tail.map((l) => `· ${l}`).join('\n')
  }

  private async flush(): Promise<void> {
    if (this.closed) return
    const text = this.compose().slice(0, 4000)
    if (text === this.rendered) return
    this.rendered = text
    try {
      await this.ctx.api.editMessageText(this.ctx.chat!.id, this.messageId, text)
    } catch {
    }
  }

  async finish(): Promise<void> {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    try {
      await this.ctx.api.deleteMessage(this.ctx.chat!.id, this.messageId)
    } catch {
    }
  }
}

class DraftStream {
  private draftId = 0
  private partial = ''
  private rendered = ''
  private started = false
  private waitingAfterTool = false
  private closed = false
  private lastSentAt = 0
  private dirty = false
  private flushTask: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null

  private readonly ctx: Context

  constructor(ctx: Context) {
    this.ctx = ctx
    this.allocateDraft()
    this.timer = setInterval(() => this.requestFlush(), 20_000)
  }

  resetForTool(): void {
    if (this.waitingAfterTool) return
    this.waitingAfterTool = true
    this.started = true
    this.partial = ''
    this.rendered = ''
    this.allocateDraft()
    this.requestFlush()
  }

  setPartial(text: string): void {
    this.waitingAfterTool = false
    this.started = true
    this.partial = text
    this.requestFlush()
  }

  async setFinal(text: string): Promise<void> {
    if (!text) return
    this.started = true
    this.partial = text
    this.requestFlush()
    await this.flushTask
  }

  private allocateDraft(): void {
    this.draftId = nextDraftId++
  }

  private requestFlush(): void {
    if (this.closed || !this.started) return
    this.dirty = true
    if (!this.flushTask) this.flushTask = this.flush().finally(() => (this.flushTask = null))
  }

  private async flush(): Promise<void> {
    while (this.dirty && !this.closed) {
      this.dirty = false
      const text = this.partial.length > 3800 ? `${this.partial.slice(0, 3799)}…` : this.partial
      if (text === this.rendered && Date.now() - this.lastSentAt < 20_000) continue
      this.rendered = text
      this.lastSentAt = Date.now()
      try {
        await this.ctx.api.sendMessageDraft(this.ctx.chat!.id, this.draftId, text, {
          message_thread_id: this.ctx.msg?.message_thread_id,
        })
      } catch {
      }
    }
  }

  async finish(): Promise<void> {
    this.closed = true
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

  const status = await ctx.reply('⏳ Передаю задачу Claude…')
  const progress = new Progress(ctx, status.message_id, state.verbose)
  const draft = new DraftStream(ctx)

  const abort = rt.abort!

  const since = Date.now()
  const filesNote =
    job.files.length > 0
      ? `\n\nПользователь приложил файлы:\n${job.files.map((f) => `- ${f.path}`).join('\n')}`
      : ''

  try {
    if (abort.signal.aborted) return
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
          if (rt.run) rt.run.action = e.label
          draft.resetForTool()
          progress.add(e.label)
        } else if (e.type === 'note') {
          if (rt.run) rt.run.action = e.text.slice(0, 160)
          progress.add(e.text)
        } else if (e.type === 'partial') {
          if (rt.run) rt.run.action = 'Готовит ответ'
          draft.setPartial(e.text)
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
    await draft.setFinal(result.text)
    await draft.finish()
    await progress.finish()
    if (abort.signal.aborted) await ctx.reply('⏹ Остановлено')

    if (result.text) await sendAnswer(ctx, result.text)
    else if (!abort.signal.aborted) await ctx.reply('(модель не вернула текст)')
    if (!abort.signal.aborted && summary) await ctx.reply(summary)

    if (rt.run) rt.run.action = 'Отправляет файлы'
    await sendArtifacts(ctx, ws, cwd, since, result.text)
  } catch (err) {
    const aborted = abort.signal.aborted || (err instanceof Error && err.name === 'AbortError')
    await draft.finish()
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
      rt.abort = new AbortController()
      rt.run = { startedAt: Date.now(), action: 'Передаёт запрос Claude' }
      await execute(ctx, scopeId, job)
    }
  } finally {
    rt.busy = false
    rt.abort = null
    rt.run = null
    rt.draining = null
    const state = getChat(scopeId)
    state.lastActivityAt = new Date().toISOString()
    save()
  }
}

async function enqueue(ctx: Context, scopeId: ScopeId, job: Job, rt: Runtime): Promise<void> {
  if (rt.deleting || runtimes.get(scopeId) !== rt) return
  getChat(scopeId).lastActivityAt = new Date().toISOString()
  save()
  rt.queue.push(job)
  if (rt.busy) {
    await ctx.reply(`⏳ Занят текущей задачей — поставил в очередь (${rt.queue.length}).`)
    return
  }
  rt.draining = drain(ctx, scopeId).catch((error) => {
    console.error('[queue] выполнение прервано:', error)
  })
}

/* ------------------------------------------------------------------ команды */

const COMMANDS = [
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

async function createTopic(ctx: Context, requestedName: string): Promise<void> {
  const requested = requestedName.replace(/\s+/g, ' ').trim().slice(0, 128)
  const name = requested || 'Новая задача'
  const topic = await ctx.api.createForumTopic(ctx.chat!.id, name)
  const scopeId = `${ctx.chat!.id}:${topic.message_thread_id}`
  const state = getChat(scopeId)
  state.topicName = name
  state.topicNameImplicit = !requested
  state.lastActivityAt = new Date().toISOString()
  save()
}

const HELP = [
  '<b>Прокси к Claude Code</b>',
  '',
  'Просто пиши промт — он уйдёт в модель. Можно прикладывать файлы и картинки:',
  'подпись к файлу становится промтом.',
  '',
  '<b>Сессия</b>',
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

bot.command('new_topic', async (ctx) => {
  try {
    const threadId = ctx.msg?.message_thread_id
    const state = getChat(scopeFor(ctx))
    if (threadId && state.topicNameImplicit) {
      const requested = ctx.match.replace(/\s+/g, ' ').trim().slice(0, 128)
      const name = requested || 'Новая задача'
      await ctx.api.editForumTopic(ctx.chat!.id, threadId, { name })
      state.topicName = name
      state.topicNameImplicit = false
      save()
      await ctx.reply(`🆕 Тема готова: ${name}`)
      return
    }
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
  state.topicName = name
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
  await ctx.answerCallbackQuery('Удаляю тему')
  try {
    await deleteTopicAndFiles(scopeId)
  } catch (error) {
    await ctx.reply(`Не удалось удалить тему: ${error instanceof Error ? error.message : String(error)}`)
  }
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
  try {
    changeSession(getChat(scopeId), null, runtimeFor(scopeId).busy)
    resetSessionUsage(scopeId)
    save()
    await ctx.reply('🆕 Начал новую сессию. Прежний контекст забыт.')
  } catch (error) {
    await ctx.reply(error instanceof Error ? error.message : String(error))
  }
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
  try {
    changeDirectory(getChat(scopeId), cwdFor(scopeId), ctx.match, runtimeFor(scopeId).busy)
    save()
    await ctx.reply(`Работаю в:\n${cwdFor(scopeId)}`)
  } catch (error) {
    await ctx.reply(error instanceof Error ? error.message : String(error))
  }
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
  await enqueue(ctx, scopeId, { prompt: 'ELI18 TLDR', files: [] }, runtimeFor(scopeId))
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
  try {
    if (changeSession(state, target.id, runtimeFor(scopeId).busy)) resetSessionUsage(scopeId)
    save()
    await ctx.reply(`↩️ Вернулся к сессии: ${target.title || target.id.slice(0, 8)}`)
  } catch (error) {
    await ctx.reply(error instanceof Error ? error.message : String(error))
  }
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
  const rt = runtimeFor(scopeId)
  if (rt.deleting) return
  const ws = workspaceFor(scopeId)

  const downloaded: DownloadedFile[] = []
  for (const f of files) {
    if (rt.deleting || runtimes.get(scopeId) !== rt) return
    try {
      downloaded.push(await downloadIncoming((id) => ctx.api.getFile(id), f, ws))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await ctx.reply(`⚠️ ${message}`)
    }
  }

  if (rt.deleting || runtimes.get(scopeId) !== rt) return
  const prompt = text.trim() || (downloaded.length > 0 ? 'Посмотри приложенные файлы.' : '')
  if (!prompt) return

  const state = getChat(scopeId)
  const threadId = ctx.msg?.message_thread_id
  if (state.topicNameImplicit && threadId && !prompt.startsWith('/')) {
    const name = prompt.replace(/\s+/g, ' ').slice(0, 64)
    try {
      await ctx.api.editForumTopic(ctx.chat!.id, threadId, { name })
      state.topicName = name
      state.topicNameImplicit = false
      save()
    } catch {}
  }

  if (downloaded.length > 0) {
    await ctx.reply(`📎 Принял ${downloaded.length} файл(ов) → inbox`)
  }

  await enqueue(ctx, scopeId, { prompt, files: downloaded }, rt)
}

bot.on('message:forum_topic_created', async (ctx) => {
  const state = getChat(scopeFor(ctx))
  state.topicName = ctx.message.forum_topic_created.name
  if (ctx.message.forum_topic_created.is_name_implicit) {
    state.topicNameImplicit = true
  }
  save()
})

bot.on('message:forum_topic_edited', async (ctx) => {
  if (ctx.message.forum_topic_edited.name) {
    const state = listChats().find(([id]) => id === scopeFor(ctx))?.[1]
    if (!state) return
    state.topicName = ctx.message.forum_topic_edited.name
    state.topicNameImplicit = false
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

function ownedScope(userId: number, scopeId: string): ScopeId {
  if (!scopeId.startsWith(`${userId}:`) || !listChats().some(([id]) => id === scopeId)) {
    throw new Error('Тред не найден')
  }
  if (runtimeFor(scopeId).deleting) throw new Error('Тред удаляется')
  return scopeId
}


type WebStatus = {
  authenticated: boolean
  limits: { title: string; percent: number; resetsAt: string | null }[]
  updatedAt: number
}

let webStatusCache: WebStatus | null = null
let webStatusPending: Promise<WebStatus> | null = null

async function getWebStatus(force: boolean): Promise<WebStatus> {
  if (!force && webStatusCache && Date.now() - webStatusCache.updatedAt < 60_000) return webStatusCache
  if (webStatusPending) return !force && webStatusCache ? webStatusCache : webStatusPending
  webStatusPending = Promise.all([
    authStatus(),
    fetchPlanUsage().catch(() => null),
  ]).then(([authenticated, usage]) => {
    webStatusCache = {
      authenticated,
      limits: usage?.rows.map((row) => ({ title: row.title, percent: row.percent, resetsAt: row.resetsAt })) ?? [],
      updatedAt: Date.now(),
    }
    return webStatusCache
  }).finally(() => { webStatusPending = null })
  if (!force && webStatusCache) {
    void webStatusPending.catch(() => {})
    return webStatusCache
  }
  return webStatusPending
}

async function deleteTopicAndFiles(scopeId: ScopeId): Promise<void> {
  const rt = runtimeFor(scopeId)
  if (rt.deleting) throw new Error('Тред уже удаляется')
  rt.deleting = true
  for (const [key, group] of mediaGroups) {
    if (!key.startsWith(`${scopeId}:`)) continue
    clearTimeout(group.timer)
    mediaGroups.delete(key)
  }
  rt.queue.length = 0
  rt.abort?.abort()
  let timer: NodeJS.Timeout | undefined
  try {
    if (rt.draining) {
      await Promise.race([
        rt.draining,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Claude ещё останавливается. Повтори удаление позже')), 15_000)
        }),
      ])
    }
    const [chatId, threadId] = scopeId.split(':').map(Number)
    if (threadId) {
      try {
        await bot.api.deleteForumTopic(chatId!, threadId)
      } catch (error) {
        if (!topicIsMissing(error)) throw error
      }
    }
    archiveWorkspace(scopeId)
    deleteChat(scopeId, { persist: true })
    runtimes.delete(scopeId)
    const now = Date.now()
    for (const [id, expiresAt] of deletedScopes) if (expiresAt <= now) deletedScopes.delete(id)
    if (threadId) deletedScopes.set(scopeId, now + 10 * 60_000)
  } finally {
    clearTimeout(timer)
    rt.deleting = false
  }
}

function topicIsMissing(error: unknown): boolean {
  const message = String(error).toLowerCase()
  return message.includes('message thread not found') || message.includes('topic not found')
    || message.includes('topic was deleted') || message.includes('topic_deleted')
    || message.includes('topic_id_invalid')
}

const webServer = startWebServer({
  port: WEB_PORT,
  botToken: BOT_TOKEN,
  allowedUsers: ALLOWED_USER_IDS,
  getOverview: async (userId, refreshStatus) => {
    const status = await getWebStatus(refreshStatus)
    const topics = listChats()
      .filter(([scopeId]) => scopeId.startsWith(`${userId}:`))
      .map(([scopeId, state]) => {
        const threadId = Number(scopeId.split(':')[1] ?? 0)
        const rt = runtimeFor(scopeId)
        const current = state.sessions.find((session) => session.id === state.sessionId)
        const cwd = cwdFor(scopeId)
        return {
          id: scopeId,
          threadId,
          name: state.topicName || current?.title || (threadId === 0 ? 'Основной чат' : `Тред ${threadId}`),
          model: MODELS.find((model) => model.id === state.model)?.label.split(' —')[0] ?? state.model,
          modelId: state.model,
          cwd,
          verbose: state.verbose,
          busy: rt.busy,
          queued: rt.queue.length,
          sessions: state.sessions,
          sessionId: state.sessionId,
          pinned: state.pinned === true,
          lastActivityAt: state.lastActivityAt ?? state.sessions[0]?.startedAt ?? null,
          run: rt.run ? { ...rt.run, stopping: rt.abort?.signal.aborted === true } : null,
        }
      })
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(b.busy) - Number(a.busy)
        || (Date.parse(b.lastActivityAt ?? '') || 0) - (Date.parse(a.lastActivityAt ?? '') || 0)
        || a.name.localeCompare(b.name, 'ru'))
    return {
      authenticated: status.authenticated,
      limits: status.limits,
      statusUpdatedAt: status.updatedAt,
      topics,
      models: MODELS,
      botUrl: bot.isInited() ? `https://t.me/${bot.botInfo.username}` : null,
    }
  },
  createTopic: async (userId, requestedName) => {
    const name = requestedName.replace(/\s+/g, ' ').trim().slice(0, 128)
    if (!name) throw new Error('Укажи название треда')
    const topic = await bot.api.createForumTopic(userId, name)
    const scopeId = `${userId}:${topic.message_thread_id}`
    const state = getChat(scopeId)
    state.topicName = name
    state.topicNameImplicit = false
    state.lastActivityAt = new Date().toISOString()
    save()
    return { ok: true, scopeId }
  },
  deleteAllTopics: async (userId) => {
    const scopes = listChats().map(([scopeId]) => scopeId).filter((scopeId) => scopeId.startsWith(`${userId}:`))
    let removed = 0
    let failed = 0
    for (const scopeId of scopes) {
      try {
        await deleteTopicAndFiles(scopeId)
        removed += 1
      } catch {
        failed += 1
      }
    }
    return { ok: failed === 0, removed, failed }
  },
  patchTopic: async (userId, requestedScope, patch) => {
    const scopeId = ownedScope(userId, requestedScope)
    const state = getChat(scopeId)
    const threadId = Number(scopeId.split(':')[1] ?? 0)
    const keys = Object.keys(patch)
    if (keys.length !== 1) throw new Error('Изменяй один параметр за раз')
    const key = keys[0]!
    const value = patch[key]
    if (key === 'name' && typeof value === 'string') {
      const name = value.replace(/\s+/g, ' ').trim().slice(0, 128)
      if (!threadId) throw new Error('Основной чат нельзя переименовать')
      if (!name) throw new Error('Название не может быть пустым')
      await bot.api.editForumTopic(userId, threadId, { name })
      state.topicName = name
      state.topicNameImplicit = false
    } else if (key === 'cwd' && typeof value === 'string') {
      changeDirectory(state, cwdFor(scopeId), value, runtimeFor(scopeId).busy)
    } else if (key === 'sessionId' && typeof value === 'string') {
      if (changeSession(state, value, runtimeFor(scopeId).busy)) resetSessionUsage(scopeId)
    } else if (key === 'verbose' && typeof value === 'boolean') {
      state.verbose = value
    } else if (key === 'pinned' && typeof value === 'boolean') {
      state.pinned = value
    } else if (key === 'model' && typeof value === 'string' && MODELS.some((model) => model.id === value)) {
      state.model = value
    } else {
      throw new Error('Неизвестный параметр или недопустимое значение')
    }
    save()
    return { ok: true }
  },
  deleteTopic: async (userId, requestedScope) => {
    const scopeId = ownedScope(userId, requestedScope)
    const threadId = Number(scopeId.split(':')[1] ?? 0)
    if (!threadId) throw new Error('Основной чат нельзя удалить')
    await deleteTopicAndFiles(scopeId)
    return { ok: true }
  },
  stopTopic: async (userId, requestedScope) => {
    const rt = runtimeFor(ownedScope(userId, requestedScope))
    rt.queue.length = 0
    rt.abort?.abort()
    return { ok: true }
  },
  newSession: async (userId, requestedScope) => {
    const scopeId = ownedScope(userId, requestedScope)
    changeSession(getChat(scopeId), null, runtimeFor(scopeId).busy)
    resetSessionUsage(scopeId)
    save()
    return { ok: true }
  },
  getFile: async (userId, requestedScope, requestedFile) => {
    const scopeId = ownedScope(userId, requestedScope)
    return resolveFile({ workspace: workspaceFor(scopeId), cwd: cwdFor(scopeId) }, requestedFile)
  },
  listFiles: async (userId, requestedScope, root, relative, offset) => {
    const scopeId = ownedScope(userId, requestedScope)
    return browseFiles({ workspace: workspaceFor(scopeId), cwd: cwdFor(scopeId) }, root, relative, offset)
  },
  uploadFile: async (userId, requestedScope, name, data) => {
    const scopeId = ownedScope(userId, requestedScope)
    return uploadFile({ workspace: workspaceFor(scopeId), cwd: cwdFor(scopeId) }, name, data)
  },
})

bot.catch((err) => {
  console.error('[bot] необработанная ошибка:', err.error)
})

const shutdown = (signal: string): void => {
  console.log(`[bot] ${signal} — останавливаюсь`)
  saveNow()
  webServer.close()
  void bot.stop().finally(() => process.exit(0))
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))

console.log(`[bot] разрешённые пользователи: ${[...ALLOWED_USER_IDS].join(', ')}`)
try {
  await bot.api.setMyCommands(COMMANDS, { scope: { type: 'all_private_chats' } })
  await bot.api.setChatMenuButton({
    menu_button: PUBLIC_URL
      ? { type: 'web_app', text: 'Управление', web_app: { url: PUBLIC_URL } }
      : { type: 'commands' },
  })
} catch (err) {
  console.error('[bot] не удалось обновить меню команд:', err)
}
await bot.start({
  onStart: (info) => console.log(`[bot] запущен как @${info.username}`),
})
