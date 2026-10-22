/**
 * Fills the history features of a workspace for the backup tests: decisions, the work queue and
 * finished tasks, alarms, the bell, persona proposals, program tests and rehearsals, key-value
 * settings and conversations. Real app functions wherever the app has one; the few tables no code
 * writes any more (`chats`, `rehearsals`, `program_tests`) and the message log (a scripted model
 * cannot be reached from here) go through stores or SQL. Run it after `populateBase`.
 */
import type { UIMessage } from 'ai'
import { ackAlarm, raiseAlarm } from '../../src/app/alarms.ts'
import { dismissNotification, postDigest, postNotice } from '../../src/app/briefings.ts'
import { setChatTools } from '../../src/app/chat.ts'
import { createEscalation, createProposal } from '../../src/app/decisions.ts'
import { dismissFinding } from '../../src/app/health.ts'
import { setMode } from '../../src/app/modes.ts'
import { applyProposal, proposePersona, rejectProposal, WEB_ACTOR } from '../../src/app/persona.ts'
import { createThread } from '../../src/app/threads.ts'
import { createTask } from '../../src/app/work-queue.ts'
import type { TeamMode } from '../../src/domain/modes.ts'
import type { SqliteTaskStore } from '../../src/infra/db/tasks-repo.ts'
import { sqliteMessages, sqliteState } from '../../src/infra/eh/storage.ts'
import type { Server } from '../../src/main.ts'
import type { BaseWorld } from './backup-world.ts'

export interface HistoryWorld {
  /** Decisions: an open proposal, an open escalation, a rejected proposal, an approved escalation. */
  openProposalId: string
  openEscalationId: string
  rejectedProposalId: string
  approvedEscalationId: string
  /** Tasks: a done program run, a failed routine run, a queued work item. */
  doneTaskId: string
  failedTaskId: string
  queuedTaskId: string
  doneSessionId: string
  alarmIds: string[]
  notificationIds: string[]
  /** Persona proposals of the analyst. */
  pendingPersonaProposalId: string
  appliedPersonaProposalId: string
  rejectedPersonaProposalId: string
  programTestIds: string[]
  rehearsalIds: string[]
  /** The second chat thread of the analyst (with a title). */
  secondThreadId: string
  secondThreadSessionId: string
  /** Sessions that hold messages. */
  leadSessionId: string
  analystSessionId: string
  healthFingerprint: string
  /** Keys written to `settings` (key-value rows). */
  settingKeys: string[]
}

const DAY = 24 * 3_600_000

const textMessage = (
  id: string,
  role: 'user' | 'assistant',
  text: string,
  metadata?: unknown,
): UIMessage => ({
  id,
  role,
  parts: [{ type: 'text', text }],
  ...(metadata === undefined ? {} : { metadata }),
})

export async function populateHistory(server: Server, world: BaseWorld): Promise<HistoryWorld> {
  const deps = server.deps
  const sqlite = server.conn.sqlite
  const now = Date.now()
  const { analystId, leadId, programId, routineId, connectionId } = world

  // --- persona proposals: pending, applied, rejected -------------------------------------------
  const pending = proposePersona(
    deps,
    analystId,
    { voice: 'Calm, exact and a little warmer.', reason: 'The owner asked for a warmer tone.' },
    { kind: 'chat', name: 'Forecaster' },
  ).proposal
  const owner = { ...WEB_ACTOR }
  // the applied one: a fresh proposal against the current version
  const toApply = proposePersona(
    deps,
    analystId,
    { identity: { about: 'The numbers person (updated)' }, reason: 'Keep the about line current.' },
    { kind: 'chat', name: 'Dewi Example', role: 'admin', ref: world.personId },
  ).proposal
  applyProposal(deps, toApply.id, owner)
  // the version moved: the first one is now stale on apply, so reject it instead
  const stillPending = proposePersona(
    deps,
    analystId,
    { voice: 'Formal. Short sentences. No jokes.', reason: 'Reports go to a board.' },
    { kind: 'chat', name: 'Forecaster' },
  ).proposal
  rejectProposal(deps, pending.id, owner)

  // --- decisions -----------------------------------------------------------------------------
  const proposal = (title: string, name: string, brief: string) =>
    createProposal(deps, {
      agentId: analystId,
      sessionId: `dm:${analystId}`,
      title,
      body: `Plan for ${name}: ${brief}`,
      program: {
        name,
        brief,
        authority: { tools: ['Read'], read: ['/library/'], write: ['/library/reports/'] },
        budget: { perRunUsd: 0.5, perDayUsd: 2 },
      },
      runOnce: false,
    })
  const openProposal = proposal(
    'Monthly forecast',
    'Monthly forecast',
    'Forecast revenue each month.',
  )
  const rejectedProposal = proposal('Daily ticker', 'Daily ticker', 'Post a ticker, ünïcode ✓.')
  const openEscalation = createEscalation(deps, {
    agentId: analystId,
    sessionId: `program:${programId}:${now - 2 * DAY}`,
    waitId: null,
    title: 'Which source wins?',
    question: 'Two sources disagree on Q1 revenue.',
    details: 'Source A says 120k, source B says 118k.',
    options: ['Use source A', 'Use source B', 'Keep waiting'],
    standDown: ['Keep waiting'],
  })
  const approvedEscalation = createEscalation(deps, {
    agentId: leadId,
    sessionId: `dm:${leadId}`,
    waitId: null,
    title: 'Send the weekly mail?',
    question: 'Should the weekly mail go out today?',
    options: ['Yes', 'No'],
  })
  // decided through the store: the app's decide path would also message the parked sessions
  deps.decisions.decide(rejectedProposal.id, {
    status: 'rejected',
    decidedBy: 'client',
    decidedAt: now - DAY,
    note: 'Not needed, thanks.',
    outcome: { decision: 'rejected' },
  })
  deps.decisions.decide(approvedEscalation.id, {
    status: 'approved',
    decidedBy: 'client',
    decidedAt: now - DAY / 2,
    note: '',
    outcome: { decision: 'Yes', effect: 'Mail queued for today' },
  })

  // --- tasks (finished ones through the task store, a queued one through the work queue) ------
  const store = deps.tasks as SqliteTaskStore
  const doneSessionId = `program:${programId}:${now - 3 * DAY}`
  store.ensure({
    agentId: analystId,
    sessionId: doneSessionId,
    parentSessionId: null,
    origin: 'program',
    title: 'Weekly report',
    startedAt: now - 3 * DAY,
  })
  store.update(doneSessionId, {
    status: 'done',
    pendingKind: null,
    now: now - 3 * DAY + 60_000,
    summary: 'Report written: revenue up, margin flat.',
    addCostUsd: 0.12,
    addTokens: 4200,
    report: {
      status: 'done',
      summary: 'Report written: revenue up, margin flat.',
      outputs: ['/library/reports/q1.md'],
      notes: 'Numbers ünï-checked',
    },
  })
  store.recordDeliverables(
    doneSessionId,
    {
      status: 'pass',
      attempts: 1,
      checkedAt: now - 3 * DAY + 61_000,
      checks: [
        {
          pattern: '/library/reports/{slug}.md',
          path: '/library/reports/q1.md',
          ok: true,
          problems: [],
        },
      ],
    },
    null,
    now - 3 * DAY + 61_000,
  )
  const failedSessionId = `routine:${routineId}:${now - DAY}`
  store.ensure({
    agentId: analystId,
    sessionId: failedSessionId,
    parentSessionId: null,
    origin: 'routine',
    title: 'Morning check',
    startedAt: now - DAY,
  })
  store.update(failedSessionId, {
    status: 'failed',
    pendingKind: null,
    now: now - DAY + 5_000,
    summary: null,
  })
  const queued = createTask(deps, {
    agentId: analystId,
    title: 'Prepare the board pack',
    brief: 'Collect the three charts.\nUse the Q1 numbers (ünï).',
    inputs: ['/library/reports/q1.md', '/library/notes/ünï.txt'],
    priority: 'high',
    dueAt: now + 7 * DAY,
    hold: true,
    grants: { tools: ['Read'], read: ['/library/'], write: ['/library/reports/'] },
  })
  const doneTask = store.getBySession(doneSessionId)
  const failedTask = store.getBySession(failedSessionId)
  if (doneTask === undefined || failedTask === undefined) throw new Error('task rows missing')

  // --- alarms and the bell ---------------------------------------------------------------------
  const a1 = raiseAlarm(deps, {
    kind: 'run-failed',
    key: `run-failed:${failedSessionId}`,
    subject: `routine:${routineId}`,
    agentId: analystId,
    text: 'The routine "Morning check" failed. Open the run to see why.',
    refs: [`/tasks/${failedTask.id}`],
  })
  const a2 = raiseAlarm(deps, {
    kind: 'connection-broken',
    key: `connection-broken:${connectionId}:0`,
    subject: `connection:${connectionId}`,
    text: 'The connection "Company docs" stopped answering.',
    refs: ['/connections'],
  })
  const a3 = raiseAlarm(deps, {
    kind: 'system',
    key: 'system:history-test:2026-01-01',
    subject: 'system:history-test',
    text: 'A server step failed.',
  })
  if (a1 === undefined || a2 === undefined || a3 === undefined) throw new Error('alarms not stored')
  ackAlarm(deps, a3.id)

  postDigest(deps, {
    day: '2026-01-01',
    body: '# Daily digest\n- Weekly report done\n- One decision open ✓',
    at: now - 2 * DAY,
  })
  postDigest(deps, { day: '2026-01-02', body: 'Quiet day.', at: now - DAY })
  postNotice(deps, {
    key: 'notice:history-1',
    title: 'Margin looks flat',
    body: 'The forecaster noticed a flat margin.',
    link: `/tasks/${doneTask.id}`,
    agentId: analystId,
    at: now - DAY,
  })
  postNotice(deps, {
    key: 'notice:history-2',
    title: 'Plain notice',
    body: 'No link, no agent.',
    link: null,
    agentId: null,
    at: now - 3_600_000,
  })
  const notes = deps.notifications.list({ open: true, limit: 50 })
  const firstNote = notes[0]
  if (firstNote !== undefined) dismissNotification(deps, firstNote.id)
  const notificationIds = deps.notifications.list({ open: false, limit: 50 }).map((n) => n.id)

  // --- program tests and rehearsals (legacy tables: nothing in the app writes them any more) ---
  const sampleOf = (n: number) => ({ topic: `case ${n}`, notes: 'ünïcode ✓' })
  const testIds = [crypto.randomUUID(), crypto.randomUUID()]
  const insertTest = sqlite.query(
    'INSERT INTO program_tests (id, program_id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  insertTest.run(
    testIds[0] as string,
    programId,
    'Happy path',
    JSON.stringify({
      sample: sampleOf(1),
      expect: 'A report with a revenue line',
      lastResult: { verdict: 'pass', summary: 'Wrote /library/reports/q1.md', at: now - DAY },
    }),
    now - 4 * DAY,
    now - DAY,
  )
  insertTest.run(
    testIds[1] as string,
    programId,
    'Empty input',
    JSON.stringify({ sample: sampleOf(2), expect: null, lastResult: null }),
    now - 3 * DAY,
    now - 3 * DAY,
  )
  const rehearsalIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
  const insertRehearsal = sqlite.query(
    'INSERT INTO rehearsals (id, program_id, session_id, test_id, status, started_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  insertRehearsal.run(
    rehearsalIds[0] as string,
    programId,
    `rehearsal:${programId}:1`,
    testIds[0] as string,
    'done',
    now - DAY,
    JSON.stringify({ summary: 'Wrote the report', steps: 3, outputs: ['/library/reports/q1.md'] }),
  )
  insertRehearsal.run(
    rehearsalIds[1] as string,
    programId,
    `rehearsal:${programId}:2`,
    null,
    'failed',
    now - 2 * DAY,
    JSON.stringify({ error: 'model unavailable', steps: 0, outputs: [] }),
  )
  insertRehearsal.run(
    rehearsalIds[2] as string,
    programId,
    `rehearsal:${programId}:3`,
    testIds[1] as string,
    'running',
    now - 3_600_000,
    JSON.stringify({ steps: 1 }),
  )

  // --- key-value settings ----------------------------------------------------------------------
  const settingKeys: string[] = []
  deps.heartbeat.store.updateState(
    analystId,
    (s) => ({
      ...s,
      fingerprints: { 'margin-flat': now - DAY, 'ünï-finding': now - 3_600_000 },
      beats: [
        {
          id: `beat:${analystId}:1`,
          at: now - DAY,
          endedAt: now - DAY + 3_000,
          status: 'attention',
          reason: null,
          count: 1,
          items: [
            {
              kind: 'finding',
              title: 'Margin is flat',
              detail: 'Margin did not move in two weeks.',
              links: [`/tasks/${doneTask.id}`],
              urgent: false,
              fingerprint: 'margin-flat',
            },
          ],
          duplicates: 0,
        } as never,
      ],
    }),
    now,
  )
  settingKeys.push(`heartbeat:${analystId}:state`)
  deps.heartbeat.store.updateDigest(
    (s) => ({
      ...s,
      lastSentAt: now - DAY,
      lastSentOn: '2026-01-02',
      buffer: [
        {
          at: now - 3_600_000,
          agentId: analystId,
          item: {
            kind: 'finding',
            title: 'Buffered finding',
            detail: 'Waits for the next digest.',
            links: [],
            urgent: false,
            fingerprint: 'buffered-1',
          },
        },
      ],
    }),
    now,
  )
  settingKeys.push('digest:state')
  deps.programMemory.remember({
    id: crypto.randomUUID(),
    programId,
    subject: 'q1-revenue-source',
    question: 'Two sources disagree on Q1 revenue.',
    choice: 'Use source A',
    note: 'Source A is the audited one.',
    decisionId: openEscalation.id,
    decidedAt: now - DAY,
    expiresAt: now + 6 * DAY,
  })
  settingKeys.push(`program-memory:${programId}`)
  const healthFingerprint = 'finding:history-test:ünï'
  dismissFinding(deps, healthFingerprint)
  settingKeys.push(`health:dismissed:${healthFingerprint}`)

  // --- conversations ---------------------------------------------------------------------------
  const secondThread = createThread(deps, analystId, { title: 'Budget talk ✓' })
  // the pick of a mode and the connections switched off for one chat
  setMode(deps, analystId, 'manual', secondThread.id)
  for (const mode of ['bypass', 'auto', 'manual'] as TeamMode[]) {
    try {
      setMode(deps, leadId, mode)
      break
    } catch {
      // the lead's ceiling does not allow it: try the next one
    }
  }
  await setChatTools(deps, analystId, [connectionId], secondThread.id)

  const messages = sqliteMessages(sqlite)
  const states = sqliteState(sqlite)
  const leadSessionId = `dm:${leadId}`
  const analystSessionId = `dm:${analystId}`
  const save = async (sessionId: string, texts: Array<['user' | 'assistant', string]>) => {
    await messages.save(
      sessionId,
      texts.map(([role, text]) =>
        textMessage(
          deps.ids.next(),
          role,
          text,
          role === 'assistant' ? { eharness: { stop: 'end' } } : undefined,
        ),
      ),
    )
    await states.set(sessionId, {
      v: 1,
      rev: 1,
      core: { usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 } as never },
      plugins: {},
    })
  }
  await save(leadSessionId, [
    ['user', 'Hello! What is on the board today?'],
    ['assistant', 'Two things: the weekly report is done and one decision is open.'],
  ])
  await save(analystSessionId, [
    ['user', 'Please look at Q1 — Dewi says margins are flat.'],
    ['assistant', 'Checked: revenue is up, margin is flat. Report in /library/reports/q1.md.'],
    ['user', 'Thanks, ünï ✓'],
  ])
  await save(secondThread.sessionId, [
    ['user', 'Can we talk about the budget?'],
    ['assistant', 'Sure. The per-day limit is 4 USD.'],
  ])

  // the sidebar rows (`chats`): no app code writes them any more
  const insertChat = sqlite.query(
    `INSERT INTO chats (agent_id, session_id, last_message_at, last_preview, unread, last_read_message_id, last_read_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (agent_id) DO UPDATE SET session_id = excluded.session_id`,
  )
  insertChat.run(
    leadId,
    leadSessionId,
    now - 3_600_000,
    'Two things: the weekly report is done',
    1,
    null,
    3,
  )
  insertChat.run(analystId, analystSessionId, now - 7_200_000, 'Thanks, ünï ✓', 0, 'msg-read-1', 7)

  return {
    openProposalId: openProposal.id,
    openEscalationId: openEscalation.id,
    rejectedProposalId: rejectedProposal.id,
    approvedEscalationId: approvedEscalation.id,
    doneTaskId: doneTask.id,
    failedTaskId: failedTask.id,
    queuedTaskId: queued.id,
    doneSessionId,
    alarmIds: [a1.id, a2.id, a3.id],
    notificationIds,
    pendingPersonaProposalId: stillPending.id,
    appliedPersonaProposalId: toApply.id,
    rejectedPersonaProposalId: pending.id,
    programTestIds: testIds,
    rehearsalIds,
    secondThreadId: secondThread.id,
    secondThreadSessionId: secondThread.sessionId,
    leadSessionId,
    analystSessionId,
    healthFingerprint,
    settingKeys,
  }
}
