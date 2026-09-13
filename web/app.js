import { mountPdfPreview } from './pdf-preview.js'

const tg = window.Telegram?.WebApp
tg?.ready()
tg?.expand()

const demoMode = new URLSearchParams(location.search).get('demo') === '1'
const STATUS_FORCE_MIN_INTERVAL_MS = 60_000
const demoData = {
  authenticated: true,
  statusUpdatedAt: new Date(Date.now() - 42_000).toISOString(),
  limits: [
    { title: '5 часов', percent: 34, resetsAt: new Date(Date.now() + 7_100_000).toISOString() },
    { title: 'Неделя', percent: 61, resetsAt: new Date(Date.now() + 291_000_000).toISOString() },
  ],
  models: [
    { id: 'claude-opus-4-1', label: 'Opus' },
    { id: 'claude-sonnet-4-5', label: 'Sonnet' },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  ],
  botUrl: 'https://t.me/example_bot',
  topics: [
    { id: 'demo-1', threadId: 41, name: 'Сравнение предложений', model: 'Sonnet', modelId: 'claude-sonnet-4-5', cwd: '/home/deploy/contracts', verbose: true, busy: true, queued: 1, sessionId: 's1', pinned: false, lastActivityAt: new Date(Date.now() - 58_000).toISOString(), run: { startedAt: Date.now() - 84_000, action: 'Читает предложение.pdf', stopping: false }, sessions: [{ id: 's1', title: 'Сравнить условия поставщиков', startedAt: new Date().toISOString(), cwd: '/home/deploy/contracts' }, { id: 's2', title: 'Разобрать предложения', startedAt: new Date(Date.now() - 86_400_000).toISOString(), cwd: '/home/deploy/contracts' }] },
    { id: 'demo-2', threadId: 42, name: 'Документы', model: 'Opus', modelId: 'claude-opus-4-1', cwd: '/home/deploy/docs', verbose: false, busy: false, queued: 0, sessionId: 's3', pinned: true, lastActivityAt: new Date(Date.now() - 720_000).toISOString(), run: null, sessions: [{ id: 's3', title: 'Сводка документов', startedAt: new Date(Date.now() - 720_000).toISOString(), cwd: '/home/deploy/docs' }] },
    { id: 'demo-3', threadId: 43, name: 'План поездки', model: 'Haiku 4.5', modelId: 'claude-haiku-4-5', cwd: '/home/deploy/travel', verbose: true, busy: false, queued: 0, sessionId: null, pinned: true, lastActivityAt: new Date(Date.now() - 86_400_000).toISOString(), run: null, sessions: [] },
    { id: 'demo-4', threadId: 44, name: 'Исследование рынка', model: 'Sonnet', modelId: 'claude-sonnet-4-5', cwd: '/home/deploy/research', verbose: true, busy: false, queued: 0, sessionId: 's4', pinned: false, lastActivityAt: new Date(Date.now() - 15_400_000).toISOString(), run: null, sessions: [{ id: 's4', title: 'Первичный обзор', startedAt: new Date(Date.now() - 15_400_000).toISOString(), cwd: '/home/deploy/research' }] },
  ],
}

const demoFiles = {
  'workspace:': [
    { id: 'folder-inbox', name: 'inbox', kind: 'directory', path: 'inbox', size: 0, mtime: Date.now() - 50_000, preview: null },
    { id: 'folder-outbox', name: 'outbox', kind: 'directory', path: 'outbox', size: 0, mtime: Date.now() - 80_000, preview: null },
    { id: 'readme', name: 'README.md', kind: 'file', path: 'README.md', size: 4388, mtime: Date.now() - 280_000, preview: 'markdown' },
  ],
  'workspace:outbox': [
    { id: 'comparison', name: 'сравнение.md', kind: 'file', path: 'outbox/сравнение.md', size: 4301, mtime: Date.now() - 90_000, preview: 'markdown' },
    { id: 'pdf', name: 'предложение.pdf', kind: 'file', path: 'outbox/предложение.pdf', size: 839680, mtime: Date.now() - 220_000, preview: 'pdf' },
    { id: 'binary', name: 'архив.zip', kind: 'file', path: 'outbox/архив.zip', size: 1500000, mtime: Date.now() - 300_000, preview: null },
  ],
  'cwd:': [
    { id: 'src-dir', name: 'src', kind: 'directory', path: 'src', size: 0, mtime: Date.now() - 400_000, preview: null },
    { id: 'package', name: 'package.json', kind: 'file', path: 'package.json', size: 1260, mtime: Date.now() - 600_000, preview: 'text' },
  ],
}

const commandGroups = [
  ['Треды и сессии', [['/new_topic Название', 'Создать тред'], ['/rename Название', 'Переименовать тред'], ['/delete_topic', 'Удалить тред'], ['/new', 'Новая сессия'], ['/sessions', 'Список сессий'], ['/resume 2', 'Продолжить сессию'], ['/stop', 'Остановить задачу']]],
  ['Настройки', [['/model', 'Выбрать модель'], ['/status', 'Состояние треда'], ['/usage', 'Лимиты подписки'], ['/cd /путь', 'Сменить директорию'], ['/pwd', 'Показать директорию'], ['/verbose on', 'Показывать ход работы'], ['/tldr', 'Сжать последний ответ']]],
  ['Файлы и доступ', [['/files', 'Список файлов'], ['/get 1', 'Скачать файл'], ['/rm 1', 'Удалить файл'], ['/clean', 'Очистить файлы'], ['/auth_status', 'Проверить вход'], ['/login', 'Войти в Claude'], ['/help', 'Показать справку']]],
]

const state = {
  data: null,
  selectedId: localStorage.getItem('vesperloop:selected-topic'),
  view: 'threads',
  overviewLoading: false,
  overviewPromise: null,
  overviewForceChain: Promise.resolve(),
  overviewAbort: null,
  overviewRequest: 0,
  overviewError: null,
  lastStatusForceAt: 0,
  lastSuccessAt: null,
  stale: false,
  submitting: new Set(),
  newSessionPending: null,
  files: { topicId: null, root: 'workspace', path: '', entries: [], nextOffset: null, pagesLoaded: 0, loading: false, loadingVisible: false, request: 0, error: null, uploadNotice: null, returnView: null },
  preview: { file: null, topicId: null, url: null, pdfViewer: null, request: 0 },
}

const $ = (selector) => document.querySelector(selector)
const $$ = (selector) => [...document.querySelectorAll(selector)]
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="/icons.svg#${name}" /></svg>`
const renderedHtml = new WeakMap()
const nodeKey = (node) => node.nodeType === Node.ELEMENT_NODE
  ? ['key', 'topic', 'session', 'file', 'filesTopicOption', 'crumb', 'model'].map((key) => node.dataset[key]).find((value) => value !== undefined) ?? null
  : null

function sameNodeType(current, next) {
  if (current.nodeType !== next.nodeType) return false
  if (current.nodeType !== Node.ELEMENT_NODE) return true
  const currentKey = nodeKey(current)
  const nextKey = nodeKey(next)
  return current.localName === next.localName && current.namespaceURI === next.namespaceURI && currentKey === nextKey
}

function patchNode(current, next) {
  if (current.nodeType === Node.TEXT_NODE) {
    if (current.data === next.data) return false
    current.data = next.data
    return true
  }
  let changed = false
  for (const attribute of [...current.attributes]) {
    if (!next.hasAttribute(attribute.name)) {
      current.removeAttribute(attribute.name)
      changed = true
    }
  }
  for (const attribute of [...next.attributes]) {
    if (current.getAttribute(attribute.name) !== attribute.value) {
      current.setAttribute(attribute.name, attribute.value)
      changed = true
    }
  }
  return patchChildren(current, next) || changed
}

function patchChildren(current, next) {
  let changed = false
  let cursor = current.firstChild
  for (const desired of [...next.childNodes]) {
    let match = cursor
    if (!match || !sameNodeType(match, desired)) {
      match = [...current.childNodes].find((candidate) => candidate !== cursor && sameNodeType(candidate, desired)) || null
      if (match) current.insertBefore(match, cursor)
      else {
        match = desired.cloneNode(true)
        current.insertBefore(match, cursor)
      }
      changed = true
    }
    changed = patchNode(match, desired) || changed
    cursor = match.nextSibling
  }
  while (cursor) {
    const nextSibling = cursor.nextSibling
    cursor.remove()
    cursor = nextSibling
    changed = true
  }
  return changed
}

function updateHtml(element, markup) {
  if (renderedHtml.get(element) === markup) return false
  const template = document.createElement('template')
  template.innerHTML = markup
  const changed = patchChildren(element, template.content)
  renderedHtml.set(element, markup)
  return changed
}
const topicById = (id) => state.data?.topics.find((topic) => topic.id === id) || null
const selectedTopic = () => topicById(state.selectedId)

function requireTopic(id, dialog) {
  const topic = topicById(id)
  if (topic) return topic
  dialog?.close()
  showToast('Тред больше недоступен')
  return null
}

async function apiJson(path, options = {}) {
  if (demoMode) throw new Error('Недоступно в демо')
  const headers = new Headers(options.headers || {})
  headers.set('authorization', `tma ${tg?.initData || ''}`)
  if (options.body != null && !(options.body instanceof Blob)) headers.set('content-type', 'application/json')
  const response = await fetch(path, { ...options, headers })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
  return payload
}

async function apiBlob(path) {
  const response = await fetch(path, { headers: { authorization: `tma ${tg?.initData || ''}` } })
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || `HTTP ${response.status}`)
  return response.blob()
}

function showToast(text) {
  const toast = $('#toast')
  toast.textContent = text
  toast.classList.add('show')
  clearTimeout(showToast.timer)
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2300)
}

function setBusy(key, busy) {
  if (busy) state.submitting.add(key)
  else state.submitting.delete(key)
}

function isBusy(key) { return state.submitting.has(key) }

function navigate(view, options = {}) {
  if (view === 'files' && options.topicId) state.files.returnView = state.view
  else if (view === 'files' && state.view !== 'files') state.files.returnView = null
  state.view = view
  $$('.view').forEach((element) => element.classList.toggle('active', element.dataset.view === view))
  $$('.bottom-nav button').forEach((button) => button.classList.toggle('active', button.dataset.nav === view))
  $('.bottom-nav').classList.toggle('hidden', view === 'detail')
  if (view === 'files') {
    if (options.topicId) chooseTopic(options.topicId)
    else if (!state.files.topicId) chooseTopic(state.selectedId || state.data?.topics[0]?.id)
    else renderFilesHeader()
  }
  if (view === 'threads') renderThreads()
  if (view === 'settings') renderSettings()
  if (view === 'detail') renderDetail()
  syncBackButton()
  tg?.HapticFeedback?.selectionChanged()
}

function syncBackButton() {
  if (!tg?.BackButton) return
  const modalOpen = Boolean(document.querySelector('dialog[open]'))
  const canGoBack = state.view === 'detail' || state.view === 'files' && Boolean(state.files.path || state.files.returnView)
  if (modalOpen || canGoBack) tg.BackButton.show()
  else tg.BackButton.hide()
}

function goBack() { navigate('threads') }

function handleNativeBack() {
  const modal = document.querySelector('dialog[open]')
  if (modal) {
    if (modal.id === 'preview-dialog') closePreview()
    else { modal.close(); renderAll(); syncBackButton() }
    return
  }
  if (state.view === 'files' && state.files.path) {
    state.files.path = state.files.path.split('/').slice(0, -1).join('/')
    loadFiles()
    syncBackButton()
    return
  }
  if (state.view === 'files' && state.files.returnView === 'detail') {
    state.files.returnView = null
    navigate('detail')
    return
  }
  goBack()
}

function chooseTopic(id) {
  const exists = state.data?.topics.some((topic) => topic.id === id)
  state.files.topicId = exists ? id : state.data?.topics[0]?.id || null
  if (state.files.topicId) {
    state.selectedId = state.files.topicId
    persistSelection()
  }
  state.files.path = ''
  state.files.entries = []
  state.files.nextOffset = null
  state.files.pagesLoaded = 0
  state.files.uploadNotice = null
  renderFilesHeader()
  loadFiles()
  syncBackButton()
}

function persistSelection() {
  if (state.selectedId) localStorage.setItem('vesperloop:selected-topic', state.selectedId)
  else localStorage.removeItem('vesperloop:selected-topic')
}

function renderAll() {
  if (document.querySelector('dialog[open]')) {
    updateFreshness()
    return
  }
  if (state.view === 'threads') renderThreads()
  else if (state.view === 'settings') renderSettings()
  else if (state.view === 'files') renderFilesHeader()
  else if (state.view === 'detail') renderDetail()
}

function renderThreads() {
  if (!state.data) {
    $('#create-topic').disabled = true
    updateHtml($('#threads-list'), `<div class="quiet-note">${state.overviewError ? 'Треды недоступны' : 'Загружаем треды…'}</div>`)
    return
  }
  $('#create-topic').disabled = false
  const query = $('#thread-search').value.trim().toLocaleLowerCase('ru')
  const all = [...state.data.topics].sort((a, b) => new Date(b.lastActivityAt || 0) - new Date(a.lastActivityAt || 0))
  const filtered = all.filter((topic) => topic.name.toLocaleLowerCase('ru').includes(query))
  const pinned = filtered.filter((topic) => topic.pinned)
  const recent = filtered.filter((topic) => !topic.pinned)
  $('#pinned-section').classList.toggle('hidden', pinned.length === 0)
  const pinnedList = $('#pinned-list')
  const threadsList = $('#threads-list')
  updateHtml(pinnedList, pinned.map(threadMarkup).join(''))
  updateHtml(threadsList, recent.map(threadMarkup).join(''))
  $('#thread-count').textContent = query ? `${filtered.length} из ${all.length}` : String(all.length)
  $('#delete-all-count').textContent = all.length ? `${all.length} ›` : '0'
  $('#delete-all-topics').disabled = all.length === 0
}

function threadMarkup(topic) {
  const subtitle = topic.busy ? `${escapeHtml(topic.run?.action || 'Claude работает')} · ${formatElapsed(topic.run?.startedAt)}` : topic.lastActivityAt ? `Последняя активность · ${relativeTime(topic.lastActivityAt)}` : 'Нет активной сессии'
  return `<button class="thread-row" data-topic="${escapeHtml(topic.id)}"><span class="thread-status"><span class="status-dot ${topic.busy ? 'active' : ''}"></span></span><span class="row-copy"><strong>${escapeHtml(topic.name)}</strong><small class="${topic.busy ? 'active-copy' : ''}">${subtitle}</small></span>${topic.pinned ? `<span class="pin">${icon('pin')}</span>` : `<span class="chevron">${icon('chevron-right')}</span>`}</button>`
}

function openTopic(id) {
  if (!state.data?.topics.some((topic) => topic.id === id)) return
  state.selectedId = id
  persistSelection()
  navigate('detail')
}

function renderDetail() {
  const topic = selectedTopic()
  if (!topic) return navigate('threads')
  $('#detail-title').textContent = topic.name
  $('#detail-model').textContent = topic.model
  $('#detail-cwd').textContent = topic.cwd
  $('#verbose-toggle').checked = topic.verbose
  $('#verbose-toggle').disabled = isBusy('verbose')
  $('#model-row').disabled = isBusy('model')
  $('#new-session').disabled = topic.busy || isBusy('new-session')
  $('#new-session').classList.toggle('hidden', !topic.sessionId)
  $('#advanced-row').disabled = topic.busy || isBusy('cwd')
  const newSessionReady = state.newSessionPending === topic.id && !topic.busy && !topic.sessionId
  $('#new-session-ready').classList.toggle('hidden', !newSessionReady)
  $('#open-topic-chat').disabled = !state.data?.botUrl
  $('#pin-topic').textContent = topic.pinned ? 'Открепить' : 'Закрепить'
  $('#rename-topic').classList.toggle('hidden', topic.threadId === 0)
  $('#delete-topic').classList.toggle('hidden', topic.threadId === 0)
  const runCard = $('#run-card')
  runCard.classList.toggle('hidden', !topic.busy && !topic.run)
  updateHtml(runCard, topic.busy || topic.run ? `<div class="run-head" data-key="head"><span class="status-dot active"></span><div><strong>${topic.run?.stopping ? 'Останавливаем…' : 'Claude работает'}</strong><small>${escapeHtml(topic.run?.action || 'Выполняет текущую задачу')}</small></div></div><div class="run-meta" data-key="meta"><span data-key="elapsed" data-run-elapsed>${formatElapsed(topic.run?.startedAt)}</span><span data-key="queue">В очереди: ${Number(topic.queued) || 0}</span><button id="stop-run" class="stop-button" data-key="stop" ${topic.run?.stopping || isBusy('stop') ? 'disabled' : ''}>${topic.run?.stopping ? 'Остановка…' : 'Остановить'}</button></div>` : '')
  const sessionsList = $('#sessions-list')
  const sessionsMarkup = topic.sessions.map((session, index) => `<button class="session-row" data-session="${escapeHtml(session.id)}" ${topic.busy || isBusy('session') ? 'disabled' : ''}><span class="session-icon">${icon('terminal')}<span class="status-dot ${session.id === topic.sessionId ? 'current' : ''}"></span></span><span class="row-copy"><strong>${escapeHtml(session.title || `Сессия ${index + 1}`)}</strong><small>${escapeHtml(formatDate(session.startedAt))}</small></span>${session.id === topic.sessionId ? '<span class="current-badge">Текущая</span>' : `<span class="chevron">${icon('chevron-right')}</span>`}</button>`).join('')
  updateHtml(sessionsList, sessionsMarkup)
}

function renderSettings() {
  if (!state.data) return
  const ok = state.data.authenticated
  $('#auth-chip').textContent = ok === null ? 'Неизвестно' : ok ? 'Подключён' : 'Нужен вход'
  $('#auth-chip').className = `chip ${ok === true ? 'success' : ok === false ? 'warning' : ''}`
  $('#auth-dot').className = `status-dot ${ok === true ? 'active' : ''}`
  $('#auth-state').textContent = ok === null ? 'Статус недоступен' : ok ? 'Claude подключён' : 'Требуется вход в Claude'
  $('#auth-checked').textContent = state.data.statusUpdatedAt ? `Проверено ${relativeTime(state.data.statusUpdatedAt)}` : 'Статус ещё не получен'
  updateHtml($('#limits'), state.data.limits.map((limit) => `<div class="limit"><div class="limit-head"><span>${escapeHtml(limit.title)}</span><span>${Math.round(limit.percent)}%${limit.resetsAt ? ` · сброс ${escapeHtml(formatReset(limit.resetsAt))}` : ''}</span></div><div class="progress"><span style="width:${clamp(limit.percent)}%"></span></div></div>`).join('') || '<p class="quiet-note">Лимиты недоступны</p>')
  $('#last-update').textContent = state.lastSuccessAt ? relativeTime(state.lastSuccessAt) : '—'
  $('#refresh-auth').disabled = state.overviewLoading
}

function renderFilesHeader() {
  const topics = state.data?.topics || []
  const topic = topics.find((item) => item.id === state.files.topicId)
  $('#files-subtitle').textContent = topic?.name || 'Нет выбранного треда'
  $('#files-topic-name').textContent = topic?.name || 'Нет доступных тредов'
  $('#files-topic-picker').disabled = !topics.length
  $('#upload-button').disabled = !topic || state.files.loading || isBusy('upload')
  $$('[data-root]').forEach((button) => button.classList.toggle('active', button.dataset.root === state.files.root))
  renderBreadcrumbs()
}

function openFilesTopicDialog() {
  if (!state.data?.topics.length) return
  $('#files-topic-search').value = ''
  renderFilesTopicOptions()
  $('#files-topic-dialog').showModal()
  $('#files-topic-picker').setAttribute('aria-expanded', 'true')
  syncBackButton()
  setTimeout(() => {
    $('#files-topic-search').focus()
    $('[data-files-topic-option][aria-checked="true"]')?.scrollIntoView({ block: 'nearest' })
  }, 80)
}

function renderFilesTopicOptions() {
  const topics = [...(state.data?.topics || [])].sort((a, b) => new Date(b.lastActivityAt || 0) - new Date(a.lastActivityAt || 0))
  const query = $('#files-topic-search').value.trim().toLocaleLowerCase('ru')
  const filtered = topics.filter((topic) => topic.name.toLocaleLowerCase('ru').includes(query))
  $('#files-topic-count').textContent = query ? `Найдено ${filtered.length} из ${topics.length}` : `Всего тредов: ${topics.length}`
  const groups = [
    ['Закреплённые', filtered.filter((topic) => topic.pinned)],
    ['Недавние', filtered.filter((topic) => !topic.pinned)],
  ].filter(([, items]) => items.length)
  updateHtml($('#files-topic-options'), groups.length
    ? groups.map(([title, items]) => `<section class="topic-picker-group"><h3>${title}</h3>${items.map(filesTopicMarkup).join('')}</section>`).join('')
    : '<div class="topic-option-empty">Треды не найдены</div>')
}

function filesTopicMarkup(topic) {
  const subtitle = topic.threadId === 0 ? 'Основной чат' : topic.busy ? 'Claude работает' : topic.lastActivityAt ? `Активность ${relativeTime(topic.lastActivityAt)}` : 'Нет активной сессии'
  const selected = topic.id === state.files.topicId
  return `<button class="topic-option" type="button" role="radio" data-files-topic-option="${escapeHtml(topic.id)}" aria-checked="${selected}"><span class="topic-choice-mark">✓</span><span class="row-copy"><strong>${escapeHtml(topic.name)}</strong><small>${escapeHtml(subtitle)}</small></span></button>`
}

function renderBreadcrumbs() {
  const parts = state.files.path ? state.files.path.split('/') : []
  const labels = [state.files.root === 'workspace' ? 'Папка треда' : 'Рабочая папка', ...parts]
  updateHtml($('#breadcrumbs'), labels.map((label, index) => `<button data-crumb="${index}">${escapeHtml(label)}</button>`).join(''))
}

function renderFiles() {
  renderFilesHeader()
  const message = $('#files-message')
  if (state.files.error) {
    message.className = 'notice error'
    message.innerHTML = `${escapeHtml(state.files.error)} <button id="retry-files">Повторить</button>`
    $('#retry-files').addEventListener('click', () => loadFiles())
  } else if (state.files.uploadNotice) {
    message.className = 'notice'
    message.textContent = `Файл загружен в inbox: ${state.files.uploadNotice}`
  } else message.classList.add('hidden')
  const list = $('#files-list')
  list.classList.toggle('loading', state.files.loading && !state.files.entries.length)
  list.setAttribute('aria-busy', String(state.files.loading))
  updateHtml(list, state.files.loadingVisible && !state.files.entries.length
    ? Array.from({ length: 3 }, () => '<div class="file-skeleton" aria-hidden="true"><span></span><div><i></i><i></i></div></div>').join('')
    : state.files.entries.map((entry) => `<button class="file-row" data-file="${escapeHtml(entry.id)}"><span class="file-icon ${entry.kind === 'directory' ? 'directory-icon' : ''}">${entry.kind === 'directory' ? icon('folder') : fileIcon(entry)}</span><span class="row-copy"><strong>${escapeHtml(entry.name)}</strong><small>${entry.kind === 'directory' ? 'Папка' : `${formatBytes(entry.size)} · ${formatDate(entry.mtime)}`}</small></span><span class="chevron">${icon('chevron-right')}</span></button>`).join(''))
  $('#load-more-files').classList.toggle('hidden', state.files.nextOffset === null)
  $('#load-more-files').disabled = state.files.loading
  $('#refresh-files').classList.toggle('hidden', state.files.pagesLoaded <= 1)
  $('#refresh-files').disabled = state.files.loading
}

async function loadOverview(options = {}) {
  if (options.force) {
    const refresh = state.overviewForceChain.then(async () => {
      if (state.overviewPromise) {
        state.overviewRequest++
        state.overviewAbort?.abort()
        await state.overviewPromise
      }
      return startOverviewLoad(options)
    })
    state.overviewForceChain = refresh.catch(() => {})
    return refresh
  }
  if (state.overviewPromise) return state.overviewPromise
  return startOverviewLoad(options)
}

async function startOverviewLoad(options) {
  if (state.overviewPromise) {
    return state.overviewPromise
  }
  const promise = performOverviewLoad(options)
  state.overviewPromise = promise
  try { return await promise }
  finally {
    if (state.overviewPromise === promise) state.overviewPromise = null
  }
}

async function performOverviewLoad({ refreshStatus = false, silent = false } = {}) {
  const request = ++state.overviewRequest
  const controller = new AbortController()
  state.overviewAbort = controller
  state.overviewLoading = true
  try {
    const data = demoMode ? structuredClone(demoData) : await apiJson(`/api/overview${refreshStatus ? '?refresh=status' : ''}`, { signal: controller.signal })
    if (request !== state.overviewRequest) return
    state.data = data
    state.overviewError = null
    if (!data.topics.some((topic) => topic.id === state.selectedId)) state.selectedId = data.topics[0]?.id || null
    let filesTopicChanged = false
    if (state.files.topicId && !data.topics.some((topic) => topic.id === state.files.topicId)) {
      state.files.topicId = state.selectedId
      state.files.path = ''
      state.files.entries = []
      state.files.nextOffset = null
      state.files.pagesLoaded = 0
      state.files.uploadNotice = null
      filesTopicChanged = true
    }
    persistSelection()
    state.lastSuccessAt = Date.now()
    state.stale = false
    $('#overview-message').classList.add('hidden')
    renderAll()
    if (filesTopicChanged && state.view === 'files') loadFiles()
    if (refreshStatus) showToast('Статус обновлён')
  } catch (error) {
    if (request !== state.overviewRequest) return
    state.overviewError = error.message || 'Не удалось загрузить данные'
    state.stale = Boolean(state.data)
    const box = $('#overview-message')
    box.className = 'notice error'
    box.innerHTML = `${state.stale ? 'Показаны последние сохранённые данные. ' : ''}${escapeHtml(error.message || 'Не удалось загрузить данные')} <button id="retry-overview">Повторить</button>`
    $('#retry-overview').addEventListener('click', () => loadOverview())
    if (!silent) showToast('Нет связи с сервером')
    renderAll()
  } finally {
    if (request === state.overviewRequest) {
      state.overviewLoading = false
      state.overviewAbort = null
    }
    updateFreshness()
  }
}

async function loadFiles({ append = false, silent = false } = {}) {
  if (!state.files.topicId || state.view !== 'files') return
  if (silent && state.files.loading) return
  const request = ++state.files.request
  const topicId = state.files.topicId
  const root = state.files.root
  const path = state.files.path
  const offset = append ? state.files.nextOffset : 0
  if (append && offset === null) return
  state.files.loading = true
  state.files.loadingVisible = false
  state.files.error = null
  if (!append && !silent) state.files.entries = []
  if (!silent) renderFiles()
  let loadingShownAt = 0
  const loadingTimer = !append && !silent ? setTimeout(() => {
    if (request !== state.files.request || !state.files.loading) return
    loadingShownAt = performance.now()
    state.files.loadingVisible = true
    renderFiles()
  }, 180) : null
  try {
    let result
    if (demoMode) {
      await Promise.resolve()
      const entries = demoFiles[`${root}:${path}`] || []
      result = { root, path, parent: path.includes('/') ? path.split('/').slice(0, -1).join('/') : path ? '' : null, entries, nextOffset: null }
    } else {
      const params = new URLSearchParams({ root, path, offset: String(offset || 0) })
      result = await apiJson(`/api/topics/${encodeURIComponent(topicId)}/files?${params}`)
    }
    if (request !== state.files.request || topicId !== state.files.topicId || root !== state.files.root || path !== state.files.path) return
    state.files.entries = append ? [...state.files.entries, ...result.entries] : result.entries
    state.files.nextOffset = result.nextOffset
    state.files.pagesLoaded = append ? state.files.pagesLoaded + 1 : 1
  } catch (error) {
    if (request !== state.files.request) return
    state.files.error = error.message || 'Не удалось загрузить файлы'
  } finally {
    if (loadingTimer) clearTimeout(loadingTimer)
    if (loadingShownAt) {
      const remaining = 240 - (performance.now() - loadingShownAt)
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
    }
    if (request === state.files.request) {
      state.files.loading = false
      state.files.loadingVisible = false
      renderFiles()
    }
  }
}

function openFile(id) {
  const entry = state.files.entries.find((item) => item.id === id)
  if (!entry) return
  if (entry.kind === 'directory') {
    state.files.path = entry.path
    loadFiles()
    syncBackButton()
    return
  }
  if (entry.preview) previewFile(entry)
  else downloadFile(entry)
}

async function previewFile(file) {
  const request = ++state.preview.request
  const topicId = state.files.topicId
  if (!topicId) return
  revokePreviewUrl()
  state.preview.file = file
  state.preview.topicId = topicId
  $('#preview-name').textContent = file.name
  $('#preview-meta').textContent = `${formatBytes(file.size)} · ${formatDate(file.mtime)}`
  $('#preview-body').innerHTML = '<div class="preview-fallback">Загружаем предпросмотр…</div>'
  $('#preview-dialog').showModal()
  syncBackButton()
  try {
    if (demoMode) {
      const markdown = '# Сравнение предложений\n\nОсновные условия из присланных документов.\n\n| Условие | Альфа | Бета |\n| --- | --- | --- |\n| Стоимость | 45 000 ₽ | 52 000 ₽ |\n| Срок | 10 дней | 7 дней |\n| Поддержка | 30 дней | 90 дней |\n\n## На что обратить внимание\n\n- У «Беты» короче срок.\n- У «Альфы» ниже стоимость.'
      if (request !== state.preview.request) return
      if (file.preview === 'text') $('#preview-body').innerHTML = `<pre>${escapeHtml('{\n  "name": "claude-tg-bot",\n  "private": true\n}')}</pre>`
      else if (file.preview === 'markdown') $('#preview-body').innerHTML = renderMarkdown(markdown)
      else $('#preview-body').innerHTML = '<div class="preview-fallback">Медиа-предпросмотр использует защищённую загрузку и доступен в подключённом Mini App.</div>'
      return
    }
    const blob = await apiBlob(`/api/topics/${encodeURIComponent(topicId)}/files/${encodeURIComponent(file.id)}/preview`)
    if (request !== state.preview.request) return
    if (file.preview === 'text' || file.preview === 'markdown') {
      const text = await blob.text()
      if (request !== state.preview.request) return
      $('#preview-body').innerHTML = file.preview === 'markdown' ? renderMarkdown(text) : `<pre>${escapeHtml(text)}</pre>`
    } else {
      if (file.preview === 'image') {
        state.preview.url = URL.createObjectURL(blob)
        $('#preview-body').innerHTML = `<img id="preview-image" src="${escapeHtml(state.preview.url)}" alt="${escapeHtml(file.name)}" />`
        $('#preview-image').addEventListener('error', () => {
          $('#preview-body').innerHTML = '<div class="preview-fallback">Изображение не отображается.<br>Скачай файл кнопкой ниже.</div>'
        }, { once: true })
      } else {
        state.preview.pdfViewer = mountPdfPreview($('#preview-body'), blob)
      }
    }
  } catch (error) {
    if (request !== state.preview.request) return
    $('#preview-body').innerHTML = `<div class="preview-fallback">Предпросмотр недоступен.<br>${escapeHtml(error.message)}<br><br>Файл можно скачать.</div>`
  }
}

function closePreview() {
  state.preview.request++
  revokePreviewUrl()
  state.preview.file = null
  state.preview.topicId = null
  $('#preview-dialog').close()
  syncBackButton()
}

function revokePreviewUrl() {
  state.preview.pdfViewer?.destroy()
  state.preview.pdfViewer = null
  if (state.preview.url) URL.revokeObjectURL(state.preview.url)
  state.preview.url = null
}

async function downloadFile(file = state.preview.file, topicId = file === state.preview.file ? state.preview.topicId : state.files.topicId) {
  if (!file || !topicId) return
  try {
    if (demoMode) return showToast('Скачивание отключено в демо')
    const { url } = await apiJson(`/api/topics/${encodeURIComponent(topicId)}/files/${encodeURIComponent(file.id)}`, { method: 'POST', body: '{}' })
    const href = new URL(url, location.href).href
    if (tg?.downloadFile) {
      tg.downloadFile({ url: href, file_name: file.name }, (accepted) => showToast(accepted ? 'Скачивание начато' : 'Не удалось скачать файл'))
      return
    }
    const link = document.createElement('a')
    link.href = href
    link.download = file.name
    document.body.append(link)
    link.click()
    link.remove()
    showToast('Скачивание начато')
  } catch (error) { showToast(error.message) }
}

async function uploadFile(file) {
  if (!file || !state.files.topicId || isBusy('upload')) return
  if (file.size > 20 * 1024 * 1024) return showToast('Максимальный размер — 20 МБ')
  const topicId = state.files.topicId
  const topicName = topicById(topicId)?.name
  setBusy('upload', true)
  state.files.uploadNotice = null
  renderFilesHeader()
  try {
    if (demoMode) return showToast('Загрузка отключена в демо')
    const params = new URLSearchParams({ name: file.name })
    const result = await apiJson(`/api/topics/${encodeURIComponent(topicId)}/files?${params}`, { method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream' } })
    const uploadedName = result.name || file.name
    if (state.files.topicId === topicId) state.files.uploadNotice = uploadedName
    showToast(`Загружено в inbox${state.files.topicId !== topicId && topicName ? ` треда «${topicName}»` : ''}: ${uploadedName}`)
    if (state.files.topicId === topicId && state.files.root === 'workspace' && (state.files.path === '' || state.files.path === 'inbox')) await loadFiles()
  } catch (error) { showToast(error.message) }
  finally { setBusy('upload', false); $('#upload-input').value = ''; renderFilesHeader() }
}

async function mutate(key, action, successText) {
  if (isBusy(key)) return null
  if (demoMode) {
    showToast('Действия отключены в демо')
    return null
  }
  setBusy(key, true)
  try {
    const result = await action()
    if (successText) showToast(successText)
    await loadOverview({ silent: true, force: true })
    return result ?? true
  } catch (error) {
    showToast(error.message)
    return null
  } finally {
    setBusy(key, false)
    renderAll()
  }
}

async function createOrRenameTopic(event) {
  event.preventDefault()
  const name = $('#topic-name').value.trim()
  if (!name) return
  const mode = $('#topic-dialog').dataset.mode
  const targetId = $('#topic-dialog').dataset.topicId
  if (mode === 'rename' && !requireTopic(targetId, $('#topic-dialog'))) return
  const result = await mutate('topic-form', async () => {
    if (demoMode) return true
    if (mode === 'rename') return apiJson(`/api/topics/${encodeURIComponent(targetId)}`, { method: 'PATCH', body: JSON.stringify({ name }) })
    return apiJson('/api/topics', { method: 'POST', body: JSON.stringify({ name }) })
  }, mode === 'rename' ? 'Тред переименован' : 'Тред создан')
  if (result) $('#topic-dialog').close()
}

async function patchTopic(key, payload, successText, targetId = state.selectedId) {
  if (!requireTopic(targetId)) return null
  return mutate(key, () => demoMode ? Promise.resolve(true) : apiJson(`/api/topics/${encodeURIComponent(targetId)}`, { method: 'PATCH', body: JSON.stringify(payload) }), successText)
}

async function stopRun() {
  const targetId = state.selectedId
  await mutate('stop', () => demoMode ? Promise.resolve(true) : apiJson(`/api/topics/${encodeURIComponent(targetId)}/stop`, { method: 'POST', body: '{}' }), 'Запрос на остановку отправлен')
}

async function selectSession(sessionId) {
  const topic = selectedTopic()
  if (!topic || topic.busy || sessionId === topic.sessionId) return
  await patchTopic('session', { sessionId }, 'Сессия выбрана')
}

async function deleteTopic() {
  const targetId = $('#delete-dialog').dataset.topicId
  if (!requireTopic(targetId, $('#delete-dialog'))) return
  const result = await mutate('delete-topic', () => demoMode ? Promise.resolve(true) : apiJson(`/api/topics/${encodeURIComponent(targetId)}`, { method: 'DELETE' }), 'Тред удалён')
  if (result) { $('#delete-dialog').close(); navigate('threads') }
}

async function deleteAllTopics() {
  const result = await mutate('delete-all', () => demoMode ? Promise.resolve({ removed: 0 }) : apiJson('/api/topics', { method: 'DELETE' }), null)
  if (result) { $('#delete-all-dialog').close(); navigate('threads'); showToast(result.failed ? `Удалено: ${result.removed}, ошибок: ${result.failed}` : `Удалено тредов: ${result.removed}`) }
}

function openTopicDialog(mode, targetId = state.selectedId) {
  const rename = mode === 'rename'
  const topic = rename ? requireTopic(targetId) : null
  if (rename && !topic) return
  $('#topic-dialog').dataset.mode = mode
  $('#topic-dialog').dataset.topicId = targetId || ''
  $('#topic-dialog-title').textContent = rename ? 'Переименовать тред' : 'Новый тред'
  $('#topic-submit').textContent = rename ? 'Сохранить' : 'Создать'
  $('#topic-name').value = rename ? topic.name : ''
  $('#topic-dialog').showModal()
  syncBackButton()
  setTimeout(() => $('#topic-name').focus(), 80)
}

function renderCommands() {
  $('#commands-list').innerHTML = commandGroups.map(([title, commands]) => `<div class="command-group"><h3>${escapeHtml(title)}</h3><div class="card">${commands.map(([command, description]) => `<button class="command-row" data-command="${escapeHtml(command)}"><span class="row-copy"><code>${escapeHtml(command)}</code><small>${escapeHtml(description)}</small></span><span class="chevron">⧉</span></button>`).join('')}</div></div>`).join('')
  $$('[data-command]').forEach((button) => button.addEventListener('click', () => copyText(button.dataset.command)))
}

async function copyText(value) {
  try { await navigator.clipboard.writeText(value) }
  catch {
    const area = document.createElement('textarea')
    area.value = value
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
  showToast(`Скопировано: ${value}`)
}

function renderMarkdown(source) {
  const lines = String(source).replace(/\r/g, '').split('\n')
  const output = []
  let list = null
  const closeList = () => { if (list) { output.push(`</${list}>`); list = null } }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (/^\|.*\|$/.test(line) && /^\|?\s*:?-+/.test(lines[index + 1] || '')) {
      closeList()
      const headers = tableCells(line)
      const rows = []
      index += 2
      while (index < lines.length && /^\|.*\|$/.test(lines[index])) { rows.push(tableCells(lines[index])); index++ }
      index--
      output.push(`<table><thead><tr>${headers.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
      continue
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/)
    if (heading) { closeList(); const level = heading[1].length; output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`); continue }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/)
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/)
    if (bullet || numbered) {
      const type = bullet ? 'ul' : 'ol'
      if (list !== type) { closeList(); list = type; output.push(`<${type}>`) }
      output.push(`<li>${inlineMarkdown((bullet || numbered)[1])}</li>`)
      continue
    }
    closeList()
    if (line.trim()) output.push(`<p>${inlineMarkdown(line)}</p>`)
  }
  closeList()
  return output.join('')
}

function inlineMarkdown(value) {
  return escapeHtml(value).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>')
}

function tableCells(line) { return line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()) }
function clamp(value) { return Math.max(0, Math.min(100, Number(value) || 0)) }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]) }
function formatBytes(value) { const size = Number(value) || 0; if (size < 1024) return `${size} Б`; if (size < 1048576) return `${(size / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} КБ`; return `${(size / 1048576).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ` }
function relativeTime(value) { const time = new Date(value).getTime(); if (!Number.isFinite(time)) return 'неизвестно'; const seconds = Math.max(0, Math.round((Date.now() - time) / 1000)); if (seconds < 5) return 'только что'; if (seconds < 60) return `${seconds} сек. назад`; if (seconds < 3600) return `${Math.floor(seconds / 60)} мин. назад`; if (seconds < 86400) return `${Math.floor(seconds / 3600)} ч. назад`; return `${Math.floor(seconds / 86400)} дн. назад` }
function formatElapsed(value) { const started = Number(value); if (!started) return 'только что'; const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000)); const minutes = Math.floor(seconds / 60); return minutes ? `${minutes} мин ${seconds % 60} с` : `${seconds} с` }
function formatDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }
function formatReset(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }
function fileIcon(file) { return file.preview === 'image' ? icon('file-image') : file.preview === 'text' || file.preview === 'markdown' ? icon('file-text') : icon('file') }
function updateFreshness() { const text = state.lastSuccessAt ? relativeTime(state.lastSuccessAt) : null; $('#sync-state').textContent = state.stale ? `Данные устарели · ${text}` : text ? `Обновлено ${text}` : state.overviewError ? 'Не удалось обновить' : 'Загрузка…' }
function updateClock() {
  updateFreshness()
  if (!state.data || document.querySelector('dialog[open]')) return
  if (state.view === 'threads') renderThreads()
  else if (state.view === 'settings') renderSettings()
  else if (state.view === 'detail') {
    const elapsed = $('[data-run-elapsed]')
    if (elapsed) elapsed.textContent = formatElapsed(selectedTopic()?.run?.startedAt)
  }
}

function delegate(container, selector, handler) {
  container.addEventListener('click', (event) => {
    const target = event.target.closest(selector)
    if (target && container.contains(target)) handler(target)
  })
}

$$('[data-nav]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.nav)))
$$('[data-close]').forEach((button) => button.addEventListener('click', () => { $(`#${button.dataset.close}`).close(); renderAll(); syncBackButton() }))
$$('dialog').forEach((dialog) => dialog.addEventListener('close', () => { renderAll(); syncBackButton() }))
$$('[data-back]').forEach((button) => button.addEventListener('click', goBack))
tg?.BackButton?.onClick(handleNativeBack)
$('#thread-search').addEventListener('input', renderThreads)
delegate($('#pinned-list'), '[data-topic]', (button) => openTopic(button.dataset.topic))
delegate($('#threads-list'), '[data-topic]', (button) => openTopic(button.dataset.topic))
delegate($('#sessions-list'), '[data-session]', (button) => selectSession(button.dataset.session))
delegate($('#run-card'), '#stop-run', () => stopRun())
$('#create-topic').addEventListener('click', () => openTopicDialog('create'))
$('#topic-form').addEventListener('submit', createOrRenameTopic)
$('#topic-menu').addEventListener('click', () => { $('#topic-actions').dataset.topicId = state.selectedId || ''; $('#topic-actions').showModal(); syncBackButton() })
$('#rename-topic').addEventListener('click', () => { const targetId = $('#topic-actions').dataset.topicId; $('#topic-actions').close(); openTopicDialog('rename', targetId) })
$('#pin-topic').addEventListener('click', async () => { const targetId = $('#topic-actions').dataset.topicId; const topic = requireTopic(targetId, $('#topic-actions')); if (!topic) return; $('#topic-actions').close(); await patchTopic('pin', { pinned: !topic.pinned }, topic.pinned ? 'Тред откреплён' : 'Тред закреплён', targetId) })
$('#delete-topic').addEventListener('click', () => { const targetId = $('#topic-actions').dataset.topicId; if (!requireTopic(targetId, $('#topic-actions'))) return; $('#topic-actions').close(); $('#delete-dialog').dataset.topicId = targetId; $('#delete-dialog').showModal(); syncBackButton() })
$('#confirm-delete').addEventListener('click', deleteTopic)
$('#delete-all-topics').addEventListener('click', () => { const count = state.data?.topics.length || 0; $('#delete-all-copy').textContent = `Будет удалено тредов: ${count}. Все задачи остановятся, а рабочие файлы переедут в архив.`; $('#delete-all-dialog').showModal(); syncBackButton() })
$('#confirm-delete-all').addEventListener('click', deleteAllTopics)
$('#model-row').addEventListener('click', () => {
  const topic = selectedTopic()
  if (!topic) return
  $('#model-dialog').dataset.topicId = topic.id
  $('#model-options').innerHTML = (state.data.models || []).map((model) => `<button class="model-option" data-model="${escapeHtml(model.id)}"><strong>${escapeHtml(model.label)}</strong><span>${topic.modelId === model.id ? '✓' : ''}</span></button>`).join('')
  $$('[data-model]').forEach((button) => button.addEventListener('click', async () => { const id = button.dataset.model; const targetId = $('#model-dialog').dataset.topicId; if (!requireTopic(targetId, $('#model-dialog'))) return; const result = await patchTopic('model', { model: id }, 'Модель изменена', targetId); if (result) $('#model-dialog').close() }))
  $('#model-dialog').showModal()
  syncBackButton()
})
$('#verbose-toggle').addEventListener('change', async (event) => { const value = event.target.checked; const result = await patchTopic('verbose', { verbose: value }, null); if (!result) event.target.checked = !value })
$('#new-session').addEventListener('click', async () => { const topic = selectedTopic(); if (!topic || topic.busy) return; const targetId = topic.id; const result = await mutate('new-session', () => demoMode ? Promise.resolve(true) : apiJson(`/api/topics/${encodeURIComponent(targetId)}/new-session`, { method: 'POST', body: '{}' })); if (result) { state.newSessionPending = targetId; renderAll() } })
$('#open-topic-chat').addEventListener('click', () => {
  const topic = selectedTopic()
  const botUrl = state.data?.botUrl
  if (!topic || !botUrl) return
  const url = topic.threadId ? `${botUrl}/${topic.threadId}` : botUrl
  if (tg?.openTelegramLink) tg.openTelegramLink(url)
  else window.open(url, '_blank', 'noopener')
})
$('#advanced-row').addEventListener('click', () => { const topic = selectedTopic(); if (!topic || topic.busy) return; $('#cwd-dialog').dataset.topicId = topic.id; $('#cwd-input').value = topic.cwd; $('#cwd-dialog').showModal(); syncBackButton(); setTimeout(() => $('#cwd-input').focus(), 80) })
$('#cwd-form').addEventListener('submit', async (event) => { event.preventDefault(); const cwd = $('#cwd-input').value.trim(); const targetId = $('#cwd-dialog').dataset.topicId; if (!cwd || !requireTopic(targetId, $('#cwd-dialog'))) return; const result = await patchTopic('cwd', { cwd }, 'Директория изменена', targetId); if (result) $('#cwd-dialog').close() })
$('#thread-files').addEventListener('click', () => navigate('files', { topicId: state.selectedId }))
$('#files-topic-picker').addEventListener('click', openFilesTopicDialog)
$('#files-topic-search').addEventListener('input', renderFilesTopicOptions)
delegate($('#files-topic-options'), '[data-files-topic-option]', (button) => {
  const id = button.dataset.filesTopicOption
  $('#files-topic-dialog').close()
  if (id !== state.files.topicId) chooseTopic(id)
})
delegate($('#breadcrumbs'), '[data-crumb]', (button) => {
  const parts = state.files.path ? state.files.path.split('/') : []
  state.files.path = parts.slice(0, Number(button.dataset.crumb)).join('/')
  loadFiles()
  syncBackButton()
})
delegate($('#files-list'), '[data-file]', (button) => openFile(button.dataset.file))
$$('[data-root]').forEach((button) => button.addEventListener('click', () => { if (state.files.root === button.dataset.root) return; state.files.root = button.dataset.root; state.files.path = ''; loadFiles() }))
$('#load-more-files').addEventListener('click', () => loadFiles({ append: true }))
$('#refresh-files').addEventListener('click', () => loadFiles())
$('#upload-button').addEventListener('click', () => $('#upload-input').click())
$('#upload-input').addEventListener('change', (event) => uploadFile(event.target.files?.[0]))
$('#close-preview').addEventListener('click', closePreview)
$('#download-preview').addEventListener('click', () => downloadFile())
$('#refresh-auth').addEventListener('click', () => {
  if (Date.now() - state.lastStatusForceAt < STATUS_FORCE_MIN_INTERVAL_MS) {
    showToast('Лимиты можно обновлять раз в минуту')
    return
  }
  state.lastStatusForceAt = Date.now()
  void loadOverview({ refreshStatus: true, force: true })
})
$('#commands-toggle').addEventListener('click', () => $('#commands-list').classList.toggle('hidden'))
document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadOverview({ silent: true }); if (state.view === 'files' && state.files.pagesLoaded <= 1) loadFiles() } })
window.addEventListener('beforeunload', revokePreviewUrl)
$('#files-topic-dialog').addEventListener('close', () => $('#files-topic-picker').setAttribute('aria-expanded', 'false'))

renderCommands()
if (demoMode) $('#demo-badge').classList.remove('hidden')
renderThreads()
loadOverview()
setInterval(() => { if (!document.hidden) { updateFreshness(); loadOverview({ silent: true }); if (state.view === 'files' && state.files.pagesLoaded <= 1) loadFiles({ silent: true }) } }, 4000)
setInterval(() => { if (!document.hidden) updateClock() }, 1000)
