/** Entry point: configuration from the environment, see README.md. */
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

const server = await startServer({
  token,
  port: num('PORT', 4100),
  hostname: process.env.HOST ?? '0.0.0.0',
  dataDir: process.env.SANDBOX_DATA ?? '/tmp/eh-sandboxes',
  python: process.env.PYTHON ?? 'python3',
  osSandbox: process.env.SANDBOX_OS !== 'off',
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
