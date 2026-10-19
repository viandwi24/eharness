/**
 * Alarms (docs/plans/P54-alarms.md): every source fires once per incident, the rate limit batches,
 * a stuck run is interrupted (never run again), Ack and auto-clear keep the record, delivery falls
 * back to the bell. No model is involved anywhere.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ackAlarm,
  deliverAlarms,
  listAlarms,
  openAlarms,
  raiseApprovalExpired,
  raiseConnectionBroken,
  raiseRoutinePaused,
  raiseSystemAlarm,
  sweepAlarms,
} from '../src/app/alarms.ts'
import type { AlarmPush } from '../src/app/ports.ts'
import { ALARM_RATE_MS, dueAlarms, pushText, stuckRuns } from '../src/domain/alarms.ts'
import { EMPTY_SUPERVISOR_STATE, superviseObservation } from '../src/domain/supervisor.ts'
import type { Task } from '../src/domain/tasks.ts'
import { compose, type Server } from '../src/main.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface Instance {
  server: Server
  agentId: string
  pushed: string[]
  retried: string[]
  interrupted: string[]
  /** What the push stub answers. */
  answer: { value: 'sent' | 'unavailable' | 'throw' }
}

function instance(): Instance {
  const dir = mkdtempSync(join(tmpdir(), 'team-alarms-'))
  dirs.push(dir)
  const server = compose({
    dbFile: join(dir, 'team.db'),
    instanceId: 'alarms-test',
    env: {},
    tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 },
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    turnRetry: { tickMs: 0 },
  })
  servers.push(server)
  const def = server.deps.agents.getBySlug('lead')
  if (def === undefined) throw new Error('seed missing')
  const pushed: string[] = []
  const retried: string[] = []
  const interrupted: string[] = []
  const answer: Instance['answer'] = { value: 'sent' }
  const deps = server.deps as unknown as Record<string, unknown>
  deps.alarmPush = {
    push: async (text: string) => {
      if (answer.value === 'throw') throw new Error('transport down')
      if (answer.value === 'sent') pushed.push(text)
      return answer.value
    },
  } satisfies AlarmPush
  deps.interruptRun = async (task: Task) => {
    interrupted.push(task.id)
    return 'aborted'
  }
  const retry = server.deps.turnRetry as unknown as Record<string, unknown>
  retry.retryNow = async (sessionId: string) => {
    retried.push(sessionId)
    return { started: true }
  }
  return { server, agentId: def.id, pushed, retried, interrupted, answer }
}

/** A held queue task (a work item, so background work) in a given state. */
function task(
  i: Instance,
  state: 'failed' | 'interrupted' | 'timed_out' | 'running' | 'done',
  over: { title?: string; summary?: string; endedAgo?: number; idleMin?: number } = {},
): Task {
  const { deps, conn } = i.server
  const now = Date.now()
  const queued = deps.tasks.enqueue({
    agentId: i.agentId,
    title: over.title ?? 'Weekly report',
    brief: null,
    inputs: [],
    priority: 'normal',
    dueAt: null,
    createdBy: 'client',
    hold: true,
    now,
  })
  deps.tasks.claimTask(queued.id, now)
  const ended = now - (over.endedAgo ?? 60_000)
  const idle = now - (over.idleMin ?? 0) * 60_000
  if (state === 'running') {
    conn.sqlite.query('UPDATE tasks SET last_activity_at = ? WHERE id = ?').run(idle, queued.id)
  } else {
    conn.sqlite
      .query(
        'UPDATE tasks SET state = ?, ended_at = ?, last_activity_at = ?, summary = ? WHERE id = ?',
      )
      .run(state, ended, ended, over.summary ?? 'Provider unavailable: HTTP 502', queued.id)
  }
  return deps.tasks.get(queued.id) as Task
}

const settle = (i: Instance): Promise<unknown> => deliverAlarms(i.server.deps)

describe('failed runs', () => {
  test('a run that failed raises one alarm per incident, with why and the next step', async () => {
    const i = instance()
    const t = task(i, 'failed', { summary: 'The model provider rejected the API key' })
    const first = await sweepAlarms(i.server.deps)
    expect(first.failedRuns).toBe(1)
    // the same incident again (sweeps repeat every minute): nothing new, nothing sent twice
    expect((await sweepAlarms(i.server.deps)).failedRuns).toBe(0)
    await settle(i)
    const { alarms, open } = listAlarms(i.server.deps)
    expect(open).toBe(1)
    expect(alarms[0]).toMatchObject({ kind: 'run-failed', agentId: i.agentId, ackedAt: null })
    expect(alarms[0]?.refs[0]).toBe(`/tasks/${t.id}`)
    expect(alarms[0]?.text).toContain('rejected the API key')
    expect(alarms[0]?.text).toContain('Next:')
    expect(i.pushed).toHaveLength(1)
    expect(i.pushed[0]).toContain(`/tasks/${t.id}`)
  })

  test('interrupted and timed out runs count; a stopped run and an old run do not', async () => {
    const i = instance()
    task(i, 'interrupted', { title: 'a' })
    task(i, 'timed_out', { title: 'b' })
    task(i, 'failed', { title: 'old', endedAgo: 7 * 3_600_000 })
    expect((await sweepAlarms(i.server.deps)).failedRuns).toBe(2)
  })

  test('a run waiting for its automatic retry is not an alarm', async () => {
    const i = instance()
    const t = task(i, 'failed')
    const retry = i.server.deps.turnRetry as unknown as Record<string, unknown>
    retry.pending = (sessionId: string) =>
      sessionId === t.sessionId
        ? {
            attempt: 1,
            max: 4,
            nextAt: Date.now() + 1000,
            errorCode: 'x',
            errorMessage: 'y',
            running: false,
            sessionId,
          }
        : undefined
    expect((await sweepAlarms(i.server.deps)).failedRuns).toBe(0)
  })
})

describe('stuck runs', () => {
  test('pure: only running runs past the limit that are not parked on a decision', () => {
    const now = 10_000_000
    const runs = [
      { id: 'a', sessionId: 'sa', status: 'running', lastActivityAt: now - 50 * 60_000 },
      { id: 'b', sessionId: 'sb', status: 'running', lastActivityAt: now - 10 * 60_000 },
      { id: 'c', sessionId: 'sc', status: 'running', lastActivityAt: now - 90 * 60_000 },
      { id: 'd', sessionId: 'sd', status: 'needs_action', lastActivityAt: now - 90 * 60_000 },
    ]
    const out = stuckRuns(runs, { now, limitMs: 45 * 60_000, parked: new Set(['sc']) })
    expect(out.map((r) => r.id)).toEqual(['a'])
  })

  test('a run with no activity is interrupted through the stop path, alarmed once, never retried', async () => {
    const i = instance()
    const quiet = task(i, 'running', { idleMin: 60, title: 'Stuck report' })
    const busy = task(i, 'running', { idleMin: 5, title: 'Busy report' })
    const report = await sweepAlarms(i.server.deps)
    expect(report.stuck).toBe(1)
    expect(i.interrupted).toEqual([quiet.id])
    expect(i.interrupted).not.toContain(busy.id)
    expect((await sweepAlarms(i.server.deps)).stuck).toBe(0)
    expect(i.interrupted).toHaveLength(1)
    const stuck = openAlarms(i.server.deps).filter((a) => a.kind === 'run-stuck')
    expect(stuck).toHaveLength(1)
    expect(stuck[0]?.text).toContain('Stuck report')
    expect(stuck[0]?.text).toContain('nothing is run again by itself')
    // nothing was re-executed by the alarms layer
    expect(i.retried).toEqual([])
  })

  test('the limit is the setting (stuckRunMinutes)', async () => {
    const i = instance()
    task(i, 'running', { idleMin: 20 })
    expect((await sweepAlarms(i.server.deps)).stuck).toBe(0)
    i.server.deps.settings.patch({ stuckRunMinutes: 10 }, Date.now())
    expect((await sweepAlarms(i.server.deps)).stuck).toBe(1)
  })

  test('a stuck run that ended stopped is not alarmed a second time as failed', async () => {
    const i = instance()
    const t = task(i, 'running', { idleMin: 60 })
    await sweepAlarms(i.server.deps)
    i.server.conn.sqlite
      .query("UPDATE tasks SET state = 'interrupted', ended_at = ? WHERE id = ?")
      .run(Date.now(), t.id)
    expect((await sweepAlarms(i.server.deps)).failedRuns).toBe(0)
    expect(listAlarms(i.server.deps, { all: true }).alarms).toHaveLength(1)
  })
})

describe('other sources', () => {
  test('a routine that paused itself, once per incident', () => {
    const i = instance()
    const input = {
      routineId: 'r1',
      name: 'Morning check',
      agentId: i.agentId,
      failures: 3,
      reason: 'the provider rejected the key',
      incident: 'run-9',
      link: '/routines',
    }
    expect(raiseRoutinePaused(i.server.deps, input)?.text).toContain('Next: fix the cause')
    expect(raiseRoutinePaused(i.server.deps, input)).toBeUndefined()
    expect(raiseRoutinePaused(i.server.deps, { ...input, incident: 'run-12' })).toBeDefined()
  })

  test('an approval nobody answered, once per approval', () => {
    const i = instance()
    const input = {
      approvalId: 'ap1',
      sessionId: 's1',
      agentId: i.agentId,
      tool: 'web_fetch',
      where: 'Ops chat',
    }
    const a = raiseApprovalExpired(i.server.deps, input)
    expect(a?.text).toContain('web_fetch')
    expect(a?.text).toContain('Ops chat')
    expect(raiseApprovalExpired(i.server.deps, input)).toBeUndefined()
  })

  test('a connection breaks, clears itself when it works again, and can break again later', async () => {
    const i = instance()
    const broken = { id: 'c1', label: 'Mail', status: 'needs-auth', message: 'token revoked' }
    const a = raiseConnectionBroken(i.server.deps, broken)
    expect(a?.text).toContain('sign in again')
    // still open: the same breakage is not a second alarm
    expect(raiseConnectionBroken(i.server.deps, broken)).toBeUndefined()
    const deps = i.server.deps as unknown as { connectors: Record<string, unknown> }
    let status = 'needs-auth'
    deps.connectors.connections = async () => [{ id: 'c1', label: 'Mail', status }]
    expect((await sweepAlarms(i.server.deps)).cleared).toBe(0)
    status = 'connected'
    expect((await sweepAlarms(i.server.deps)).cleared).toBe(1)
    const all = listAlarms(i.server.deps, { all: true }).alarms
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ ackedBy: 'auto' })
    expect(raiseConnectionBroken(i.server.deps, broken)).toBeDefined()
    expect(listAlarms(i.server.deps, { all: true }).alarms).toHaveLength(2)
  })

  test('a failed server step is logged and alarmed once a day per step', () => {
    const i = instance()
    const warn = console.warn
    const lines: string[] = []
    console.warn = (m: string) => void lines.push(String(m))
    try {
      const a = raiseSystemAlarm(i.server.deps, 'reconcile', new Error('disk full'))
      expect(a?.kind).toBe('system')
      expect(a?.text).toContain('disk full')
      expect(raiseSystemAlarm(i.server.deps, 'reconcile', new Error('disk full'))).toBeUndefined()
      expect(raiseSystemAlarm(i.server.deps, 'health-scan', new Error('x'))).toBeDefined()
    } finally {
      console.warn = warn
    }
    expect(lines.some((l) => l.includes('reconcile failed: disk full'))).toBe(true)
  })
})

describe('ack and auto-clear', () => {
  test('Ack takes it off the list and keeps the record', async () => {
    const i = instance()
    task(i, 'failed')
    await sweepAlarms(i.server.deps)
    const id = listAlarms(i.server.deps).alarms[0]?.id as string
    const res = await i.server.app.request(`/alarms/${id}/ack`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id, ackedBy: 'owner' })
    expect(listAlarms(i.server.deps).alarms).toEqual([])
    expect(listAlarms(i.server.deps, { all: true }).alarms).toHaveLength(1)
    expect((await i.server.app.request('/alarms/none/ack', { method: 'POST' })).status).toBe(404)
    const page = (await (await i.server.app.request('/alarms?all=true')).json()) as {
      alarms: unknown[]
      open: number
    }
    expect(page.open).toBe(0)
    expect(page.alarms).toHaveLength(1)
  })

  test('the next good run clears the alarm of a failed run (auto), the record stays', async () => {
    const i = instance()
    const t = task(i, 'failed')
    await sweepAlarms(i.server.deps)
    expect(listAlarms(i.server.deps).open).toBe(1)
    // the owner pressed Retry and it worked
    i.server.conn.sqlite
      .query("UPDATE tasks SET state = 'done', ended_at = ? WHERE id = ?")
      .run(Date.now(), t.id)
    const report = await sweepAlarms(i.server.deps)
    expect(report.cleared).toBe(1)
    expect(listAlarms(i.server.deps).open).toBe(0)
    const kept = listAlarms(i.server.deps, { all: true }).alarms
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatchObject({ ackedBy: 'auto' })
  })

  test('acknowledging removes the bell entry of an alarm that fell back to it', async () => {
    const i = instance()
    i.answer.value = 'unavailable'
    task(i, 'failed')
    await sweepAlarms(i.server.deps)
    expect(i.server.deps.notifications.countOpen()).toBe(1)
    ackAlarm(i.server.deps, listAlarms(i.server.deps).alarms[0]?.id as string)
    expect(i.server.deps.notifications.countOpen()).toBe(0)
  })
})

describe('delivery', () => {
  test('rate limit: a second alarm of the same subject waits, then goes out as one batch', async () => {
    const i = instance()
    const base = Date.now()
    const input = {
      routineId: 'r1',
      name: 'Morning check',
      agentId: i.agentId,
      failures: 3,
      reason: 'boom',
      link: '/routines',
    }
    raiseRoutinePaused(i.server.deps, { ...input, incident: 'one' })
    await settle(i)
    expect(i.pushed).toHaveLength(1)
    // a different subject is not held back
    raiseSystemAlarm(i.server.deps, 'health-scan', new Error('x'))
    await settle(i)
    expect(i.pushed).toHaveLength(2)
    // the same subject again inside ten minutes: stored, not sent
    raiseRoutinePaused(i.server.deps, { ...input, incident: 'two' })
    raiseRoutinePaused(i.server.deps, { ...input, incident: 'three' })
    await deliverAlarms(i.server.deps, base + 60_000)
    expect(i.pushed).toHaveLength(2)
    expect(i.server.deps.alarms.pending()).toHaveLength(2)
    // after the window both go out in one message
    await deliverAlarms(i.server.deps, base + ALARM_RATE_MS + 1000)
    expect(i.pushed).toHaveLength(3)
    expect(i.pushed[2]).toContain('2 things need attention')
    expect(i.server.deps.alarms.pending()).toEqual([])
  })

  test('pure: due alarms and the text', () => {
    const mk = (id: string, subject: string) => ({
      id,
      kind: 'system' as const,
      key: id,
      subject,
      agentId: null,
      text: `Text ${id}.`,
      refs: [`/x/${id}`],
      createdAt: 0,
      ackedAt: null,
      ackedBy: null,
      deliveredAt: null,
    })
    const pending = [mk('a', 's1'), mk('b', 's2')]
    const due = dueAlarms(pending, [{ subject: 's1', deliveredAt: 1000 }], 1000 + 5 * 60_000)
    expect(due.map((a) => a.id)).toEqual(['b'])
    expect(pushText(due, (r) => `https://app${r}`)).toBe('Needs attention: Text b. https://app/x/b')
    const text = pushText(pending, (r) => r)
    expect(text).toContain('2 things need attention')
    // an acknowledged alarm is never pushed
    const acked = { ...mk('c', 's3'), ackedAt: 5 }
    expect(dueAlarms([acked], [], 10)).toEqual([])
  })

  test('no chat destination (or a transport that throws): the bell, once per alarm', async () => {
    const i = instance()
    i.answer.value = 'unavailable'
    raiseSystemAlarm(i.server.deps, 'one', new Error('a'))
    await settle(i)
    i.answer.value = 'throw'
    raiseSystemAlarm(i.server.deps, 'two', new Error('b'))
    await settle(i)
    expect(i.pushed).toEqual([])
    const bell = i.server.deps.notifications.list({ open: true, limit: 10 })
    expect(bell).toHaveLength(2)
    expect(bell.every((n) => n.kind === 'alert')).toBe(true)
    // both count as delivered: they are not retried and not pushed twice
    expect(i.server.deps.alarms.pending()).toEqual([])
  })

  test('without any push configured the bell is used', async () => {
    const i = instance()
    ;(i.server.deps as unknown as Record<string, unknown>).alarmPush = undefined
    raiseSystemAlarm(i.server.deps, 'solo', new Error('c'))
    await settle(i)
    expect(i.server.deps.notifications.countOpen()).toBe(1)
  })
})

describe('the supervisor and alarms', () => {
  const now = 100 * 3_600_000
  const failed = {
    id: 't1',
    title: 'Report',
    status: 'failed',
    summary: 'Provider unavailable: HTTP 502',
    endedAt: now - 60_000,
    lastActivityAt: now - 60_000,
    sessionId: 's1',
    pendingKind: null,
  }
  const input = {
    now,
    tasks: [failed],
    parked: new Set<string>(),
    superseded: () => false,
    decisions: [],
    connections: [{ id: 'c1', label: 'Mail', status: 'error' }],
    state: EMPTY_SUPERVISOR_STATE,
    retriesToday: 0,
  }

  test('an alarmed failed run keeps its retry verdict and says the owner was told; an alarmed connection is not listed again', () => {
    const plain = superviseObservation(input)
    expect(plain.map((x) => x.kind)).toEqual(['run-failed', 'connection-broken'])
    const alarmed = superviseObservation({
      ...input,
      alarmed: { tasks: new Set(['t1']), connections: new Set(['c1']) },
    })
    expect(alarmed.map((x) => x.kind)).toEqual(['run-failed'])
    expect(alarmed[0]?.alarmed).toBe(true)
    expect(alarmed[0]?.retry).toBeDefined()
    expect(alarmed[0]?.fingerprint).toBe(plain[0]?.fingerprint as string)
  })

  test('a stuck run that has an alarm is not listed as stuck', () => {
    const running = {
      ...failed,
      status: 'running',
      endedAt: null,
      lastActivityAt: now - 3 * 3_600_000,
    }
    const base = { ...input, tasks: [running], connections: [] }
    expect(superviseObservation(base).map((x) => x.kind)).toEqual(['run-stuck'])
    expect(
      superviseObservation({
        ...base,
        alarmed: { tasks: new Set(['t1']), connections: new Set() },
      }),
    ).toEqual([])
  })
})
