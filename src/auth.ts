import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

type LoginProcess = {
  stdin: NodeJS.WritableStream
  stop: () => void
}

const URL_RE = /https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s\x07\x1b]+/

export async function authStatus(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('claude', ['auth', 'status'], { timeout: 15_000 })
    const status = JSON.parse(stdout) as { loggedIn?: boolean }
    return status.loggedIn === true
  } catch {
    return false
  }
}

export function startLogin(handlers: {
  onUrl: (url: string) => void
  onDone: (ok: boolean, message: string) => void
}): LoginProcess {
  const child = spawn('claude', ['auth', 'login', '--claudeai'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
  })

  let output = ''
  let urlSent = false
  let settled = false

  const consume = (chunk: Buffer): void => {
    output = (output + chunk.toString()).slice(-20_000)
    if (urlSent) return
    const url = output.match(URL_RE)?.[0]
    if (url) {
      urlSent = true
      handlers.onUrl(url)
    }
  }

  child.stdout.on('data', consume)
  child.stderr.on('data', consume)
  child.once('error', (err) => {
    if (settled) return
    settled = true
    handlers.onDone(false, err.message)
  })
  child.once('close', (code) => {
    if (settled) return
    settled = true
    const ok = code === 0 && /login successful/i.test(output)
    handlers.onDone(ok, ok ? 'Авторизация Claude обновлена.' : 'Вход не завершён. Запусти /login ещё раз.')
  })

  const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60_000)
  child.once('close', () => clearTimeout(timer))

  return {
    stdin: child.stdin,
    stop: () => child.kill('SIGTERM'),
  }
}
