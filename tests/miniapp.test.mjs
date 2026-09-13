import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHmac } from 'node:crypto'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vesperloop-test-'))
process.env.BOT_TOKEN = 'test-token'
process.env.ALLOWED_USER_IDS = '101'
process.env.WORKSPACES_DIR = path.join(temporary, 'workspaces')
process.env.DATA_FILE = path.join(temporary, 'state.json')
const { workspaceFor } = await import('../src/workspace.ts')
const { browseFiles, resolveFile, uploadFile, MAX_UPLOAD_BYTES } = await import('../src/web-files.ts')
const { changeDirectory, changeSession } = await import('../src/topic-settings.ts')
const { startWebServer } = await import('../src/web.ts')
const { getChat, listChats, save, saveNow, deleteChat } = await import('../src/state.ts')
const workspace = workspaceFor('101:1')
const other = workspaceFor('202:1')
const context = { workspace, cwd: workspace.root }
fs.writeFileSync(path.join(workspace.outbox, 'обзор.md'), '# Обзор\n\nГотово')
fs.writeFileSync(path.join(workspace.outbox, 'page.html'), '<script>alert(1)</script>')
fs.writeFileSync(path.join(workspace.outbox, 'document.pdf'), '%PDF-1.4\nfixture')
fs.writeFileSync(path.join(workspace.outbox, 'unknown.bin'), 'binary')
fs.writeFileSync(path.join(workspace.root, '.env'), 'secret')
fs.writeFileSync(path.join(other.root, 'private.txt'), 'other user')
fs.symlinkSync(other.root, path.join(workspace.root, 'escape'))
after(() => fs.rmSync(temporary, { recursive: true, force: true }))

test('folder browsing supports inbox, sent files and pagination; excludes hidden files and symlinks', () => {
  const listing = browseFiles(context, 'workspace', '', 0)
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['inbox', 'outbox'])
  assert.equal(listing.parent, null)
  fs.writeFileSync(path.join(workspace.sent, 'sent.txt'), 'sent')
  assert.equal(browseFiles(context, 'workspace', 'outbox/.sent', 0).entries[0].name, 'sent.txt')
  const folder = path.join(workspace.root, 'many')
  fs.mkdirSync(folder)
  for (let i = 0; i < 105; i++) fs.writeFileSync(path.join(folder, `${i}.txt`), '')
  const first = browseFiles(context, 'workspace', 'many', 0)
  const second = browseFiles(context, 'workspace', 'many', first.nextOffset)
  assert.equal(first.entries.length, 100)
  assert.equal(second.entries.length, 5)
  assert.equal(second.nextOffset, null)
  assert.equal(new Set([...first.entries, ...second.entries].map((entry) => entry.id)).size, 105)
})

test('file access rejects traversal, hidden paths, symlinks, other workspaces and outdated directory IDs', () => {
  for (const relative of ['..', '../202_1', '/etc', '.env', 'escape', 'outbox/../inbox', 'outbox\\file', 'outbox//file']) {
    assert.throws(() => browseFiles(context, 'workspace', relative, 0))
  }
  assert.throws(() => browseFiles(context, 'bad-root', '', 0))
  assert.throws(() => browseFiles(context, 'workspace', '', -1))
  const parentContext = { workspace, cwd: temporary }
  assert.throws(() => browseFiles(parentContext, 'cwd', 'workspaces/202_1', 0))
  const file = browseFiles(context, 'cwd', 'outbox', 0).entries.find((entry) => entry.name === 'обзор.md')
  assert.equal(resolveFile(context, file.id).name, 'обзор.md')
  assert.throws(() => resolveFile({ workspace, cwd: temporary }, file.id), /папка изменилась/)
  assert.throws(() => resolveFile({ workspace: other, cwd: other.root }, file.id))
  assert.throws(() => resolveFile(context, 'garbage'))
  const linked = path.join(workspace.outbox, 'linked.txt')
  fs.writeFileSync(linked, 'before')
  const linkedId = browseFiles(context, 'workspace', 'outbox', 0).entries.find((entry) => entry.name === 'linked.txt').id
  fs.unlinkSync(linked)
  fs.symlinkSync(path.join(other.root, 'private.txt'), linked)
  assert.throws(() => resolveFile(context, linkedId), /ссылки/)
})

test('uploads stay in inbox, preserve existing files and reject oversized or invalid uploads', () => {
  const first = uploadFile(context, '../../документ.txt', Buffer.from('first'))
  const second = uploadFile(context, '../../документ.txt', Buffer.from('second'))
  assert.notEqual(first.name, second.name)
  assert.equal(fs.readFileSync(path.join(workspace.inbox, first.name), 'utf8'), 'first')
  assert.equal(fs.readFileSync(path.join(workspace.inbox, second.name), 'utf8'), 'second')
  assert.throws(() => uploadFile(context, '', Buffer.from('no')))
  assert.throws(() => uploadFile(context, 'huge.bin', Buffer.alloc(MAX_UPLOAD_BYTES + 1)), /20 МБ/)
  const original = workspace.inbox + '-original'
  fs.renameSync(workspace.inbox, original)
  fs.symlinkSync(other.inbox, workspace.inbox)
  try { assert.throws(() => uploadFile(context, 'escape.txt', Buffer.from('no')), /ссылки/) }
  finally { fs.unlinkSync(workspace.inbox); fs.renameSync(original, workspace.inbox) }
})

test('session and directory changes reject busy/missing targets without partial changes', () => {
  const state = { sessionId: 'old', cwd: workspace.root, sessions: [
    { id: 'new', cwd: workspace.outbox }, { id: 'missing', cwd: path.join(temporary, 'missing') },
  ] }
  for (const action of [() => changeSession(state, 'new', true), () => changeSession(state, null, true),
    () => changeDirectory(state, workspace.root, 'outbox', true), () => changeSession(state, 'missing', false),
    () => changeSession(state, 'unknown', false), () => changeDirectory(state, workspace.root, 'missing', false)]) {
    assert.throws(action)
    assert.equal(state.sessionId, 'old')
    assert.equal(state.cwd, workspace.root)
  }
  assert.equal(changeSession(state, 'new', false), true)
  assert.equal(state.cwd, workspace.outbox)
  assert.equal(changeSession(state, 'new', false), false)
  changeDirectory(state, workspace.outbox, '..', false)
  assert.equal(state.cwd, workspace.root)
  changeDirectory(state, workspace.root, '~', false)
  assert.equal(state.cwd, null)
  changeSession(state, null, false)
  assert.equal(state.sessionId, null)
})

test('durable deletion keeps a retryable record on write failure and removes it on success', async (t) => {
  t.mock.method(console, 'error', () => {})
  getChat('101:99').topicName = 'Retriable'
  saveNow({ throwOnError: true })
  getChat('101:98').pinned = true
  save()
  const temporaryState = process.env.DATA_FILE + '.tmp'
  fs.mkdirSync(temporaryState)
  try {
    assert.throws(() => deleteChat('101:99', { persist: true }), /Повтори удаление/)
    assert.ok(listChats().some(([id]) => id === '101:99'))
    assert.ok(JSON.parse(fs.readFileSync(process.env.DATA_FILE, 'utf8'))['101:99'])
  } finally { fs.rmdirSync(temporaryState) }
  await delay(400)
  assert.equal(JSON.parse(fs.readFileSync(process.env.DATA_FILE, 'utf8'))['101:98'].pinned, true)
  deleteChat('101:99', { persist: true })
  assert.ok(!listChats().some(([id]) => id === '101:99'))
  assert.ok(!JSON.parse(fs.readFileSync(process.env.DATA_FILE, 'utf8'))['101:99'])
})

function authorization(userId = 101, age = 0) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000) - age), user: JSON.stringify({ id: userId }) })
  const check = [...params].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n')
  const secret = createHmac('sha256', 'WebAppData').update('test-token').digest()
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'))
  return `tma ${params}`
}

test('authenticated HTTP file flow, preview types and revocable download tickets', async () => {
  let exists = true
  const owned = (userId, scope) => {
    if (userId !== 101 || scope !== '101:1' || !exists) throw new Error('Тред не найден')
    return context
  }
  const server = startWebServer({
    port: 0, botToken: 'test-token', allowedUsers: new Set([101]),
    getOverview: async () => ({ topics: [] }), createTopic: async () => ({}), deleteAllTopics: async () => ({}),
    patchTopic: async () => ({}), deleteTopic: async () => ({}), stopTopic: async () => ({}), newSession: async () => ({}),
    listFiles: async (user, scope, root, relative, offset) => browseFiles(owned(user, scope), root, relative, offset),
    getFile: async (user, scope, id) => resolveFile(owned(user, scope), id),
    uploadFile: async (user, scope, name, data) => uploadFile(owned(user, scope), name, data),
  })
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const request = (url, options = {}) => fetch(base + url, { ...options, headers: { authorization: authorization(), ...options.headers } })
  try {
    for (const auth of ['', authorization(202), authorization(101, 90_000), authorization() + 'wrong']) {
      assert.equal((await request('/api/overview', { headers: { authorization: auth } })).status, 401)
    }
    assert.equal((await request('/api/topics/202:1/files')).status, 400)
    assert.equal((await request('/api/topics', { method: 'POST', body: '[]' })).status, 400)
    assert.equal((await request('/%ZZ')).status, 400)
    const pdfModule = await request('/vendor/pdfjs/pdf.mjs')
    assert.equal(pdfModule.status, 200)
    assert.match(pdfModule.headers.get('content-type'), /javascript/)
    await pdfModule.arrayBuffer()
    for (const url of ['/vendor/pdfjs/package.json', '/vendor/other/file.js', '/vendor/pdfjs/build/pdf.sandbox.mjs', '/vendor/pdfjs/cmaps/%2e%2e%2fpackage.json']) {
      assert.equal((await request(url)).status, 404)
    }
    const listing = await (await request('/api/topics/101:1/files?path=outbox')).json()
    const urlFor = (name) => `/api/topics/101:1/files/${listing.entries.find((entry) => entry.name === name).id}`
    const preview = await request(urlFor('обзор.md') + '/preview')
    assert.equal(preview.status, 200)
    assert.match(preview.headers.get('content-type'), /text\/plain/)
    assert.match(await preview.text(), /Обзор/)
    const html = await request(urlFor('page.html') + '/preview')
    assert.match(html.headers.get('content-type'), /text\/plain/)
    assert.equal(html.headers.get('x-content-type-options'), 'nosniff')
    assert.equal((await request(urlFor('document.pdf') + '/preview')).headers.get('content-type'), 'application/pdf')
    assert.equal((await request(urlFor('unknown.bin') + '/preview')).status, 400)
    const ticket = await (await request(urlFor('обзор.md'), { method: 'POST' })).json()
    const download = await fetch(base + ticket.url)
    assert.equal(download.status, 200)
    assert.match(download.headers.get('content-disposition'), /^attachment;/)
    assert.match(await download.text(), /Обзор/)
    const upload = await request('/api/topics/101:1/files?name=hello.txt', { method: 'POST', body: 'hello' })
    assert.equal(upload.status, 200)
    const uploaded = await upload.json()
    assert.equal(fs.readFileSync(path.join(workspace.inbox, uploaded.name), 'utf8'), 'hello')
    const oversized = await request('/api/topics/101:1/files?name=huge.bin', { method: 'POST', body: Buffer.alloc(MAX_UPLOAD_BYTES + 1) })
    assert.equal(oversized.status, 400)
    assert.match((await oversized.json()).error, /слишком большое/)
    exists = false
    assert.equal((await fetch(base + ticket.url)).status, 404)
    assert.equal((await fetch(base + '/download/' + 'a'.repeat(64))).status, 404)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})
