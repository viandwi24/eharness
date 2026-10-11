/**
 * A turn a dead process left active is closed by the repair pass (no waiting for the stale
 * timeout), the chat can continue at once, and the task row of an interrupted delegation says
 * `interrupted` (not `failed`). Two `compose()` calls on one database stand for the killed and the
 * restarted instance; the heartbeat of the "dead" one is aged by SQL.
 */
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import { deriveTaskStatus, statusFromStop } from '../src/domain/tasks.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { sqliteLock } from '../src/infra/eh/storage.ts'
import { compose, type Server } from '../src/main.ts'
import { postAs, userMessage } from './support/http.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 6000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(15)
  }
}
const TUNING = { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 }

function instance(dir: string, steps: ScriptedStepInput[], first = false): Server {
  const model = scriptedModel(steps)
  const config: ModelConfig = {
    provider: 'scripted',
    defaultModel: 'none',
    resolve: () => model,
  }
  const server = compose({
    dbFile: join(dir, 'team.db'),
    models: config,
    tuning: TUNING,
    eventsPollMs: 30,
    reconcile: { onBoot: !first, everyMs: 0 },
  })
  servers.push(server)
  return server
}

describe('task status of interrupted work', () => {
  test('a stopped-by-crash turn is interrupted, not failed', () => {
    expect(statusFromStop('interrupted')).toBe('interrupted')
    const base = { pendingApprovals: 0, pendingQuestions: 0, activeTurn: false }
    expect(deriveTaskStatus({ ...base, staleTurn: true, lastStop: null }).status).toBe(
      'interrupted',
    )
    expect(
      deriveTaskStatus({ ...base, staleTurn: false, lastStop: null, interruptedNotice: true })
        .status,
    ).toBe('interrupted')
    expect(deriveTaskStatus({ ...base, staleTurn: false, lastStop: 'error' }).status).toBe('failed')
  })
})

describe('the lock of a restarted instance', () => {
  test('is taken over for the same stable owner, never from a live sibling or another owner', async () => {
    const db = new Database(':memory:')
    db.run(
      'CREATE TABLE eh_locks (session_id TEXT PRIMARY KEY, owner TEXT NOT NULL, until INTEGER NOT NULL)',
    )
    const signal = new AbortController().signal
    const first = sqliteLock(db, { owner: 'srv', takeOver: true, leaseMs: 60_000 })
    const release = await first.acquire('s', { signal })
    // a sibling object of the same process (same owner prefix) must not take it
    const sibling = sqliteLock(db, { owner: 'srv', takeOver: true, leaseMs: 60_000 })
    expect(sibling.acquire('s', { signal })).resolves.toBeDefined()
    await release()
    db.run("INSERT OR REPLACE INTO eh_locks VALUES ('t', 'srv:old-run', ?)", [Date.now() + 60_000])
    // the restarted instance (fresh lock object, same owner) takes over what its previous run held
    const restarted = sqliteLock(db, { owner: 'srv', takeOver: true, leaseMs: 60_000 })
    expect(await restarted.acquire('t', { signal })).toBeDefined()
    // another instance cannot
    db.run("INSERT OR REPLACE INTO eh_locks VALUES ('u', 'other:run', ?)", [Date.now() + 60_000])
    expect(restarted.acquire('u', { signal })).rejects.toThrow('locked elsewhere')
    db.close()
  })
})

describe('boot repair of a dead turn', () => {
  test('the repair pass closes it, the chat answers at once, the message has no dangling call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-restart-'))
    dirs.push(dir)
    // instance A "dies" in the middle of a turn: a slow step with a tool call
    const a = instance(
      dir,
      [
        {
          text: 'working',
          toolCalls: [{ toolName: 'write_file', input: { path: '/library/z.md', content: 'z' } }],
          delayMs: 400,
        },
      ],
      true,
    )
    for (const slug of ['lead', 'researcher']) {
      const def = a.deps.agents.getBySlug(slug)
      if (def === undefined) throw new Error('seed missing')
      updateAgent(a.deps, def.id, { model: 'm' })
    }
    const res = await a.app.request(
      '/sessions/dm:researcher/chat',
      postAs(`dm:researcher`, userMessage('start')),
    )
    expect(res.status).toBe(200)
    void res.text().catch(() => undefined)
    const stats = async (s: Server) =>
      (await (await s.app.request('/agents/researcher/stats')).json()) as {
        activeTurn: { owner: string } | null
      }
    await until('turn active', async () => (await stats(a)).activeTurn !== null)
    // the owner is gone: its heartbeat is old
    const sqlite = new Database(join(dir, 'team.db'))
    sqlite.run(
      "UPDATE eh_state SET state = json_set(state, '$.core.activeTurn.heartbeatAt', 0) WHERE json_extract(state, '$.core.activeTurn') IS NOT NULL",
    )
    sqlite.run('UPDATE eh_locks SET until = 0')
    sqlite.close()

    const b = instance(dir, [{ text: 'back again' }])
    await b.ready
    await until('recovered by the repair pass', async () => (await stats(b)).activeTurn === null)
    const stored = (await (await b.app.request('/sessions/dm:researcher/messages')).json()) as {
      messages: Array<{
        role: string
        metadata?: { eharness?: { stop?: string; kind?: string } }
        parts: Array<{ type: string; state?: string }>
      }>
    }
    const interrupted = stored.messages.find((m) => m.metadata?.eharness?.stop === 'interrupted')
    expect(interrupted).toBeDefined()
    const dangling = stored.messages
      .flatMap((m) => m.parts)
      .filter((p) => p.type.startsWith('tool-') && p.state === 'input-available')
    expect(dangling).toHaveLength(0)
    const next = await b.app.request(
      '/sessions/dm:researcher/chat',
      postAs(`dm:researcher`, userMessage('Continue')),
    )
    expect(next.status).toBe(200)
    expect(await next.text()).toContain('back again')
  })
})
