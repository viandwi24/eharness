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
  approvals,
  check,
  delegate,
  deleteOld,
  finish,
  type Instance,
  json,
  messages,
  post,
  type Step,
  scenario,
  sleep,
  startInstance,
  tasks,
  until,
  userMessage,
  Workdir,
} from './lib.ts'

const A_PORT = 4101
const B_PORT = 4102
const WAIT_STALE = process.argv.includes('--wait-stale')

async function park(work: Workdir): Promise<{ b: Instance; itemId: string }> {
  const a = await startInstance('A', A_PORT, work, [
    { toolCalls: [delegate('cleaner', 'call-1')] }, // lead
    { toolCalls: [deleteOld] }, // researcher: waits for approval
  ])
  const res = await fetch(`${a.url}/agents/lead/chat`, post(userMessage('Clean up the library')))
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
  return { b, itemId: (list[0] as { id: string }).id }
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
      const answer = await fetch(`${b.url}/approvals/${parked.itemId}`, post({ approved: true }))
      check(answer.status === 202, `answer status ${answer.status}`)
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
      const res = await fetch(`${a.url}/agents/researcher/chat`, post(userMessage('start')))
      check(res.status === 200, `chat on A: ${res.status}`)
      void res.text().catch(() => undefined)
      await sleep(450) // mid-turn: text streamed, the tool call is still to come
      await a.kill()

      b = await startInstance('B', B_PORT, work, [{ text: 'back again' }, { text: 'late reply' }])
      const stats = await json<{ activeTurn: { owner: string } | null }>(
        await fetch(`${b.url}/agents/researcher/stats`),
      )
      let note = `activeTurn on B right after the kill: ${stats.activeTurn === null ? 'none' : 'present (remote, heartbeat fresh)'}`
      const early = await fetch(`${b.url}/agents/researcher/chat`, post(userMessage('too early?')))
      await early.text()
      note += `; immediate chat on B -> ${early.status}`
      if (WAIT_STALE) {
        await sleep(125_000)
      } else {
        const n = ageHeartbeats(work.db)
        note += `; aged ${n} heartbeat/lock row(s) by SQL instead of waiting 120 s`
      }
      const next = await fetch(
        `${b.url}/agents/researcher/chat`,
        post(userMessage('are you there?')),
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
