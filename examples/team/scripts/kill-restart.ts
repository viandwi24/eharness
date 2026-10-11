/**
 * SIGKILL scenarios on real server processes (plan P32 §8). Scripted model, one database file.
 * Run: bun examples/team/scripts/kill-restart.ts [--wait-stale]
 *
 * A turn killed mid-stream is recovered once its heartbeat is older than `recovery.staleMs`
 * (core default 120 s) and its lock lease (example default 30 s). By default the script ages the stored heartbeat and the lock lease with SQL updates to
 * keep the run short; `--wait-stale` really waits (about 2.5 minutes) and touches no state.
 */
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  answerItem,
  approvals,
  check,
  delegate,
  deleteOld,
  finish,
  freePorts,
  type Instance,
  json,
  messages,
  postAs,
  type Step,
  scenario,
  sleep,
  startInstance,
  tasks,
  until,
  userMessage,
  Workdir,
} from './lib.ts'

const [A_PORT, B_PORT] = freePorts(2) as [number, number] // ephemeral: no fixed ports
const WAIT_STALE = process.argv.includes('--wait-stale')

async function park(
  work: Workdir,
): Promise<{ b: Instance; item: { id: string; sessionId: string } }> {
  const a = await startInstance('A', A_PORT, work, [
    { toolCalls: [delegate('cleaner', 'call-1')] }, // lead
    { toolCalls: [deleteOld] }, // researcher: waits for approval
  ])
  const res = await fetch(
    `${a.url}/sessions/dm:lead/chat`,
    postAs('dm:lead', userMessage('Clean up the library')),
  )
  check(res.status === 200, `lead chat on A: ${res.status}`)
  await res.text()
  await until('approval pending', async () => (await approvals(a)).length === 1)
  await a.kill() // no graceful close
  const b = await startInstance('B', B_PORT, work, [
    { text: 'Done: handled old.md.' }, // researcher continues
    { text: 'The researcher cleaned up.' }, // lead resumes
  ])
  const list = await approvals(b)
  check(list.length === 1, `B lists ${list.length} approvals after A was killed`)
  return { b, item: list[0] as { id: string; sessionId: string } }
}

await scenario(
  'SIGKILL while a child awaits approval: B lists, answers, everything completes',
  async () => {
    const work = new Workdir()
    let b: Instance | undefined
    try {
      const parked = await park(work)
      b = parked.b
      const waiting = await tasks(b, '?status=needs_action')
      check(waiting.length === 1, `expected one needs_action task, got ${waiting.length}`)
      const answer = await answerItem(b, parked.item, { approved: true })
      check(answer.status === 200, `answer status ${answer.status}`)
      await until('lead reply stored', async () =>
        JSON.stringify(await messages(b as Instance, 'lead')).includes(
          'The researcher cleaned up.',
        ),
      )
      await until(
        'task done',
        async () => (await tasks(b as Instance, '?status=done')).length === 1,
      )
      check((await approvals(b)).length === 0, 'approval still listed on B after the answer')
      const deletes = JSON.stringify(await messages(b, 'lead')).split('delete_file').length - 1
      return `lead reply stored, task done (delete_file mentions in lead DM: ${deletes})`
    } finally {
      await b?.stop()
      work.cleanup()
    }
  },
)

function ageHeartbeats(dbFile: string): number {
  const db = new Database(dbFile)
  try {
    const r = db.run(
      "UPDATE eh_state SET state = json_set(state, '$.core.activeTurn.heartbeatAt', 0) WHERE json_extract(state, '$.core.activeTurn') IS NOT NULL",
    )
    return r.changes + db.run('UPDATE eh_locks SET until = 0').changes
  } finally {
    db.close()
  }
}

await scenario(
  'SIGKILL during a streaming turn: recovered as interrupted, session usable again',
  async () => {
    const work = new Workdir()
    let b: Instance | undefined
    try {
      const steps: Step[] = [
        {
          text: 'working on it',
          toolCalls: [{ toolName: 'write_file', input: { path: '/library/z.md', content: 'z' } }],
          delayMs: 300,
        },
      ]
      const a = await startInstance('A', A_PORT, work, steps)
      const res = await fetch(
        `${a.url}/sessions/dm:researcher/chat`,
        postAs('dm:researcher', userMessage('start')),
      )
      check(res.status === 200, `chat on A: ${res.status}`)
      void res.text().catch(() => undefined)
      await sleep(450) // mid-turn: text streamed, the tool call is still to come
      await a.kill()

      b = await startInstance('B', B_PORT, work, [{ text: 'back again' }, { text: 'late reply' }])
      const stats = await json<{ activeTurn: { owner: string } | null }>(
        await fetch(`${b.url}/agents/researcher/stats`),
      )
      let note = `activeTurn on B right after the kill: ${stats.activeTurn === null ? 'none' : 'present (remote, heartbeat fresh)'}`
      const early = await fetch(
        `${b.url}/sessions/dm:researcher/chat`,
        postAs('dm:researcher', userMessage('too early?')),
      )
      await early.text()
      note += `; immediate chat on B -> ${early.status}`
      if (WAIT_STALE) {
        await sleep(125_000)
      } else {
        const n = ageHeartbeats(work.db)
        note += `; aged ${n} heartbeat/lock row(s) by SQL instead of waiting 120 s`
      }
      const next = await fetch(
        `${b.url}/sessions/dm:researcher/chat`,
        postAs('dm:researcher', userMessage('are you there?')),
      )
      const text = await next.text()
      check(next.status === 200, `chat on B after the kill: ${next.status} ${text.slice(0, 200)}`)
      check(!text.includes('EH_SESSION_BUSY'), `B stayed busy: ${text.slice(0, 200)}`)
      check(text.includes('back again'), `the new turn did not complete: ${text.slice(0, 300)}`)

      const stored = await messages(b, 'researcher')
      const assistants = stored.filter((m) => m.role === 'assistant')
      const summary = stored
        .map(
          (m) =>
            `${m.role}:${m.metadata?.eharness?.stop ?? '-'}:${m.parts.map((p) => String(p.type) + (p.text ? `(${String(p.text).slice(0, 25)})` : '')).join('+')}`,
        )
        .join(' | ')
      note += `; transcript: ${summary}`
      const notice = stored.find((m) => m.parts.some((p) => p.type === 'data-eh.notice'))
      check(notice !== undefined, `no recovery notice (data-eh.notice) stored; ${note}`)
      const noticeData = JSON.stringify(
        notice?.parts.find((p) => p.type === 'data-eh.notice')?.data ?? '',
      ).slice(0, 160)
      const done = assistants.filter((m) => m.metadata?.eharness?.stop === 'complete')
      check(done.length >= 1, `no completed turn after recovery; ${note}`)
      const toolParts = stored
        .flatMap((m) => m.parts)
        .filter((p) => String(p.type).startsWith('tool-'))
      check(
        toolParts.length === 0,
        `a tool part of the killed turn exists (state=${String(toolParts[0]?.state)})`,
      )
      return `${note}; notice ${noticeData}`
    } finally {
      await b?.stop()
      work.cleanup()
    }
  },
)

await scenario(
  'SIGKILL mid-turn, restart with the same instance id: recovered at boot, Continue and Retry work at once',
  async () => {
    const work = new Workdir()
    let b: Instance | undefined
    try {
      const env = { TEAM_INSTANCE_ID: 'srv' }
      const steps: Step[] = [
        {
          text: 'working on it',
          toolCalls: [{ toolName: 'write_file', input: { path: '/library/z.md', content: 'z' } }],
          delayMs: 300,
        },
      ]
      const a = await startInstance('A', A_PORT, work, steps, env)
      const res = await fetch(
        `${a.url}/sessions/dm:researcher/chat`,
        postAs('dm:researcher', userMessage('start')),
      )
      check(res.status === 200, `chat on A: ${res.status}`)
      void res.text().catch(() => undefined)
      await sleep(450)
      await a.kill()
      const t0 = Date.now()
      b = await startInstance(
        'B',
        A_PORT,
        work,
        [{ text: 'continuing' }, { text: 'retried reply' }],
        env,
      )
      // no SQL ageing, no waiting for the stale timeout: the boot repair closes the turn
      await until(
        'turn recovered at boot',
        async () => {
          const stats = await json<{ activeTurn: unknown | null }>(
            await fetch(`${b?.url}/agents/researcher/stats`),
          )
          return stats.activeTurn === null
        },
        15_000,
      )
      const recoveredAfter = Date.now() - t0
      const stored = await messages(b, 'researcher')
      const interrupted = stored.find((m) => m.metadata?.eharness?.stop === 'interrupted')
      check(interrupted !== undefined, 'no message with stop=interrupted after the boot repair')
      const bad = stored
        .flatMap((m) => m.parts)
        .filter((p) => String(p.type).startsWith('tool-') && p.state === 'input-available')
      check(bad.length === 0, 'a tool part without a result remained')
      const next = await fetch(
        `${b.url}/sessions/dm:researcher/chat`,
        postAs('dm:researcher', userMessage('Continue where you left off.')),
      )
      const text = await next.text()
      check(
        next.status === 200 && text.includes('continuing'),
        `Continue failed: ${next.status} ${text.slice(0, 200)}`,
      )
      const after = await messages(b, 'researcher')
      const last = after.findLast((m) => m.role === 'assistant')
      const retry = await fetch(
        `${b.url}/sessions/dm:researcher/chat`,
        postAs('dm:researcher', {
          messages: [{ id: last?.id ?? 'x', role: 'assistant', parts: [] }],
          trigger: 'regenerate-message',
          messageId: last?.id,
        }),
      )
      const rtext = await retry.text()
      check(
        retry.status === 200 && rtext.includes('retried reply'),
        `Retry failed: ${retry.status} ${rtext.slice(0, 200)}`,
      )
      return `turn recovered ${recoveredAfter} ms after the restart (staleMs is 120000); Continue -> 200, Retry -> 200`
    } finally {
      await b?.stop()
      work.cleanup()
    }
  },
)

await scenario(
  'SIGKILL while a background child works: after the restart the lead gets an interrupted report and the task is interrupted',
  async () => {
    const work = new Workdir()
    let b: Instance | undefined
    try {
      const env = { TEAM_INSTANCE_ID: 'srv' }
      const bgCall = {
        toolName: 'agent',
        toolCallId: 'call-bg',
        input: {
          subagent_type: 'researcher',
          description: 'Research',
          prompt: 'Look it up',
          name: 'scout',
          run_in_background: true,
        },
      }
      const a = await startInstance(
        'A',
        A_PORT,
        work,
        [{ toolCalls: [bgCall] }, { text: 'busy', delayMs: 4000 }, { text: 'busy', delayMs: 4000 }],
        env,
      )
      const res = await fetch(
        `${a.url}/sessions/dm:lead/chat`,
        postAs('dm:lead', userMessage('Research this in the background')),
      )
      check(res.status === 200, `lead chat on A: ${res.status}`)
      void res.text().catch(() => undefined)
      await until(
        'child task running',
        async () => (await tasks(a, '?status=running')).length >= 1,
        10_000,
      )
      await sleep(600)
      await a.kill()
      b = await startInstance('B', A_PORT, work, [{ text: 'I saw the interruption report.' }], env)
      await until(
        'interrupted report in the lead chat',
        async () =>
          JSON.stringify(await messages(b as Instance, 'lead')).includes('"status":"interrupted"'),
        20_000,
      )
      await until(
        'lead answered the report',
        async () =>
          JSON.stringify(await messages(b as Instance, 'lead')).includes(
            'I saw the interruption report.',
          ),
        20_000,
      )
      const rows = await tasks(b)
      check(
        rows.some((t) => t.status === 'interrupted'),
        `no interrupted task: ${JSON.stringify(rows.map((t) => t.status))}`,
      )
      const events =
        JSON.stringify(await messages(b, 'lead')).split('"status":"interrupted"').length - 1
      check(events === 1, `expected one interrupted report, found ${events}`)
      return 'interrupted report delivered once, lead woke, task row interrupted'
    } finally {
      await b?.stop()
      work.cleanup()
    }
  },
)

await scenario('routine due during downtime is skipped and fires once later', async () => {
  const spec = JSON.parse(
    readFileSync(join(dirname(import.meta.path), '../shared/openapi.json'), 'utf8'),
  ) as { paths: Record<string, unknown> }
  if (!Object.keys(spec.paths).some((p) => p.startsWith('/routines'))) {
    return 'SKIP (routines not built yet)'
  }
  return 'SKIP (routines routes exist now: add the scenario here)'
})

finish()
