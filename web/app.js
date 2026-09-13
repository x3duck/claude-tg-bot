const tg = window.Telegram?.WebApp
tg?.ready()
tg?.expand()

const fallback = {
  authenticated: true,
  statusUpdatedAt: Date.now(),
  limits: [{ title: '5 часов', percent: 34 }, { title: 'Неделя', percent: 61 }],
  topics: [
    {
      id: 'preview:1', threadId: 1, name: 'claude-tg-bot', model: 'Opus 5', modelId: 'claude-opus-5', cwd: '/home/deploy/bot',
      verbose: true, busy: true, queued: 0, sessionId: 'a',
      sessions: [{ id: 'a', title: 'Текущая', startedAt: '2026-09-13T18:42:00Z' }],
      files: [
        { id: 'readme', name: 'README.md', kind: 'file', meta: '2.1 KB · сегодня, 17:24' },
        { id: 'package', name: 'package.json', kind: 'file', meta: '1.3 KB · сегодня, 16:03' },
      ],
    },
    { id: 'preview:2', threadId: 2, name: 'API платежей', model: 'Sonnet 5', modelId: 'claude-sonnet-5', cwd: '/home/deploy', verbose: false, busy: false, queued: 0, sessions: [], files: [] },
    { id: 'preview:3', threadId: 3, name: 'Новая идея', model: 'Opus 5', modelId: 'claude-opus-5', cwd: '/home/deploy', verbose: true, busy: false, queued: 0, sessions: [], files: [] },
  ],
}

const commandGroups = [
  ['Треды и сессии', [
    ['/new_topic Название', 'Создать отдельный тред'], ['/rename Название', 'Переименовать текущий тред'],
    ['/delete_topic', 'Удалить текущий тред'], ['/new', 'Начать с чистого контекста'],
    ['/sessions', 'Показать сохранённые сессии'], ['/resume 2', 'Вернуться к сессии по номеру'], ['/stop', 'Остановить задачу'],
  ]],
  ['Настройки', [
    ['/model', 'Выбрать модель'], ['/status', 'Состояние текущего треда'], ['/usage', 'Лимиты и расход'],
    ['/cd /путь', 'Сменить директорию'], ['/pwd', 'Показать директорию'], ['/verbose on', 'Показывать ход выполнения'], ['/tldr', 'Сжать последний ответ'],
  ]],
  ['Файлы и доступ', [
    ['/files', 'Показать файлы'], ['/get 1', 'Скачать файл по номеру'], ['/rm 1', 'Удалить файл по номеру'],
    ['/clean', 'Очистить файлы треда'], ['/auth_status', 'Проверить авторизацию'], ['/login', 'Обновить авторизацию Claude'], ['/help', 'Показать справку'],
  ]],
]

const models = [
  ['claude-fable-5', 'Fable 5'], ['claude-opus-5', 'Opus 5'],
  ['claude-sonnet-5', 'Sonnet 5'], ['claude-haiku-4-5', 'Haiku 4.5'],
]

const state = { data: fallback, selected: fallback.topics[0], loading: false, updatedAt: Date.now(), snapshot: '' }
const $ = (selector) => document.querySelector(selector)
const $$ = (selector) => [...document.querySelectorAll(selector)]

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', authorization: `tma ${tg?.initData || ''}`, ...options.headers },
  })
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || `HTTP ${response.status}`)
  return response.json()
}

function showToast(text) {
  const toast = $('#toast')
  toast.textContent = text
  toast.classList.add('show')
  clearTimeout(showToast.timer)
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2000)
}

function navigate(name) {
  if (name === 'files' && !state.selected) state.selected = state.data.topics[0] || null
  $$('.view').forEach((view) => view.classList.toggle('active', view.dataset.view === name))
  $$('.bottom-nav button').forEach((button) => button.classList.toggle('active', button.dataset.nav === name))
  $('.bottom-nav').classList.toggle('hidden', name === 'detail')
  if (name === 'files') renderFiles()
  tg?.HapticFeedback?.selectionChanged()
}

function renderLimits() {
  $('#limits').innerHTML = state.data.limits.map((limit) => `
    <div><div class="limit-head"><span>${escapeHtml(limit.title)}</span><span>${limit.percent}%</span></div>
    <div class="progress"><span style="width:${Math.max(0, Math.min(100, limit.percent))}%"></span></div></div>`).join('') || '<span class="muted">Данные недоступны</span>'
}

function renderThreads() {
  const query = $('#thread-search').value.trim().toLocaleLowerCase('ru')
  const topics = state.data.topics.filter((topic) => topic.name.toLocaleLowerCase('ru').includes(query))
  $('#thread-count').textContent = query ? `${topics.length} из ${state.data.topics.length}` : state.data.topics.length
  $('#delete-all-topics').disabled = state.data.topics.length === 0
  $('#delete-all-count').textContent = state.data.topics.length ? `${state.data.topics.length} ›` : '0'
  $('#threads-list').innerHTML = topics.map((topic) => `
    <button class="thread-row" data-topic="${escapeHtml(topic.id)}">
      <span class="status-dot ${topic.busy ? 'active' : ''}"></span>
      <span class="row-copy"><strong>${escapeHtml(topic.name)}</strong><small>${topic.busy ? 'Claude работает' : topic.sessions.length ? 'Готов' : 'Новая сессия'} · ${escapeHtml(topic.model)}</small></span>
      <span class="chevron">›</span>
    </button>`).join('')
  $$('[data-topic]').forEach((button) => button.addEventListener('click', () => openTopic(button.dataset.topic)))
}

function renderDetail() {
  const topic = state.selected
  if (!topic) return
  $('#detail-title').textContent = topic.name
  $('#detail-model').textContent = topic.model
  $('#detail-cwd').textContent = topic.cwd
  $('#verbose-toggle').checked = topic.verbose
  $('#rename-topic').disabled = topic.threadId === 0
  $('#rename-topic small').classList.toggle('hidden', topic.threadId === 0)
  $('#delete-topic').classList.toggle('hidden', topic.threadId === 0)
  $('#run-card').classList.toggle('hidden', !topic.busy)
  $('#run-card').innerHTML = topic.busy ? `
    <div class="run-status"><span class="status-dot active"></span><div><strong>Claude работает</strong><small>${topic.queued ? `В очереди: ${topic.queued}` : 'Выполняет текущую задачу'}</small></div></div>
    <button class="danger-button" id="stop-run">Остановить</button>` : ''
  $('#sessions-list').innerHTML = topic.sessions.map((session, index) => `
    <button class="session-row" data-session="${escapeHtml(session.id)}">
      <span class="file-icon">◷</span><span class="row-copy"><strong>${escapeHtml(session.title || `Сессия ${index + 1}`)}${session.id === topic.sessionId ? ' · текущая' : ''}</strong><small>${escapeHtml(formatDate(session.startedAt))}</small></span><span class="chevron">›</span>
    </button>`).join('')
  $('#stop-run')?.addEventListener('click', stopRun)
  $$('[data-session]').forEach((button) => button.addEventListener('click', () => selectSession(button.dataset.session)))
}

function openTopic(id) {
  state.selected = state.data.topics.find((topic) => topic.id === id) || state.data.topics[0] || null
  renderDetail()
  navigate('detail')
}

function renderFiles() {
  const topic = state.selected
  $('#files-topic-name').textContent = topic?.name || 'Нет выбранного треда'
  $('#workspace-path').textContent = topic?.cwd || '—'
  $('#files-list').innerHTML = (topic?.files || []).map((file) => `
    <button class="file-row" data-file="${escapeHtml(file.id)}">
      <span class="file-icon">▤</span><span class="row-copy"><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.meta)}</small></span><span class="chevron">↓</span>
    </button>`).join('')
  $$('[data-file]').forEach((button) => button.addEventListener('click', () => downloadFile(button.dataset.file)))
}

function renderAuth() {
  const ok = state.data.authenticated
  $('#auth-chip').textContent = ok ? 'Подключён' : 'Нужен вход'
  $('#auth-chip').className = `chip ${ok ? 'success' : 'warning'}`
  $('#auth-state').textContent = ok ? 'Авторизация активна' : 'Требуется вход'
  $('#auth-state').style.color = ok ? 'var(--green)' : '#ffbc45'
  $('#auth-checked').textContent = state.data.statusUpdatedAt ? `Проверено ${relativeTime(state.data.statusUpdatedAt)}` : 'Статус ещё не проверен'
}

function renderCommands() {
  $('#commands-list').innerHTML = commandGroups.map(([title, commands]) => `
    <div class="command-group"><h2>${escapeHtml(title)}</h2><div class="card">
      ${commands.map(([command, description]) => `<button class="command-row" data-command="${escapeHtml(command)}"><span class="row-copy"><code>${escapeHtml(command)}</code><small>${escapeHtml(description)}</small></span><span class="copy-mark">⧉</span></button>`).join('')}
    </div></div>`).join('')
  $$('[data-command]').forEach((button) => button.addEventListener('click', () => copyText(button.dataset.command)))
}

function render() {
  renderLimits()
  renderThreads()
  renderAuth()
  renderFiles()
  renderCommands()
  if ($('[data-view="detail"]').classList.contains('active')) renderDetail()
}

async function load({ forceStatus = false, silent = false } = {}) {
  if (state.loading) return
  state.loading = true
  const selectedId = state.selected?.id
  try {
    const data = await api(`/api/overview${forceStatus ? '?refresh=status' : ''}`)
    const snapshot = JSON.stringify(data)
    state.data = data
    state.selected = data.topics.find((topic) => topic.id === selectedId) || data.topics[0] || null
    state.updatedAt = Date.now()
    if (snapshot !== state.snapshot) {
      state.snapshot = snapshot
      render()
    }
    updateFreshness()
    if (forceStatus) showToast('Статус обновлён')
  } catch (error) {
    if (tg?.initData && !silent) showToast(error.message || 'Не удалось загрузить данные')
  } finally {
    state.loading = false
  }
}

async function createOrRenameTopic(event) {
  event.preventDefault()
  const dialog = $('#topic-dialog')
  const name = $('#topic-name').value.trim()
  if (!name) return
  const mode = dialog.dataset.mode
  try {
    if (mode === 'rename') {
      await api(`/api/topics/${encodeURIComponent(state.selected.id)}`, { method: 'PATCH', body: JSON.stringify({ name }) })
      state.selected.name = name
      showToast('Тред переименован')
    } else {
      const result = await api('/api/topics', { method: 'POST', body: JSON.stringify({ name }) })
      await load({ silent: true })
      state.selected = state.data.topics.find((topic) => topic.id === result.scopeId) || state.selected
      showToast('Тред создан')
    }
    dialog.close()
    render()
  } catch (error) { showToast(error.message) }
}

async function deleteTopic() {
  try {
    await api(`/api/topics/${encodeURIComponent(state.selected.id)}`, { method: 'DELETE' })
    $('#delete-dialog').close()
    const deletedId = state.selected.id
    state.data.topics = state.data.topics.filter((topic) => topic.id !== deletedId)
    state.selected = state.data.topics[0] || null
    render()
    navigate('threads')
    showToast('Тред удалён, файлы в архиве')
  } catch (error) { showToast(error.message) }
}

async function deleteAllTopics() {
  const button = $('#confirm-delete-all')
  button.disabled = true
  button.textContent = 'Удаляю…'
  try {
    const result = await api('/api/topics', { method: 'DELETE' })
    $('#delete-all-dialog').close()
    state.snapshot = ''
    await load({ silent: true })
    navigate('threads')
    showToast(result.failed ? `Удалено: ${result.removed}, ошибок: ${result.failed}` : `Удалено тредов: ${result.removed}`)
  } catch (error) {
    showToast(error.message)
  } finally {
    button.disabled = false
    button.textContent = 'Удалить всё'
  }
}

async function stopRun() {
  try {
    await api(`/api/topics/${encodeURIComponent(state.selected.id)}/stop`, { method: 'POST', body: '{}' })
    state.selected.busy = false
    render()
    showToast('Останавливаю')
  } catch (error) { showToast(error.message) }
}

async function selectSession(sessionId) {
  try {
    await api(`/api/topics/${encodeURIComponent(state.selected.id)}`, { method: 'PATCH', body: JSON.stringify({ sessionId }) })
    state.selected.sessionId = sessionId
    renderDetail()
    showToast('Сессия выбрана')
  } catch (error) { showToast(error.message) }
}

async function downloadFile(fileId) {
  const file = state.selected.files.find((item) => item.id === fileId)
  if (!file) return
  showToast('Скачиваю файл…')
  try {
    const response = await fetch(`/api/topics/${encodeURIComponent(state.selected.id)}/files/${encodeURIComponent(fileId)}`, { headers: { authorization: `tma ${tg?.initData || ''}` } })
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || `HTTP ${response.status}`)
    const href = URL.createObjectURL(await response.blob())
    const link = document.createElement('a')
    link.href = href
    link.download = file.name
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(href), 30_000)
    showToast('Файл скачан')
  } catch (error) { showToast(error.message) }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
  tg?.HapticFeedback?.notificationOccurred('success')
  showToast(`Скопировано: ${text}`)
}

function openTopicDialog(mode) {
  const rename = mode === 'rename'
  $('#topic-dialog').dataset.mode = mode
  $('#topic-dialog-title').textContent = rename ? 'Переименовать тред' : 'Новый тред'
  $('#topic-submit').textContent = rename ? 'Сохранить' : 'Создать'
  $('#topic-name').value = rename ? state.selected.name : ''
  $('#topic-dialog').showModal()
  setTimeout(() => $('#topic-name').focus(), 100)
}

function updateFreshness() {
  const text = relativeTime(state.updatedAt)
  $('#last-update').textContent = text
  $('#sync-state').textContent = `Обновлено ${text}`
}

function relativeTime(value) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000))
  if (seconds < 5) return 'только что'
  if (seconds < 60) return `${seconds} сек. назад`
  return `${Math.floor(seconds / 60)} мин. назад`
}

function formatDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char])
}

$$('[data-nav]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.nav)))
$$('[data-close]').forEach((button) => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()))
$('#thread-search').addEventListener('input', renderThreads)
$('#create-topic').addEventListener('click', () => openTopicDialog('create'))
$('#rename-topic').addEventListener('click', () => openTopicDialog('rename'))
$('#delete-topic').addEventListener('click', () => $('#delete-dialog').showModal())
$('#confirm-delete').addEventListener('click', deleteTopic)
$('#delete-all-topics').addEventListener('click', () => {
  const count = state.data.topics.length
  $('#delete-all-copy').textContent = `Будет удалено тредов: ${count}. Все задачи остановятся, а рабочие файлы переедут в архив.`
  $('#delete-all-dialog').showModal()
})
$('#confirm-delete-all').addEventListener('click', deleteAllTopics)
$('#topic-form').addEventListener('submit', createOrRenameTopic)
$('#cwd-row').addEventListener('click', () => {
  $('#cwd-input').value = state.selected.cwd
  $('#cwd-dialog').showModal()
})
$('#cwd-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  try {
    const cwd = $('#cwd-input').value.trim()
    await api(`/api/topics/${encodeURIComponent(state.selected.id)}`, { method: 'PATCH', body: JSON.stringify({ cwd }) })
    $('#cwd-dialog').close()
    await load({ silent: true })
    showToast('Директория изменена')
  } catch (error) { showToast(error.message) }
})
$('#verbose-toggle').addEventListener('change', async (event) => {
  const value = event.target.checked
  state.selected.verbose = value
  try { await api(`/api/topics/${encodeURIComponent(state.selected.id)}`, { method: 'PATCH', body: JSON.stringify({ verbose: value }) }) }
  catch (error) { showToast(error.message) }
})
$('#model-row').addEventListener('click', () => {
  $('#model-options').innerHTML = models.map(([id, label]) => `<button class="model-option" data-model="${id}"><strong>${label}</strong><span>${state.selected.modelId === id ? '✓' : ''}</span></button>`).join('')
  $$('[data-model]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await api(`/api/topics/${encodeURIComponent(state.selected.id)}`, { method: 'PATCH', body: JSON.stringify({ model: button.dataset.model }) })
      state.selected.modelId = button.dataset.model
      state.selected.model = models.find(([id]) => id === button.dataset.model)[1]
      $('#model-dialog').close()
      render()
    } catch (error) { showToast(error.message) }
  }))
  $('#model-dialog').showModal()
})
$('#new-session').addEventListener('click', async () => {
  try {
    await api(`/api/topics/${encodeURIComponent(state.selected.id)}/new-session`, { method: 'POST', body: '{}' })
    state.selected.sessionId = null
    renderDetail()
    showToast('Новая сессия создана')
  } catch (error) { showToast(error.message) }
})
$('#workspace-path').addEventListener('click', () => state.selected && openTopic(state.selected.id))
$('#refresh-auth').addEventListener('click', async () => {
  const button = $('#refresh-auth')
  button.disabled = true
  button.textContent = 'Проверяю…'
  await load({ forceStatus: true })
  button.disabled = false
  button.textContent = 'Проверить'
})

render()
load()
setInterval(updateFreshness, 1000)
setInterval(() => { if (!document.hidden) void load({ silent: true }) }, 4000)
document.addEventListener('visibilitychange', () => { if (!document.hidden) void load({ silent: true }) })
