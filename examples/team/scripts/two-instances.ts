/**
 * Two real server processes (:4101, :4102) on one database file, scripted model (no network).
 * Run: bun examples/team/scripts/two-instances.ts
 */
import {
  answerItem,
  approvals,
  check,
  delegate,
  deleteOld,
  finish,
  type Instance,
  json,
  messages,
  parseSse,
  post,
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

let disagreement: string | undefined
const A_PORT = 4101
const B_PORT = 4102

async function withPair(
  aSteps: Step[],
  bSteps: Step[],
  body: (a: Instance, b: Instance) => Promise<string | undefined>,
): Promise<string | undefined> {
  const work = new Workdir()
  let a: Instance | undefined
  let b: Instance | undefined
  try {
    a = await startInstance('A', A_PORT, work, aSteps)
    b = await startInstance('B', B_PORT, work, bSteps)
    return await body(a, b)
  } finally {
    await Promise.all([a?.stop(), b?.stop()])
    work.cleanup()
  }
}

await scenario('resume the running stream from B', () =>
  withPair([{ text: 'a slow answer', delayMs: 250 }], [], async (a, b) => {
    const idle = await fetch(`${b.url}/sessions/dm:researcher/chat/stream`)
    check(idle.status === 204, `idle resume expected 204, got ${idle.status}`)
    const first = await fetch(
      `${a.url}/sessions/dm:researcher/chat`,
      postAs('dm:researcher', userMessage('go')),
    )
    check(first.status === 200, `chat on A: ${first.status}`)
    const local = first.text()
    await sleep(500)
    const res = await fetch(`${b.url}/sessions/dm:researcher/chat/stream`)
    check(res.status === 200, `resume on B expected 200, got ${res.status}`)
    const remote = parseSse(await res.text())
    const own = parseSse(await local)
    check(remote.done && own.done, 'a stream did not end with [DONE]')
    check(
      JSON.stringify(remote.chunks) === JSON.stringify(own.chunks),
      `chunk sequences differ: A=${own.chunks.length} B=${remote.chunks.length}`,
    )
    const tail = await fetch(`${b.url}/sessions/dm:researcher/chat/stream`)
    check(tail.status === 204, `after the turn expected 204, got ${tail.status}`)
    return `${own.chunks.length} chunks identical`
  }),
)

await scenario('abort a running turn from B', () =>
  withPair([{ text: 'a very slow answer', delayMs: 500 }], [], async (a, b) => {
    const first = await fetch(
      `${a.url}/sessions/dm:researcher/chat`,
      postAs('dm:researcher', userMessage('go')),
    )
    const local = first.text()
    await sleep(400)
    const abort = await fetch(`${b.url}/sessions/dm:researcher/interrupt`, post({ reason: 'stop' }))
    check(abort.status === 200, `abort status ${abort.status}`)
    const body = await json<{ target: string }>(abort)
    check(body.target === 'remote', `expected target remote, got ${body.target}`)
    const t0 = Date.now()
    await local
    const last = (await messages(b, 'researcher')).at(-1)
    check(
      last?.metadata?.eharness?.stop === 'aborted',
      `stop was ${last?.metadata?.eharness?.stop}`,
    )
    return `A ended ${Date.now() - t0} ms after the stream read`
  }),
)

await scenario('message on B during a turn on A is steered (202) and appears', () =>
  withPair(
    [
      {
        toolCalls: [{ toolName: 'write_file', input: { path: '/library/x.md', content: 'x' } }],
        delayMs: 300,
      },
      { text: 'done', delayMs: 20 },
    ],
    [],
    async (a, b) => {
      const first = await fetch(
        `${a.url}/sessions/dm:researcher/chat`,
        postAs('dm:researcher', userMessage('start')),
      )
      const local = first.text()
      await sleep(250)
      const steer = await fetch(
        `${b.url}/sessions/dm:researcher/chat`,
        postAs('dm:researcher', userMessage('also steer-me')),
      )
      check(steer.status === 202, `expected 202, got ${steer.status}`)
      const q = await json<{ delivered: string; inboxId: string }>(steer)
      check(q.delivered === 'steer', `delivered=${q.delivered}`)
      await local
      await sleep(500)
      const text = JSON.stringify(await messages(b, 'researcher'))
      check(text.includes('also steer-me'), 'steered text not stored in the turn')
      return `inboxId ${q.inboxId.slice(0, 8)}…`
    },
  ),
)

await scenario(
  'lead parks on A; approval answered on B; lead reply stored; B events carry it',
  () =>
    withPair(
      [
        { toolCalls: [delegate('cleaner', 'call-1')] }, // lead
        { toolCalls: [deleteOld] }, // researcher: waits for approval
      ],
      [
        { text: 'Done: handled old.md.' }, // researcher resumes on B
        { text: 'The researcher cleaned up.' }, // lead resumes on B
      ],
      async (a, b) => {
        const events: Array<{ type: string }> = []
        const ctl = new AbortController()
        const sse = (async () => {
          try {
            const res = await fetch(`${b.url}/activity/stream`, { signal: ctl.signal })
            const reader = res.body?.getReader()
            const dec = new TextDecoder()
            let buf = ''
            for (;;) {
              const r = await reader?.read()
              if (!r || r.done) break
              buf += dec.decode(r.value)
              for (;;) {
                const i = buf.indexOf('\n\n')
                if (i < 0) break
                const frame = buf.slice(0, i)
                buf = buf.slice(i + 2)
                const line = frame.split('\n').find((l) => l.startsWith('data: '))
                if (line) events.push(JSON.parse(line.slice(6)) as { type: string })
              }
            }
          } catch {}
        })()
        await sleep(300) // the feed starts at the head

        const res = await fetch(
          `${a.url}/sessions/dm:lead/chat`,
          postAs('dm:lead', userMessage('Clean up the library')),
        )
        check(res.status === 200, `lead chat on A: ${res.status}`)
        await res.text()
        await until('approval visible on B', async () => (await approvals(b)).length === 1)
        const item = (await approvals(b))[0]
        check(item?.toolName === 'delete_file', `approval tool ${item?.toolName}`)
        const answer = await answerItem(b, item, { approved: true })
        check(answer.status === 200, `answer status ${answer.status}`)
        await until('lead reply stored', async () =>
          JSON.stringify(await messages(b, 'lead')).includes('The researcher cleaned up.'),
        )
        await until('task done', async () => (await tasks(b, '?status=done')).length === 1)
        // A and B must agree once B answered (checked as its own scenario below)
        await until(
          'A and B agree on /approvals',
          async () => (await approvals(a)).length === 0,
          6000,
        ).catch(() => undefined)
        const left = await approvals(a)
        if (left.length > 0) {
          disagreement = `A still lists ${left.length} approval(s) 6 s after B answered (task row says ${(await tasks(a))[0]?.status}): ${left.map((x) => `${x.toolName}@${x.sessionId}`).join(', ')}`
        }
        await sleep(800)
        ctl.abort()
        await sse
        const types = events.map((e) => e.type)
        for (const t of ['pending-changed', 'approval-decided', 'task-changed', 'message-added']) {
          check(
            types.includes(t),
            `B /activity/stream lacks "${t}" (got ${[...new Set(types)].join(',')})`,
          )
        }
        return `${events.length} events on B's stream`
      },
    ),
)

await scenario('A and B agree on /approvals after B answered', async () => {
  check(disagreement === undefined, disagreement ?? '')
  return 'both empty'
})

finish()
