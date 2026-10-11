/**
 * Shared helpers of the process scripts: spawn real server processes over one database file,
 * scripted model files, HTTP and SSE helpers, a tiny PASS/FAIL runner.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const SERVER_MAIN = resolve(dirname(import.meta.path), '../server/src/main.ts')
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Free TCP ports for the instances (the OS picks them, so parallel runs and busy machines never
 * clash). All `n` are held open at once so they are distinct, then released.
 */
export function freePorts(n: number): number[] {
  const servers = Array.from({ length: n }, () =>
    Bun.serve({ port: 0, fetch: () => new Response('') }),
  )
  const ports = servers.map((s) => s.port as number)
  for (const s of servers) s.stop(true)
  return ports
}

/** Every server process a script started: killed on any exit so a crash never leaves one behind. */
const spawned = new Set<ReturnType<typeof Bun.spawn>>()
const killAll = (): void => {
  for (const proc of spawned) if (proc.exitCode === null) proc.kill('SIGKILL')
}
process.on('exit', killAll)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    killAll()
    process.exit(130)
  })
}
/**
 * Overall limit of a script run (a hung server or scenario must not hang CI). `--wait-stale`
 * really waits about 2.5 minutes, so it gets more.
 */
const OVERALL_MS = Number(
  process.env.SCRIPT_TIMEOUT_MS ?? (process.argv.includes('--wait-stale') ? 600_000 : 240_000),
)
setTimeout(() => {
  console.error(`\nFAIL: the script did not finish within ${OVERALL_MS} ms`)
  killAll()
  process.exit(124)
}, OVERALL_MS).unref()

export type Step = Record<string, unknown>
export type Chunk = { type: string; [key: string]: unknown }

export interface Instance {
  name: string
  port: number
  url: string
  proc: ReturnType<typeof Bun.spawn>
  log: string[]
  /** SIGKILL: no graceful close. */
  kill(): Promise<void>
  /** SIGTERM and wait. */
  stop(): Promise<void>
}

export class Workdir {
  dir = mkdtempSync(join(tmpdir(), 'team-scripts-'))
  db = join(this.dir, 'team.db')
  private n = 0
  /** Write a scripted-model file (JSON array of scripted steps) and return its path. */
  script(steps: Step[]): string {
    const file = join(this.dir, `script-${this.n++}.json`)
    writeFileSync(file, JSON.stringify(steps))
    return file
  }
  cleanup(): void {
    if (process.env.KEEP_DIR) console.log(`kept ${this.dir}`)
    else rmSync(this.dir, { recursive: true, force: true })
  }
}

export async function startInstance(
  name: string,
  port: number,
  work: Workdir,
  steps: Step[],
  env: Record<string, string> = {},
): Promise<Instance> {
  const log: string[] = []
  // Hermetic: a developer's `.env` (a `TEAM_TOKEN`, a budget, a model) or exported `TEAM_*`
  // variables must not change what the scenarios see, so none of them reaches the server.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('TEAM_') && key !== 'PORT'),
  )
  const proc = Bun.spawn(['bun', '--no-env-file', SERVER_MAIN], {
    env: {
      ...inherited,
      OPENROUTER_API_KEY: '',
      AI_GATEWAY_API_KEY: '',
      TEAM_DB: work.db,
      PORT: String(port),
      TEAM_SCRIPTED_MODEL: work.script(steps),
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder()
    for await (const part of stream) log.push(...decoder.decode(part).split('\n').filter(Boolean))
  }
  spawned.add(proc)
  void pump(proc.stdout as ReadableStream<Uint8Array>)
  void pump(proc.stderr as ReadableStream<Uint8Array>)
  const url = `http://localhost:${port}`
  const end = Date.now() + 30_000
  for (;;) {
    try {
      if ((await fetch(`${url}/health`)).ok) break
    } catch {}
    if (proc.exitCode !== null) throw new Error(`${name} exited early:\n${log.join('\n')}`)
    if (Date.now() > end) throw new Error(`${name} did not start:\n${log.join('\n')}`)
    await sleep(100)
  }
  return {
    name,
    port,
    url,
    proc,
    log,
    async kill() {
      proc.kill('SIGKILL')
      await proc.exited
    },
    async stop() {
      proc.kill('SIGTERM')
      await Promise.race([proc.exited, sleep(5000)])
      if (proc.exitCode === null) proc.kill('SIGKILL')
    },
  }
}

export const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
/** A chat body whose `id` is the session id of the path (`eharness/http`). */
export const postAs = (sessionId: string, body: Record<string, unknown>): RequestInit =>
  post({ id: sessionId, ...body })
/** Answer an item of the attention queue (`POST /attention/{id}/answer`). */
export const answerItem = (
  i: Instance,
  item: { id: string; sessionId: string },
  answer: Record<string, unknown>,
): Promise<Response> =>
  fetch(
    `${i.url}/attention/${encodeURIComponent(item.id)}/answer`,
    post({
      sessionId: item.sessionId,
      answer: { kind: 'answers' in answer ? 'question' : 'approval', ...answer },
    }),
  )
export const userMessage = (text: string): { messages: unknown[] } => ({
  messages: [{ id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] }],
})

export function parseSse(text: string): { chunks: Chunk[]; done: boolean } {
  const chunks: Chunk[] = []
  let done = false
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const data = line.slice(6)
    if (data === '[DONE]') done = true
    else chunks.push(JSON.parse(data) as Chunk)
  }
  return { chunks, done }
}

export async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

export interface ApprovalItem {
  id: string
  kind: string
  sessionId: string
  parentSessionId: string | null
  agentName: string
  taskId: string | null
  toolName: string
}
export interface TaskItem {
  id: string
  status: string
  pendingKind: string | null
  summary?: string | null
}
export interface StoredMessage {
  id: string
  role: string
  parts: Array<Record<string, unknown>>
  metadata?: { eharness?: { stop?: string; pending?: unknown } }
}

export const approvals = async (i: Instance): Promise<ApprovalItem[]> =>
  (await json<{ approvals: ApprovalItem[] }>(await fetch(`${i.url}/approvals`))).approvals
export const tasks = async (i: Instance, query = ''): Promise<TaskItem[]> =>
  (await json<{ tasks: TaskItem[] }>(await fetch(`${i.url}/tasks${query}`))).tasks
export const messages = async (i: Instance, agent: string): Promise<StoredMessage[]> =>
  (
    await json<{ messages: StoredMessage[] }>(
      await fetch(`${i.url}/sessions/dm:${agent}/messages?limit=100`),
    )
  ).messages

export async function until(
  what: string,
  condition: () => boolean | Promise<boolean>,
  ms = 20_000,
): Promise<void> {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(100)
  }
}

export const delegate = (name: string, toolCallId: string, prompt = 'Remove /library/old.md') => ({
  toolName: 'agent',
  toolCallId,
  input: { subagent_type: 'researcher', description: 'Clean up', prompt, name },
})
export const deleteOld = { toolName: 'delete_file', input: { path: '/library/old.md' } }

export interface Result {
  name: string
  status: 'PASS' | 'FAIL' | 'SKIP'
  reason: string
}
const results: Result[] = []
export async function scenario(
  name: string,
  run: () => Promise<string | undefined>,
): Promise<void> {
  try {
    const note = await run()
    if (typeof note === 'string' && note.startsWith('SKIP')) {
      results.push({ name, status: 'SKIP', reason: note })
      console.log(`SKIP ${name}: ${note}`)
    } else {
      results.push({ name, status: 'PASS', reason: note ?? 'ok' })
      console.log(`PASS ${name}${note ? `: ${note}` : ''}`)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    results.push({ name, status: 'FAIL', reason })
    console.log(`FAIL ${name}: ${reason}`)
  }
}
export function finish(): never {
  const failed = results.filter((r) => r.status === 'FAIL').length
  console.log(
    `\n${results.filter((r) => r.status === 'PASS').length} passed, ${failed} failed, ${results.filter((r) => r.status === 'SKIP').length} skipped`,
  )
  process.exit(failed > 0 ? 1 : 0)
}
export function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason)
}
