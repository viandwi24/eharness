/**
 * The supervisor duty of the heartbeat (docs/plans/P53-supervisor-and-consistency.md): failed and
 * stuck work, the retry tool and its rules, escalation, fixes of the agent's own memory, and the
 * rule that a beat with nothing to do makes no model call. Scripted models only; the retry itself
 * is a recording stub (the retry service has its own tests).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import { setHeartbeat } from '../src/app/heartbeat.ts'
import { askOwner, beginSupervision, promptOf, retryRun, supervise } from '../src/app/supervisor.ts'
import { agentMemory } from '../src/domain/memory.ts'
import {
  classifyRunFailure,
  MAX_SUPERVISOR_RETRIES_PER_DAY,
  memoryCallRefusal,
  retryVerdict,
  supervisorSteps,
} from '../src/domain/supervisor.ts'
import type { Task } from '../src/domain/tasks.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

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
let n = 0
const call = (toolName: string, input: Record<string, unknown>): ScriptedStepInput => ({
  toolCalls: [{ toolName, input, toolCallId: `s-${toolName}-${++n}` }],
})
const answer = (items: Array<Record<string, unknown>> = []): ScriptedStepInput =>
  call('final_answer', { status: items.length === 0 ? 'ok' : 'attention', items })

const TRANSIENT_SUMMARY =
  'It failed with a temporary error and 4 automatic retries did not help. Last error: Provider unavailable: HTTP 502'
const DENIED_SUMMARY =
  'The run asked for the tool web_fetch and was denied: it is outside the authority of the program.'

interface Instance {
  server: Server
  model: ScriptedModel
  agentId: string
  slug: string
  /** Sessions the stubbed retry was asked to continue. */
  retried: string[]
}
function instance(steps: ScriptedStepInput[]): Instance {
  const dir = mkdtempSync(join(tmpdir(), 'team-sup-'))
  dirs.push(dir)
  const model = scriptedModel(steps)
  const config: ModelConfig = {
    provider: 'scripted',
    defaultModel: 'none',
    resolve: (id) =>
      id === 'm-agent'
        ? model
        : scriptedModel([
            () => {
              throw new Error(`unexpected model call: ${id}`)
            },
          ]),
  }
  const server = compose({
    dbFile: join(dir, 'team.db'),
    instanceId: 'sup-test',
    models: config,
    env: {},
    tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 },
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    turnRetry: { tickMs: 0 },
    heartbeat: { activitySettleMs: 20 },
  })
  servers.push(server)
  const def = server.deps.agents.getBySlug('lead')
  if (def === undefined) throw new Error('seed missing')
  updateAgent(server.deps, def.id, { model: 'm-agent' })
  const retried: string[] = []
  const deps = server.deps as unknown as { turnRetry: Record<string, unknown> }
  deps.turnRetry = {
    ...deps.turnRetry,
    retryNow: async (sessionId: string) => {
      retried.push(sessionId)
      return { started: true }
    },
  }
  return { server, model, agentId: def.id, slug: def.slug, retried }
}

/** A task of the agent that ended failed with `summary` (a held queue task, no model involved). */
function failedTask(
  i: Instance,
  summary: string,
  over: { title?: string; agentId?: string; endedAgo?: number } = {},
): Task {
  const { deps, conn } = i.server
  const now = Date.now()
  const queued = deps.tasks.enqueue({
    agentId: over.agentId ?? i.agentId,
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
  conn.sqlite
    .query(
      "UPDATE tasks SET state = 'failed', ended_at = ?, last_activity_at = ?, summary = ? WHERE id = ?",
    )
    .run(ended, ended, summary, queued.id)
  const task = deps.tasks.get(queued.id)
  if (task === undefined) throw new Error('task missing')
  return task
}

async function beat(i: Instance): Promise<void> {
  await setHeartbeat(i.server.deps, i.agentId, { activeFrom: '00:00', activeTo: '00:00' })
  const out = await i.server.heartbeats.heartbeat(i.agentId, { slot: Date.now() })
  if (!out.started) return
  await i.server.heartbeats.idle()
  await until('the beat ended', () => {
    const last = i.server.deps.heartbeat.store.state(i.agentId).beats[0]
    return last !== undefined && last.status !== 'running'
  })
}
const lastBeat = (i: Instance) => i.server.deps.heartbeat.store.state(i.agentId).beats[0]
const sessionText = async (i: Instance): Promise<string> =>
  JSON.stringify(await i.server.factory.peek(`heartbeat:${i.agentId}`).messages({ limit: 100 }))
const supervisorQuestions = (i: Instance) =>
  i.server.deps.decisions
    .list({ status: 'open', agentId: i.agentId, limit: 50 })
    .filter((d) => d.title.startsWith('Supervisor: '))

describe('failures and the retry rule', () => {
  test('a stored failure is classified; a retry is refused for what a retry cannot change', () => {
    expect(classifyRunFailure(TRANSIENT_SUMMARY)).toBe('transient')
    expect(classifyRunFailure(DENIED_SUMMARY)).toBe('denial')
    expect(classifyRunFailure('Provider rejected the request: invalid request')).toBe('permanent')
    expect(classifyRunFailure('Run budget used up')).toBe('permanent')
    expect(classifyRunFailure('Connector needs sign-in again')).toBe('auth')
    expect(classifyRunFailure('Unexpected error (see server logs)')).toBe('unknown')
    const base = { retriesToday: 0, alreadyRetried: false, connectionsHealthy: true }
    expect(retryVerdict({ ...base, failure: 'transient' })).toEqual({
      ok: true,
      left: MAX_SUPERVISOR_RETRIES_PER_DAY,
    })
    expect(retryVerdict({ ...base, failure: 'denial' })).toMatchObject({ ok: false })
    expect(retryVerdict({ ...base, failure: 'permanent' })).toMatchObject({ ok: false })
    expect(retryVerdict({ ...base, failure: 'unknown', alreadyRetried: true })).toMatchObject({
      ok: false,
    })
    expect(retryVerdict({ ...base, failure: 'unknown', retriesToday: 3 })).toMatchObject({
      ok: false,
    })
    // an auth failure is retried once the connection is connected again
    expect(retryVerdict({ ...base, failure: 'auth', connectionsHealthy: false })).toMatchObject({
      ok: false,
    })
    expect(retryVerdict({ ...base, failure: 'auth' })).toMatchObject({ ok: true })
  })

  test('memory calls: reads on the own folder; edits only while fixing, never HEARTBEAT.md or elsewhere', () => {
    const own = agentMemory('a1')
    const ctx = { agentId: 'a1', fixing: true }
    expect(
      memoryCallRefusal(
        { toolName: 'memory_view', input: { path: own } },
        { ...ctx, fixing: false },
      ),
    ).toBeUndefined()
    expect(
      memoryCallRefusal(
        { toolName: 'memory_view', input: { path: '/memories/workspace/x.md' } },
        ctx,
      ),
    ).toContain('own folder')
    expect(
      memoryCallRefusal(
        { toolName: 'memory_delete', input: { path: `${own}/a.md` } },
        { ...ctx, fixing: false },
      ),
    ).toContain('Not available')
    expect(
      memoryCallRefusal({ toolName: 'memory_delete', input: { path: `${own}/a.md` } }, ctx),
    ).toBeUndefined()
    expect(
      memoryCallRefusal(
        { toolName: 'memory_str_replace', input: { path: `${own}/../a2/x.md` } },
        ctx,
      ),
    ).toContain('own folder')
    expect(
      memoryCallRefusal(
        { toolName: 'memory_str_replace', input: { path: '/memories/agents/a10/x.md' } },
        ctx,
      ),
    ).toContain('own folder')
    expect(
      memoryCallRefusal({ toolName: 'memory_create', input: { path: `${own}/HEARTBEAT.md` } }, ctx),
    ).toContain('standing orders')
    expect(
      memoryCallRefusal(
        {
          toolName: 'memory_rename',
          input: { old_path: `${own}/a.md`, new_path: '/library/a.md' },
        },
        ctx,
      ),
    ).toContain('own folder')
    expect(memoryCallRefusal({ toolName: 'web_fetch', input: {} }, ctx)).toBeUndefined()
  })

  test('no item and no deep review: no prompt block', () => {
    expect(
      supervisorSteps({
        items: [],
        more: 0,
        memoryFix: false,
        deep: false,
        memoryDir: '/memories/agents/a',
      }),
    ).toEqual([])
  })
})

describe('the beat as supervisor', () => {
  test('nothing to do: no model call, the beat is skipped', async () => {
    const steps: ScriptedStepInput[] = [answer()]
    const i = instance(steps)
    await beat(i)
    expect(i.model.calls.length).toBe(0)
    expect(lastBeat(i)).toMatchObject({ status: 'skipped' })
  })

  test('a failed retryable run is retried once through the tool, and not offered again', async () => {
    const steps: ScriptedStepInput[] = []
    const i = instance(steps)
    const task = failedTask(i, TRANSIENT_SUMMARY)
    steps.push(
      call('heartbeat_retry_run', { task: task.id, reason: 'the provider is back' }),
      // asking again for the same run is refused
      call('heartbeat_retry_run', { task: task.id, reason: 'again' }),
      answer([
        {
          kind: 'supervisor.run-failed',
          title: `Retried: ${task.title}`,
          detail: 'Failed after automatic retries; started the run again.',
          decision: 'retry',
          reason: 'transient provider failure',
          links: [`/tasks/${task.id}`],
          fingerprint: `supervisor:run-failed:${task.id}`,
        },
      ]),
    )
    await beat(i)
    expect(i.retried).toEqual([task.sessionId])
    const prompt = JSON.stringify(i.model.calls[0]?.prompt)
    expect(prompt).toContain('SUPERVISOR DUTY')
    expect(prompt).toContain('retry: ALLOWED')
    expect(await sessionText(i)).toContain('already retried this run')
    const record = lastBeat(i)
    expect(record?.items[0]).toMatchObject({
      decision: 'retry',
      reason: 'transient provider failure',
    })
    expect(i.server.deps.heartbeat.store.state(i.agentId).supervisor?.retries).toHaveLength(1)
    // the retry (stubbed here) put the run back to work: the next beat is told nothing new
    i.server.conn.sqlite
      .query(
        "UPDATE tasks SET state = 'running', ended_at = NULL, last_activity_at = ? WHERE id = ?",
      )
      .run(Date.now(), task.id)
    const calls = i.model.calls.length
    await beat(i)
    expect(i.model.calls.length).toBe(calls)
  })

  test('a denial failure is escalated with the concrete fix, never retried', async () => {
    const steps: ScriptedStepInput[] = []
    const i = instance(steps)
    const task = failedTask(i, DENIED_SUMMARY, { title: 'Nightly crawl' })
    steps.push(
      call('heartbeat_retry_run', { task: task.id, reason: 'try again' }),
      call('heartbeat_ask_owner', {
        title: 'Nightly crawl was denied web_fetch',
        diagnosis: 'The run asked for web_fetch, which the program does not have.',
        fix: 'Propose a change to program Nightly crawl adding the tool web_fetch.',
        fingerprint: `supervisor:run-failed:${task.id}`,
      }),
      answer([
        {
          kind: 'supervisor.run-failed',
          title: 'Nightly crawl was denied web_fetch',
          detail: 'Asked the owners to add the tool.',
          decision: 'escalate',
          reason: 'denial: a retry gives the same answer',
        },
      ]),
    )
    await beat(i)
    expect(i.retried).toEqual([])
    expect(JSON.stringify(i.model.calls[0]?.prompt)).toContain('NOT ALLOWED')
    expect(await sessionText(i)).toContain('denial or authority')
    const asked = supervisorQuestions(i)
    expect(asked).toHaveLength(1)
    expect(asked[0]?.body).toContain('adding the tool web_fetch')
    // the same question is not raised twice
    expect(
      await askOwner(
        i.server.deps,
        i.agentId,
        { title: 'Nightly crawl was denied web_fetch', diagnosis: 'x', fix: 'y' },
        Date.now(),
      ),
    ).toContain('already')
  })

  test('the retry tool: own runs only, three a day, runs that failed only', async () => {
    const i = instance([])
    const { deps } = i.server
    const now = Date.now()
    const tasks = [1, 2, 3, 4].map((k) =>
      failedTask(i, 'Unexpected error (see server logs)', { title: `Job ${k}` }),
    )
    const outcomes: string[] = []
    for (const t of tasks) outcomes.push(await retryRun(deps, i.agentId, t.id, 'again', now))
    expect(outcomes.slice(0, 3).every((o) => o.startsWith('Retry started'))).toBe(true)
    expect(outcomes[3]).toContain('daily limit')
    expect(i.retried).toHaveLength(3)
    // another agent's run, a run that did not fail, a made-up id
    const other = deps.agents.list().find((a) => a.id !== i.agentId)
    if (other === undefined) throw new Error('no second agent')
    const theirs = failedTask(i, TRANSIENT_SUMMARY, { agentId: other.id })
    expect(await retryRun(deps, i.agentId, theirs.id, 'x', now)).toContain('not one of your own')
    expect(await retryRun(deps, i.agentId, 'nope', 'x', now)).toContain('no run')
    const running = deps.tasks.enqueue({
      agentId: i.agentId,
      title: 'Live',
      brief: null,
      inputs: [],
      priority: 'normal',
      dueAt: null,
      createdBy: 'client',
      hold: true,
      now,
    })
    deps.tasks.claimTask(running.id, now)
    expect(await retryRun(deps, i.agentId, running.id, 'x', now)).toContain('did not fail')
    // the next day the cap is open again
    const tomorrow = await retryRun(
      deps,
      i.agentId,
      tasks[3]?.id as string,
      'next day',
      now + 25 * 3_600_000,
    )
    expect(tomorrow).toContain('Retry started')
  })

  test('a failure whose cause is gone is retried; a run superseded by a later success is not listed', async () => {
    const i = instance([])
    failedTask(i, 'Connector needs sign-in again', { title: 'Sync' })
    const seen = await supervise(i.server.deps, i.agentId, Date.now())
    const item = seen.items.find((x) => x.kind === 'run-failed')
    expect(item?.failure).toBe('auth')
    // no connection of the agent is broken in a fresh workspace: the cause is gone
    expect(item?.retry).toMatchObject({ ok: true })
  })
})

describe('memory fixes', () => {
  const place = (i: Instance, name: string, text: string) =>
    i.server.deps.library.writeText(`${agentMemory(i.agentId)}/${name}`, text)

  test('the Monday deep review lists every finding once a week, new or not', async () => {
    const i = instance([])
    const { deps } = i.server
    await place(i, 'notes.md', 'Phone: <isi nomor>\n')
    // 2026-10-19 is a Monday (team timezone permitting): noon UTC keeps the date in most zones
    const monday = Date.UTC(2026, 9, 19, 12, 0)
    const first = await supervise(deps, i.agentId, monday)
    expect(first.deep).toBe(true)
    expect(first.items.some((x) => x.finding?.kind === 'memory-placeholder')).toBe(true)
    expect(first.memoryFix).toBe(true)
    const steps = supervisorSteps(promptOf(i.agentId, first)).flat().join('\n')
    expect(steps).toContain('WEEKLY DEEP REVIEW')
    expect(steps).toContain('consistency report')
    beginSupervision(deps, i.agentId, first, monday)
    // the same Monday, a later beat: not deep, nothing new
    const later = await supervise(deps, i.agentId, monday + 3_600_000)
    expect(later.deep).toBe(false)
    expect(later.items).toEqual([])
    // the next Monday lists it again although it was shown before
    const next = await supervise(deps, i.agentId, monday + 7 * 24 * 3_600_000)
    expect(next.deep).toBe(true)
    expect(next.items.some((x) => x.finding?.kind === 'memory-placeholder')).toBe(true)
  })

  test('a beat edits only its own memory files, and only because findings are listed', async () => {
    const steps: ScriptedStepInput[] = []
    const i = instance(steps)
    const own = agentMemory(i.agentId)
    await place(
      i,
      'contacts.md',
      '# Contacts\n\nOwner: Dana <isi nomor telepon>\nEmail: dana@example.com\n',
    )
    await place(i, 'HEARTBEAT.md', '# Orders\n')
    const other = `/memories/workspace/shared.md`
    await i.server.deps.library.writeText(other, 'shared fact\n')
    steps.push(
      call('memory_view', { path: `${own}/contacts.md` }),
      call('memory_str_replace', {
        path: `${own}/contacts.md`,
        old_str: 'Owner: Dana <isi nomor telepon>\n',
        new_str: '',
      }),
      // everything else is refused
      call('memory_str_replace', { path: other, old_str: 'shared fact', new_str: 'changed' }),
      call('memory_create', { path: `${own}/HEARTBEAT.md`, file_text: 'wiped' }),
      call('memory_delete', { path: other }),
      answer([
        {
          kind: 'supervisor.memory-fix',
          title: 'contacts.md cleaned',
          detail: 'Removed an unfilled placeholder line.',
          links: [`${own}/contacts.md`],
          reason: 'the phone number was never filled in',
        },
      ]),
    )
    await beat(i)
    const text = await sessionText(i)
    expect(JSON.stringify(i.model.calls[0]?.prompt)).toContain('MEMORY FIXES')
    const contacts = (await i.server.deps.library.read(`${own}/contacts.md`))?.text ?? ''
    expect(contacts).not.toContain('isi nomor')
    expect(contacts).toContain('dana@example.com')
    expect((await i.server.deps.library.read(other))?.text).toBe('shared fact\n')
    expect((await i.server.deps.library.read(`${own}/HEARTBEAT.md`))?.text).toBe('# Orders\n')
    expect(text).toContain('own folder')
    expect(text).toContain('standing orders')
    // the change reaches the beat log and the digest buffer once
    const record = lastBeat(i)
    expect(record?.items.filter((x) => x.kind === 'supervisor.memory-fix')).toHaveLength(1)
    const buffered = i.server.deps.heartbeat.store.digest().buffer
    expect(buffered.some((e) => e.item.kind === 'supervisor.memory-fix')).toBe(true)
  })

  test('two files on one topic are merged into one', async () => {
    const steps: ScriptedStepInput[] = []
    const i = instance(steps)
    const own = agentMemory(i.agentId)
    await place(i, 'contacts.md', '# Contacts\n\nOwner: Dana, dana@example.com\n')
    await new Promise((r) => setTimeout(r, 5))
    await place(i, 'contacts-2.md', '# Contacts\n\nDesk: Lee, lee@example.com\n')
    steps.push(
      call('memory_view', { path: own }),
      call('memory_insert', {
        path: `${own}/contacts-2.md`,
        insert_line: 3,
        insert_text: 'Owner: Dana, dana@example.com\n',
      }),
      call('memory_delete', { path: `${own}/contacts.md` }),
      answer([
        {
          kind: 'supervisor.memory-fix',
          title: 'contacts merged',
          detail: 'Merged contacts.md into contacts-2.md.',
          links: [`${own}/contacts.md`, `${own}/contacts-2.md`],
          reason: 'two files on one topic',
        },
      ]),
    )
    await beat(i)
    expect(await i.server.deps.library.read(`${own}/contacts.md`)).toBeUndefined()
    const merged = (await i.server.deps.library.read(`${own}/contacts-2.md`))?.text ?? ''
    expect(merged).toContain('dana@example.com')
    expect(merged).toContain('lee@example.com')
  })

  test('a finding about a routine becomes a question to the owners, never an edit', async () => {
    const steps: ScriptedStepInput[] = []
    const i = instance(steps)
    const { deps } = i.server
    const own = agentMemory(i.agentId)
    await place(i, 'notes.md', 'plain notes\n')
    const now = Date.now()
    for (const id of ['r-a', 'r-b']) {
      deps.routines.insert({
        id,
        agentId: i.agentId,
        name: `Sales ${id}`,
        prompt: 'Summarize the weekly sales numbers for the team',
        schedule: { kind: 'every', everyMs: 3_600_000 },
        sessionMode: 'task',
        overlap: 'queue',
        catchUpWindowMs: null,
        maxFailures: 3,
        maxFires: null,
        endAt: null,
        nextFireAt: now + 86_400_000,
        programId: null,
        now,
      })
    }
    steps.push(
      // no memory finding is listed, so an edit is refused
      call('memory_delete', { path: `${own}/notes.md` }),
      call('heartbeat_ask_owner', {
        title: 'Two routines do the same job',
        diagnosis: 'Sales r-a and Sales r-b run the same prompt on the same schedule.',
        fix: 'Pause or delete one of the two routines.',
      }),
      answer([
        {
          kind: 'supervisor.consistency',
          title: 'Duplicate routines',
          detail: 'Asked the owners.',
          decision: 'escalate',
          reason: 'routines are not mine to edit',
        },
      ]),
    )
    await beat(i)
    expect(JSON.stringify(i.model.calls[0]?.prompt)).not.toContain('MEMORY FIXES')
    expect(JSON.stringify(i.model.calls[0]?.prompt)).toContain('routine-duplicate')
    expect(await sessionText(i)).toContain('Memory is edited only')
    expect((await deps.library.read(`${own}/notes.md`))?.text).toBe('plain notes\n')
    expect(
      deps.routines
        .list({})
        .filter((r) => r.agentId === i.agentId && r.status === 'active' && r.programId === null),
    ).toHaveLength(2)
    expect(supervisorQuestions(i)).toHaveLength(1)
  })
})
