const tg = window.Telegram?.WebApp
tg?.ready()
tg?.expand()

const fallback = {
  authenticated: true,
  limits: [
    { title: '5 часов', percent: 34 },
    { title: 'Неделя', percent: 61 },
  ],
  topics: [
    {
      id: 'preview:1', name: 'claude-tg-bot', model: 'Opus 5', modelId: 'claude-opus-5', cwd: '/home/deploy/bot',
      verbose: true, busy: true, queued: 0,
      sessions: [{ id: 'a', title: 'Текущая', startedAt: '13 сентября, 18:42' }],
      files: [
        { name: 'src', kind: 'folder', meta: 'Папка · 8 файлов' },
        { name: 'README.md', kind: 'file', meta: '2.1 KB · сегодня, 17:24' },
        { name: 'package.json', kind: 'file', meta: '1.3 KB · сегодня, 16:03' },
        { name: 'bot.service', kind: 'file', meta: '4.7 KB · вчера, 14:18' },
      ],
    },
    { id: 'preview:2', name: 'API платежей', model: 'Sonnet 5', modelId: 'claude-sonnet-5', cwd: '/home/deploy', verbose: false, busy: false, queued: 0, sessions: [], files: [] },
    { id: 'preview:3', name: 'Новая идея', model: 'Opus 5', modelId: 'claude-opus-5', cwd: '/home/deploy', verbose: true, busy: false, queued: 0, sessions: [], files: [] },
  ],
}

const state = { data: fallback, selected: fallback.topics[0] }
const $ = (selector) => document.querySelector(selector)
const $$ = (selector) => [...document.querySelectorAll(selector)]

function api(path, options = {}) {
  const initData = tg?.initData || ''
  return fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', authorization: `tma ${initData}`, ...options.headers },
  }).then(async (res) => {
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`)
    return res.json()
  })
}

function showToast(text) {
  const toast = $('#toast')
  toast.textContent = text
  toast.classList.add('show')
  setTimeout(() => toast.classList.remove('show'), 1800)
}

function navigate(name) {
  $$('.view').forEach((view) => view.classList.toggle('active', view.dataset.view === name))
  $$('.bottom-nav button').forEach((button) => button.classList.toggle('active', button.dataset.nav === name))
  $('.bottom-nav').classList.toggle('hidden', name === 'detail')
  tg?.HapticFeedback?.selectionChanged()
}

function renderLimits() {
  $('#limits').innerHTML = state.data.limits.map((limit) => `
    <div>
      <div class="limit-head"><span>${escapeHtml(limit.title)}</span><span>${limit.percent}%</span></div>
      <div class="progress"><span style="width:${Math.max(0, Math.min(100, limit.percent))}%"></span></div>
    </div>`).join('') || '<span class="muted">Данные недоступны</span>'
}

function renderThreads() {
  $('#thread-count').textContent = state.data.topics.length
  $('#threads-list').innerHTML = state.data.topics.map((topic) => `
    <button class="thread-row" data-topic="${escapeHtml(topic.id)}">
      <span class="status-dot ${topic.busy ? 'active' : ''}"></span>
      <span class="row-copy"><strong>${escapeHtml(topic.name)}</strong><small>${topic.busy ? 'Выполняется' : topic.sessions.length ? 'Готов' : 'Новая сессия'} · ${escapeHtml(topic.model)}</small></span>
      <span class="chevron">›</span>
    </button>`).join('')
  $$('[data-topic]').forEach((button) => button.addEventListener('click', () => openTopic(button.dataset.topic)))
}

function openTopic(id) {
  state.selected = state.data.topics.find((topic) => topic.id === id) || state.data.topics[0]
  const topic = state.selected
  $('#detail-title').textContent = topic.name
  $('#detail-model').textContent = topic.model
  $('#detail-cwd').textContent = topic.cwd
  $('#verbose-toggle').checked = topic.verbose
  $('#run-card').classList.toggle('hidden', !topic.busy)
  $('#run-card').innerHTML = topic.busy ? `
    <div class="run-status"><span class="status-dot active"></span><div><strong>Claude работает</strong><small>${topic.queued ? `В очереди: ${topic.queued}` : 'Выполняет текущую задачу'}</small></div></div>
    <button class="danger-button" id="stop-run">Остановить</button>` : ''
  $('#sessions-list').innerHTML = topic.sessions.map((session, index) => `
    <button class="session-row" data-session="${escapeHtml(session.id)}" style="grid-template-columns:34px 1fr auto">
      <span class="file-icon">◷</span><span class="row-copy"><strong>${escapeHtml(session.title || `Сессия ${index + 1}`)}${session.id === topic.sessionId ? ' · текущая' : ''}</strong><small>${escapeHtml(formatDate(session.startedAt))}</small></span><span class="chevron">›</span>
    </button>`).join('')
  $('#stop-run')?.addEventListener('click', stopRun)
  $$('[data-session]').forEach((button) => button.addEventListener('click', () => selectSession(button.dataset.session)))
  renderFiles()
  navigate('detail')
}

function renderFiles() {
  const topic = state.selected || state.data.topics[0]
  $('#workspace-path').textContent = topic?.cwd || '—'
  $('#files-list').innerHTML = (topic?.files || []).map((file) => `
    <button class="file-row"><span class="file-icon">${file.kind === 'folder' ? '□' : '▤'}</span><span class="row-copy"><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.meta)}</small></span><span class="chevron">›</span></button>`).join('')
}

async function stopRun() {
  try {
    await api(`/api/topics/${encodeURIComponent(state.selected.id)}/stop`, { method: 'POST', body: '{}' })
    state.selected.busy = false
    renderThreads()
    openTopic(state.selected.id)
    showToast('Останавливаю')
  } catch (error) { showToast(error.message) }
}

async function selectSession(sessionId) {
  try {
    await api(`/api/topics/${encodeURIComponent(state.selected.id)}`, { method: 'PATCH', body: JSON.stringify({ sessionId }) })
    state.selected.sessionId = sessionId
    openTopic(state.selected.id)
    showToast('Сессия выбрана')
  } catch (error) { showToast(error.message) }
}

function renderAuth() {
  $('#auth-chip').textContent = state.data.authenticated ? 'Подключён' : 'Нужен вход'
  $('#auth-chip').className = `chip ${state.data.authenticated ? 'success' : 'warning'}`
  $('#auth-state').textContent = state.data.authenticated ? 'Авторизация активна' : 'Требуется вход'
  $('#auth-state').style.color = state.data.authenticated ? 'var(--green)' : '#ffbc45'
}

function render() {
  renderLimits()
  renderThreads()
  renderAuth()
  renderFiles()
}

async function load() {
  const selectedId = state.selected?.id
  try {
    state.data = await api('/api/overview')
    state.selected = state.data.topics.find((topic) => topic.id === selectedId) || state.data.topics[0] || null
  } catch {
    if (tg?.initData) showToast('Не удалось загрузить данные')
  }
  render()
}

function formatDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char])
}

$$('[data-nav]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.nav)))
$$('[data-section]').forEach((button) => button.addEventListener('click', () => {
  $$('[data-section]').forEach((item) => item.classList.toggle('active', item === button))
  $('#files-section').classList.toggle('hidden', button.dataset.section !== 'files')
  $('#auth-section').classList.toggle('hidden', button.dataset.section !== 'auth')
}))
$('[data-section-link="auth"]').addEventListener('click', () => {
  navigate('files')
  $('[data-section="auth"]').click()
})
$('#verbose-toggle').addEventListener('change', async (event) => {
  const value = event.target.checked
  state.selected.verbose = value
  try { await api(`/api/topics/${encodeURIComponent(state.selected.id)}`, { method: 'PATCH', body: JSON.stringify({ verbose: value }) }) }
  catch (error) { showToast(error.message) }
})
const models = [
  ['claude-fable-5', 'Fable 5'],
  ['claude-opus-5', 'Opus 5'],
  ['claude-sonnet-5', 'Sonnet 5'],
  ['claude-haiku-4-5', 'Haiku 4.5'],
]
$('#model-row').addEventListener('click', () => {
  $('#model-options').innerHTML = models.map(([id, label]) => `<button class="model-option" data-model="${id}"><strong>${label}</strong><span>${state.selected.modelId === id ? '✓' : ''}</span></button>`).join('')
  $$('[data-model]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await api(`/api/topics/${encodeURIComponent(state.selected.id)}`, { method: 'PATCH', body: JSON.stringify({ model: button.dataset.model }) })
      state.selected.modelId = button.dataset.model
      state.selected.model = models.find(([id]) => id === button.dataset.model)[1]
      $('#model-dialog').close()
      openTopic(state.selected.id)
    } catch (error) { showToast(error.message) }
  }))
  $('#model-dialog').showModal()
})
$('#close-model').addEventListener('click', () => $('#model-dialog').close())
$('#new-session').addEventListener('click', async () => {
  try {
    await api(`/api/topics/${encodeURIComponent(state.selected.id)}/new-session`, { method: 'POST', body: '{}' })
    state.selected.sessionId = null
    openTopic(state.selected.id)
    showToast('Новая сессия создана')
  } catch (error) { showToast(error.message) }
})
$('#refresh-auth').addEventListener('click', load)
$('#refresh-all').addEventListener('click', load)

load()
