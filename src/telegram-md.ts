import { CHUNK_LIMIT } from './config.ts'

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Маркер вырезанного блока. Управляющий символ не встречается в тексте модели
// и не трогается escapeHtml, поэтому placeholder гарантированно переживёт
// все последующие замены.
const MARK = String.fromCharCode(1)
const markRe = new RegExp(`${MARK}(\\d+)${MARK}`, 'g')

/**
 * Переводит markdown, который пишет модель, в подмножество HTML,
 * понятное Telegram (parse_mode: 'HTML').
 */
export function mdToHtml(md: string): string {
  const blocks: string[] = []
  const keep = (html: string): string => MARK + String(blocks.push(html) - 1) + MARK

  let text = md.split(MARK).join('')

  // Блоки кода ```lang ... ```
  text = text.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_all, lang: string, code: string) => {
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : ''
    return keep(`<pre><code${cls}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`)
  })

  // Инлайновый код `...`
  text = text.replace(/`([^`\n]+)`/g, (_all, code: string) => keep(`<code>${escapeHtml(code)}</code>`))

  text = escapeHtml(text)

  // Ссылки [текст](url)
  text = text.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_all, label: string, url: string) => `<a href="${url.replace(/"/g, '%22')}">${label}</a>`,
  )

  // Заголовки — жирной строкой
  text = text.replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, '<b>$1</b>')

  // Горизонтальных линеек в Telegram нет
  text = text.replace(/^\s*(?:---|\*\*\*|___)\s*$/gm, '—')

  text = text.replace(/\*\*([^\n*]+)\*\*/g, '<b>$1</b>')
  text = text.replace(/__([^\n_]+)__/g, '<b>$1</b>')
  text = text.replace(/~~([^\n~]+)~~/g, '<s>$1</s>')
  text = text.replace(/(^|[\s(])\*([^\n*]+)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>')

  // Маркеры списков
  text = text.replace(/^(\s*)[-*+]\s+/gm, '$1• ')

  return text.replace(markRe, (_all, i: string) => blocks[Number(i)] ?? '')
}

/**
 * Режет markdown на куски под лимит Telegram, не разрывая блоки кода.
 * Резать нужно до конвертации в HTML, иначе можно порвать тег.
 */
export function splitMarkdown(md: string, limit = CHUNK_LIMIT): string[] {
  const chunks: string[] = []
  let current = ''
  let fence: string | null = null

  const push = (): void => {
    const trimmed = current.replace(/\s+$/, '')
    if (trimmed) chunks.push(trimmed)
    current = ''
  }

  for (const rawLine of md.split('\n')) {
    let line = rawLine
    const fenceMatch = /^\s*(```|~~~)/.exec(line)
    const opensFence: boolean = fenceMatch !== null && fence === null

    // Одна строка длиннее лимита — рвём принудительно
    while (line.length > limit) {
      if (current) push()
      chunks.push(line.slice(0, limit))
      line = line.slice(limit)
    }

    if (current !== '' && current.length + line.length + 1 > limit) {
      if (fence !== null) {
        // Внутри блока кода: закрываем его, режем, открываем заново
        current += `\n${fence}`
        push()
        current = fence
      } else {
        push()
      }
    }

    current += (current === '' ? '' : '\n') + line
    if (fenceMatch) fence = opensFence ? (fenceMatch[1] as string) : null
  }

  push()
  return chunks.length > 0 ? chunks : ['']
}

/** Готовые к отправке HTML-куски. */
export function renderForTelegram(md: string): string[] {
  return splitMarkdown(md).map(mdToHtml)
}
