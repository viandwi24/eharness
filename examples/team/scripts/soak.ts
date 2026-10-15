/**
 * Soak test of the team server (P40 phase I): several agents and programs working at once on one
 * SQLite file, a scripted model that fails on purpose, two server processes that fire the same
 * slots, and SIGKILL plus restart in the middle of runs. When the load stops, the work drains and
 * the invariants of `soak/invariants.ts` are checked on the database.
 *
 *   bun examples/team/scripts/soak.ts [--seconds 90] [--seed 1] [--fault-rate 0.12] [--quick]
 *
 * `--quick` is the CI-safe variant (about 30 s, also run by `server/test/soak.test.ts`).
 * Real processes on free ports; a process is only ever killed by its own PID (`lib.ts`).
 * Time is not faked: schedules use the shortest interval the product allows (10 s) and the
 * routine ticker runs every 500 ms; the heartbeat and the digest are triggered through the API
 * and a script-only control route because their own slots are 5 minutes and one day apart.
 */
import { resolve } from 'node:path'
import { freePorts, json, sleep, Workdir } from './lib.ts'
import { checkInvariants, formatViolations } from './soak/invariants.ts'

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback
}
const QUICK = process.argv.includes('--quick')
const SECONDS = Number(arg('seconds', QUICK ? '24' : '90'))
const SEED = Number(arg('seed', '1'))
const FAULT_RATE = Number(arg('fault-rate', '0.12'))
const SERVER = resolve(import.meta.dir, 'soak/server.ts')

const work = new Workdir()
const log = (message: string): void =>
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${message}`)
const t0 = Date.now()

// --- processes -----------------------------------------------------------------------------------

interface Node {
  id: string
  port: number
  proc?: ReturnType<typeof Bun.spawn>
  url: string
  incarnation: number
  lastBrain: { calls: number; faults: Record<string, number>; escalations: number }
}
const nodes: Node[] = []
const brainTotals = { calls: 0, escalations: 0, faults: {} as Record<string, number> }
const spawned = new Set<ReturnType<typeof Bun.spawn>>()
const killAll = (): void => {
  for (const p of spawned) if (p.exitCode === null) p.kill('SIGKILL')
}
process.on('exit', killAll)
setTimeout(
  () => {
    console.error('FAIL: the soak did not finish in time')
    killAll()
    process.exit(124)
  },
  (SECONDS + 240) * 1000,
).unref()

async function start(node: Node): Promise<void> {
  node.incarnation++
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('TEAM_') && k !== 'PORT'),
  )
  const lines: string[] = []
  const proc = Bun.spawn(['bun', '--no-env-file', SERVER], {
    env: {
      ...inherited,
      OPENROUTER_API_KEY: '',
      AI_GATEWAY_API_KEY: '',
      TEAM_DB: work.db,
      PORT: String(node.port),
      TEAM_INSTANCE_ID: node.id,
      SOAK_SEED: String(SEED + node.incarnation * 7919 + node.port),
      SOAK_FAULT_RATE: String(FAULT_RATE),
      TEAM_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const pump = async (s: ReadableStream<Uint8Array>): Promise<void> => {
    const d = new TextDecoder()
    for await (const part of s) lines.push(...d.decode(part).split('\n').filter(Boolean))
  }
  void pump(proc.stdout as ReadableStream<Uint8Array>)
  void pump(proc.stderr as ReadableStream<Uint8Array>)
  spawned.add(proc)
  node.proc = proc
  node.lastBrain = { calls: 0, faults: {}, escalations: 0 }
  const end = Date.now() + 60_000
  for (;;) {
    try {
      if ((await fetch(`${node.url}/__soak/info`)).ok) return
    } catch {}
    if (proc.exitCode !== null) throw new Error(`${node.id} exited early:\n${lines.join('\n')}`)
    if (Date.now() > end) throw new Error(`${node.id} did not start:\n${lines.join('\n')}`)
    await sleep(100)
  }
}

/** Fold the counters of the incarnation that ends into the totals. */
async function harvest(node: Node): Promise<void> {
  try {
    const info = await json<{ brain: Node['lastBrain'] }>(await fetch(`${node.url}/__soak/info`))
    node.lastBrain = info.brain
  } catch {}
  brainTotals.calls += node.lastBrain.calls
  brainTotals.escalations += node.lastBrain.escalations
  for (const [k, v] of Object.entries(node.lastBrain.faults)) {
    brainTotals.faults[k] = (brainTotals.faults[k] ?? 0) + v
  }
}
async function kill(node: Node): Promise<void> {
  await harvest(node)
  // by PID only: this process, never a pattern
  node.proc?.kill('SIGKILL')
  await node.proc?.exited
  log(`SIGKILL ${node.id} (pid ${node.proc?.pid})`)
}
async function stop(node: Node): Promise<void> {
  await harvest(node)
  node.proc?.kill('SIGTERM')
  await Promise.race([node.proc?.exited, sleep(8000)])
  if (node.proc?.exitCode === null) node.proc.kill('SIGKILL')
}

// --- HTTP ----------------------------------------------------------------------------------------

const httpErrors: Record<string, number> = {}
const live = (): Node[] => nodes.filter((n) => n.proc !== undefined && n.proc.exitCode === null)
let rr = 0
const pick = (): Node | undefined => {
  const l = live()
  return l[rr++ % Math.max(l.length, 1)]
}
async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T | undefined> {
  const node = pick()
  if (node === undefined) return undefined
  try {
    const res = await fetch(`${node.url}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    })
    const text = await res.text()
    if (!res.ok) {
      const key = `${method} ${path.replace(/[0-9a-f-]{20,}/g, ':id').split('?')[0]} ${res.status}`
      httpErrors[key] = (httpErrors[key] ?? 0) + 1
      if (httpErrors[key] === 1) log(`HTTP ${key}: ${text.slice(0, 200)}`)
      return undefined
    }
    return text === '' ? undefined : (JSON.parse(text) as T)
  } catch {
    return undefined // the node was killed under the request: the load tolerates it
  }
}

// --- the scenario --------------------------------------------------------------------------------

const [portA, portB] = freePorts(2) as [number, number]
nodes.push(
  {
    id: 'soak-a',
    port: portA,
    url: `http://127.0.0.1:${portA}`,
    incarnation: 0,
    lastBrain: { calls: 0, faults: {}, escalations: 0 },
  },
  {
    id: 'soak-b',
    port: portB,
    url: `http://127.0.0.1:${portB}`,
    incarnation: 0,
    lastBrain: { calls: 0, faults: {}, escalations: 0 },
  },
)
const [A, B] = nodes as [Node, Node]

const queuedIds: string[] = []
const sentBack: Record<string, number> = {}
const programIds: string[] = []
let leadId = ''
let workerId = ''
let decided = 0
const digests = { sent: 0, other: 0 }

async function setup(): Promise<void> {
  const info = await json<{ agents: Record<string, string> }>(await fetch(`${A.url}/__soak/info`))
  leadId = info.agents.lead as string
  const base = {
    brief: 'Do the work and write the result into the library.',
    authority: { read: ['/library/**'], write: ['/library/reports/**'] },
    gates: [],
    escalation: 'Ask when unsure.',
    forbidden: [],
    budget: { perRunUsd: null, perDayUsd: null },
  }
  const every10s = { kind: 'schedule', spec: { kind: 'every', everyMs: 10_000 } }
  const make = async (body: Record<string, unknown>): Promise<string> => {
    const p = await api<{ id: string }>('POST', '/programs', { ...base, ...body })
    if (p === undefined) throw new Error(`could not create program ${String(body.name)}`)
    programIds.push(p.id)
    return p.id
  }
  await make({ agentId: 'researcher', name: 'Scheduled researcher', trigger: every10s })
  await make({ agentId: 'researcher', name: 'Scheduled researcher 2', trigger: every10s })
  await make({ agentId: 'lead', name: 'Scheduled lead', trigger: every10s, report: 'digest' })
  await make({ agentId: 'researcher', name: 'Manual researcher' })
  workerId = await make({
    agentId: 'writer',
    name: 'Script worker',
    worker: { maxTasks: 3 },
    authority: { read: ['/library/**'], write: ['/library/scripts/**'] },
    trigger: every10s,
  })
  await api('PATCH', `/agents/${leadId}/heartbeat`, {
    activeFrom: '00:00',
    activeTo: '00:00',
    timezone: 'UTC',
  })
}

let taskSeq = 0
async function load(): Promise<void> {
  // new work, steady: a queued task every tick, run-now of the manual and worker programs
  const t = await api<{ id: string }>('POST', '/tasks', {
    agentId: 'writer',
    title: `Script ${++taskSeq}`,
    brief: 'Write it.',
  })
  if (t !== undefined) queuedIds.push(t.id)
  const manual = programIds[3]
  if (taskSeq % 2 === 0 && manual !== undefined) await api('POST', `/programs/${manual}/run`)
  if (taskSeq % 3 === 0) await api('POST', `/programs/${workerId}/run`)
  if (taskSeq % 4 === 0) await api('POST', `/agents/${leadId}/heartbeat/run`)
  if (taskSeq % 7 === 0) {
    const n = pick()
    if (n !== undefined) {
      try {
        const r = await json<{ outcome: string }>(
          await fetch(`${n.url}/__soak/digest`, { method: 'POST' }),
        )
        digests[r.outcome === 'sent' ? 'sent' : 'other']++
      } catch {}
    }
  }
}

async function decide(): Promise<void> {
  const open = await api<{ decisions: Array<{ id: string; kind: string }> }>(
    'GET',
    '/decisions?status=open',
  )
  for (const d of open?.decisions ?? []) {
    const ok = taskSeq % 5 !== 0
    const res = await api(
      'POST',
      `/decisions/${d.id}/${ok ? 'approve' : 'reject'}`,
      ok ? { choice: 'yes', note: 'go ahead' } : { note: 'not now' },
    )
    if (res !== undefined) decided++
  }
}

async function review(): Promise<void> {
  const list = await api<{
    tasks: Array<{
      id: string
      status: string
      acceptedAt: number | null
      round: number
      report: { status: string } | null
      createdBy: string | null
    }>
  }>('GET', '/tasks?limit=200&status=done')
  let n = 0
  for (const t of list?.tasks ?? []) {
    if (
      t.createdBy !== 'client' ||
      t.acceptedAt !== null ||
      t.report === null ||
      !queuedIds.includes(t.id)
    )
      continue
    if (n++ >= 2) break
    if (
      t.round === 1 &&
      (sentBack[t.id] ?? 0) === 0 &&
      Number(t.id.charCodeAt(t.id.length - 1)) % 3 === 0
    ) {
      const res = await api('POST', `/tasks/${t.id}/send-back`, { note: 'Shorter please.' })
      if (res !== undefined) sentBack[t.id] = 1
    } else {
      await api('POST', `/tasks/${t.id}/accept`)
    }
  }
}

interface TaskRow {
  id: string
  status: string
}
async function drain(): Promise<void> {
  log('drain: pausing the programs, answering every decision, running the queue dry')
  for (const id of programIds) await api('POST', `/programs/${id}/pause`)
  await api('PATCH', `/agents/${leadId}/heartbeat`, { enabled: false })
  const end = Date.now() + 120_000
  for (;;) {
    await decide()
    const all = await api<{ tasks: TaskRow[] }>('GET', '/tasks?limit=500')
    const rows = all?.tasks ?? []
    const queued = rows.filter((t) => t.status === 'queued')
    if (queued.length > 0) await api('POST', `/programs/${workerId}/run`)
    // a turn that failed on an injected provider fault waits for its automatic retry (30 s and
    // more): run those retries now instead of waiting out the backoff
    for (const t of rows.filter((x) => x.status === 'retrying')) {
      await api('POST', `/tasks/${t.id}/retry`)
    }
    const busy = rows.filter((t) =>
      ['running', 'queued', 'needs_action', 'retrying'].includes(t.status),
    )
    const open = await api<{ decisions: unknown[] }>('GET', '/decisions?status=open')
    if (busy.length === 0 && (open?.decisions ?? []).length === 0) {
      await sleep(1500) // let the last hooks (outcomes, beat records) land
      return
    }
    if (Date.now() > end) {
      log(`drain gave up: busy ${JSON.stringify(busy.slice(0, 5))}`)
      return
    }
    await sleep(500)
  }
}

let failed = false
try {
  await start(A)
  await setup()
  log(`A up on ${A.port}; programs ${programIds.length}, seed ${SEED}, fault rate ${FAULT_RATE}`)
  const plan = [
    {
      at: 0.18,
      run: async () => {
        await start(B)
        log('B joined: two instances on one file')
      },
    },
    {
      at: 0.4,
      run: async () => {
        await kill(A)
      },
    },
    {
      at: 0.48,
      run: async () => {
        await start(A)
        log('A restarted (same instance id)')
      },
    },
    {
      at: 0.68,
      run: async () => {
        await kill(B)
      },
    },
    {
      at: 0.74,
      run: async () => {
        await start(B)
        log('B restarted (same instance id)')
      },
    },
  ]
  const end = Date.now() + SECONDS * 1000
  const begin = Date.now()
  let next = 0
  let tick = 0
  while (Date.now() < end) {
    const progress = (Date.now() - begin) / (SECONDS * 1000)
    const step = plan[next]
    if (step !== undefined && progress >= step.at) {
      next++
      await step.run()
    }
    await Promise.all([load(), decide()])
    if (++tick % 3 === 0) await review()
    await sleep(350)
  }
  await drain()
  // a clean stop of both so the database file is quiet (no -wal writer) for the checks
  for (const n of nodes) if (n.proc !== undefined && n.proc.exitCode === null) await stop(n)

  const violations = checkInvariants(work.db, { queuedIds, sentBack, leadId })
  const { Database } = await import('bun:sqlite')
  const db = new Database(work.db, { readonly: true })
  const count = (sql: string): Record<string, number> =>
    Object.fromEntries(
      (db.query(sql).all() as Array<{ k: string; n: number }>).map((r) => [r.k, r.n]),
    )
  const summary = {
    seconds: Math.round((Date.now() - t0) / 1000),
    tasksByStatus: count('SELECT state AS k, COUNT(*) AS n FROM tasks GROUP BY state'),
    tasksByOrigin: count('SELECT origin AS k, COUNT(*) AS n FROM tasks GROUP BY origin'),
    routineRuns: count('SELECT status AS k, COUNT(*) AS n FROM routine_runs GROUP BY status'),
    decisions: count("SELECT kind || ':' || status AS k, COUNT(*) AS n FROM decisions GROUP BY 1"),
    modelCalls: count('SELECT status AS k, COUNT(*) AS n FROM model_calls GROUP BY status'),
    queuedByDriver: queuedIds.length,
    sentBack: Object.keys(sentBack).length,
    decidedByDriver: decided,
    digestRuns: digests,
    brain: brainTotals,
    httpErrors,
  }
  db.close()
  console.log(JSON.stringify(summary, null, 2))
  if (violations.length > 0) {
    failed = true
    console.log(
      `\nFAIL: ${violations.length} invariant violation(s)\n${formatViolations(violations)}`,
    )
  } else {
    console.log('\nPASS: every invariant holds')
  }
} catch (error) {
  failed = true
  console.log(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
} finally {
  killAll()
  if (failed && !process.env.KEEP_DIR) console.log(`(set KEEP_DIR=1 to keep ${work.dir})`)
  work.cleanup()
}
process.exit(failed ? 1 : 0)
