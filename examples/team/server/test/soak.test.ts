/**
 * The soak test (docs/guides/walkthrough-server.md, Operations): the invariant checker is tested
 * on deliberately broken rows, and the CI-safe variant of the soak script runs real server
 * processes, injected provider faults and SIGKILL/restart (about 45 s).
 */
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkInvariants } from '../../scripts/soak/invariants.ts'
import { compose } from '../src/main.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function freshDb(): Promise<{ file: string; leadId: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'team-soak-'))
  dirs.push(dir)
  const file = join(dir, 'team.db')
  const server = compose({
    dbFile: file,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    env: {},
  })
  await server.ready
  const lead = server.deps.agents.getBySlug('lead')
  await server.close()
  return { file, leadId: lead?.id as string }
}

const ctx = (leadId: string) => ({ queuedIds: [], sentBack: {}, leadId })
const names = (v: Array<{ invariant: string }>): string[] =>
  [...new Set(v.map((x) => x.invariant))].sort()

describe('the invariant checker', () => {
  test('a fresh database is consistent', async () => {
    const { file, leadId } = await freshDb()
    expect(checkInvariants(file, ctx(leadId))).toEqual([])
  })

  test('it names every kind of inconsistency', async () => {
    const { file, leadId } = await freshDb()
    const db = new Database(file)
    const now = Date.now()
    // a task stuck running, a lost queued task, a decision left open, a beat left running
    db.run(
      "INSERT INTO tasks (id, agent_id, session_id, origin, title, state, started_at) VALUES ('t1', 'a', 'program:p1:1', 'program', 'x', 'running', 1)",
    )
    db.run(
      "INSERT INTO decisions (id, kind, status, title, agent_id, payload, created_at) VALUES ('d1', 'escalation', 'open', 'q', 'a', '{}', 1)",
    )
    db.run("INSERT INTO settings (key, value, updated_at) VALUES ('heartbeat:a:state', ?, 1)", [
      JSON.stringify({
        fingerprints: {},
        beats: [{ id: 'b1', at: 5, endedAt: null, status: 'running', reason: null, items: [] }],
      }),
    ])
    // a program run that has no task, an eh session with a pending wait, a twice-sent digest
    db.run(
      "INSERT INTO routines (id, agent_id, name, prompt, spec, created_at, updated_at, program_id) VALUES ('r1', 'a', 'n', 'p', '{}', 1, 1, 'p1')",
    )
    db.run(
      "INSERT INTO routine_runs (id, routine_id, scheduled_at, trigger, status, session_id, claimed_at) VALUES ('rr1', 'r1', 1, 'schedule', 'succeeded', 'program:p1:9', 1)",
    )
    db.run(
      "INSERT INTO eh_state (session_id, state, rev, updated_at) VALUES ('program:p1:7', ?, 1, 1)",
      [JSON.stringify({ core: { pending: { approvals: [] } } })],
    )
    for (const id of ['m1', 'm2']) {
      db.run(
        "INSERT INTO eh_messages (session_id, id, role, parts, created_at) VALUES (?, ?, 'assistant', ?, ?)",
        [
          `dm:${leadId}`,
          id,
          JSON.stringify([{ type: 'data-eh.event', data: { name: 'daily-digest', text: id } }]),
          now,
        ],
      )
    }
    db.run(
      "INSERT INTO eh_budget_scope (scope, period_start, spent_usd) VALUES ('workspace:default', 0, '1.5')",
    )
    db.close()
    const found = checkInvariants(file, { queuedIds: ['gone'], sentBack: {}, leadId })
    expect(names(found)).toEqual([
      'budget',
      'decisions',
      'digest-once',
      'heartbeat',
      'no-stuck-task',
      'orphans',
      'queue-lost',
      'run-has-task',
    ])
  })
})

describe('the soak script', () => {
  test('the quick variant: faults, two instances, SIGKILL and restart, then every invariant holds', async () => {
    const script = resolve(import.meta.dir, '../../scripts/soak.ts')
    const proc = Bun.spawn(['bun', '--no-env-file', script, '--quick'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !k.startsWith('TEAM_') && k !== 'PORT'),
      ),
    })
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(`${out}\n${err}`).toContain('PASS: every invariant holds')
    expect(proc.exitCode).toBe(0)
  }, 180_000)
})
