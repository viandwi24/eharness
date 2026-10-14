/** Entry point: configuration from the environment, see README.md. */
import { mkdirSync } from 'node:fs'
import { chromeRuntime } from 'eharness/browser/node'
import { DEFAULT_LIMITS, startServer } from './server.ts'

const num = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`)
  return n
}

const token = process.env.SANDBOX_TOKEN
if (!token || token.length < 8) {
  console.error('SANDBOX_TOKEN is required (at least 8 characters)')
  process.exit(1)
}

// SANDBOX_BROWSER=1 turns on /v1/browser (a managed Chrome, see README.md). Chrome listens on
// loopback only; the image needs the system libraries (build arg SANDBOX_BROWSER_LIBS=1).
const dataDir = process.env.SANDBOX_DATA ?? '/tmp/eh-sandboxes'
const browserRoot = process.env.SANDBOX_BROWSER_ROOT ?? `${dataDir}/browser`
if (process.env.SANDBOX_BROWSER === '1') {
  // 0700: the per-session users of the code sandbox must not read profiles (logins) or Chrome
  mkdirSync(browserRoot, { recursive: true, mode: 0o700 })
}
const browser =
  process.env.SANDBOX_BROWSER === '1'
    ? chromeRuntime({ root: browserRoot, xvfb: process.env.SANDBOX_BROWSER_XVFB === '1' })
    : undefined

const server = await startServer({
  token,
  ...(browser === undefined ? {} : { browser }),
  port: num('PORT', 4100),
  hostname: process.env.HOST ?? '0.0.0.0',
  dataDir,
  python: process.env.PYTHON ?? 'python3',
  osSandbox: process.env.SANDBOX_OS !== 'off',
  uidBase: num('SANDBOX_UID_BASE', 20_000),
  denyRead: [process.env.SANDBOX_APP_DIR ?? '/app'],
  limits: {
    cpuSeconds: num('SANDBOX_CPU_SECONDS', DEFAULT_LIMITS.cpuSeconds),
    memoryMb: num('SANDBOX_MEMORY_MB', DEFAULT_LIMITS.memoryMb),
    fileMb: num('SANDBOX_FILE_MB', DEFAULT_LIMITS.fileMb),
    processes: num('SANDBOX_PROCESSES', DEFAULT_LIMITS.processes),
    timeoutMs: num('SANDBOX_TIMEOUT_MS', DEFAULT_LIMITS.timeoutMs),
    maxFileMb: num('SANDBOX_MAX_FILE_MB', DEFAULT_LIMITS.maxFileMb),
    maxSessions: num('SANDBOX_MAX_SESSIONS', DEFAULT_LIMITS.maxSessions),
    idleMinutes: num('SANDBOX_IDLE_MINUTES', DEFAULT_LIMITS.idleMinutes),
  },
})
console.log(`sandbox-server listening on ${server.url}`)

const stop = (): void => {
  void server.stop().then(() => process.exit(0))
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
