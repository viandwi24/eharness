/**
 * End-to-end flows of the web app, driven through the HTTP API the web uses, against one real
 * server process with a scripted model (`TEAM_SCRIPTED_MODEL`). There is no browser here (the
 * project has no browser-automation dependency): every step is the request a click makes.
 * The flows run one after another, so the one scripted model is consumed in a known order.
 *
 *   bun examples/team/scripts/e2e-flows.ts [--port 4700]
 *
 * 1. create a program, Run now, the report shows on the board
 * 2. a proposal in the lead's chat, Approve, the program exists and is scheduled
 * 3. an escalation parks a run, Decide, the same run resumes and finishes
 * 4. a queued task, the worker moves it to Review, Send back with a note, it is revised
 * 5. the heartbeat finds something, the digest (its cron slot, one minute ahead) carries it
 */
import {
  check,
  finish,
  type Instance,
  postAs,
  scenario,
  startInstance,
  until,
  userMessage,
  Workdir,
} from './lib.ts'

const portArg = process.argv.indexOf('--port')
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 4700

let n = 0
const call = (toolName: string, input: Record<string, unknown>) => ({
  toolCalls: [{ toolName, input, toolCallId: `e2e-${toolName}-${++n}` }],
})
const final = (summary: string, outputs: string[] = []) =>
  call('final_answer', { status: 'done', summary, outputs })

const steps = [
  // 1. program run
  call('write_file', { path: '/library/reports/weekly.md', content: '# Weekly\nall good' }),
  final('wrote the weekly report', ['/library/reports/weekly.md']),
  // 2. the lead proposes a plan in its chat
  call('propose_plan', {
    title: 'Watch the competitors every Monday',
    body: 'Read the pricing pages and note changes.',
    agent: 'researcher',
    name: 'Competitor watch',
    brief: 'Read /library/competitors/** and write /library/reports/competitors.md.',
    authority: { read: ['/library/competitors/**'], write: ['/library/reports/**'] },
    schedule: { cron: '0 8 * * 1', timezone: 'UTC' },
  }),
  { text: 'I put the plan in the Decision Center.' },
  // 3. an escalation
  call('escalate', {
    title: 'Publish the weekly report?',
    question: 'The report is ready. Publish it to the shared channel?',
    options: ['publish', 'hold'],
  }),
  final('published after the client said yes'),
  // 4. worker: two runs of the same task (the second after Send back)
  call('write_file', { path: '/library/scripts/island.md', content: 'v1' }),
  call('complete_task', { summary: 'drafted v1', outputs: ['/library/scripts/island.md'] }),
  final('drafted v1', ['/library/scripts/island.md']),
  call('read_file', { path: '/library/scripts/island.md' }), // an overwrite needs a read first
  call('write_file', { path: '/library/scripts/island.md', content: 'v2 shorter' }),
  call('complete_task', { summary: 'revised', outputs: ['/library/scripts/island.md'] }),
  final('revised', ['/library/scripts/island.md']),
  // 5. heartbeat
  call('team_status', {}),
  call('final_answer', {
    status: 'attention',
    items: [
      {
        kind: 'e2e.note',
        title: 'The audit program has no owner',
        detail: 'Nobody reviews its reports.',
        links: [],
        urgent: false,
      },
    ],
  }),
]

const work = new Workdir()
let server: Instance | undefined
const j = async <T>(res: Response): Promise<T> => {
  if (!res.ok) throw new Error(`${res.status} ${res.url}: ${await res.text()}`)
  return (await res.json()) as T
}
const get = <T>(path: string): Promise<T> => fetch(`${server?.url}${path}`).then((r) => j<T>(r))
const send = <T>(method: string, path: string, body?: unknown): Promise<T> =>
  fetch(`${server?.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((r) => j<T>(r))

interface Task {
  id: string
  status: string
  sessionId: string
  round: number
  acceptedAt: number | null
  report: { status: string; summary: string; outputs: string[] } | null
}
const tasks = async (query = ''): Promise<Task[]> =>
  (await get<{ tasks: Task[] }>(`/tasks?limit=200${query}`)).tasks
const base = {
  gates: [],
  escalation: 'Ask when unsure.',
  forbidden: [],
  budget: { perRunUsd: null, perDayUsd: null },
}

try {
  server = await startInstance('e2e', PORT, work, steps, { TEAM_ROUTINE_TICK_MS: '500' })
  await send('PATCH', '/settings', { timezone: 'UTC' })

  await scenario('1. create program, Run now, the report is on the board', async () => {
    const program = await send<{ id: string }>('POST', '/programs', {
      ...base,
      agentId: 'researcher',
      name: 'Weekly report',
      brief: 'Write /library/reports/weekly.md.',
      authority: { read: ['/library/**'], write: ['/library/reports/**'] },
    })
    const started = await send<{ started: boolean; sessionId: string }>(
      'POST',
      `/programs/${program.id}/run`,
    )
    check(started.started, 'the run did not start')
    await until('the run is done', async () => (await tasks('&status=done')).length === 1)
    const [run] = await tasks('&status=done')
    check(run?.report?.status === 'done', `report: ${JSON.stringify(run?.report)}`)
    check(run.report.outputs.includes('/library/reports/weekly.md'), 'the output is not listed')
    const file = await get<{ content: string }>('/library/file?path=/library/reports/weekly.md')
    check(file.content.includes('all good'), 'the report file is missing')
    const runs = await get<{ runs: Task[] }>(`/programs/${program.id}/runs`)
    check(runs.runs.length === 1, 'the program has not one run')
    return `report "${run.report.summary}" and its file are there`
  })

  await scenario('2. proposal in the lead chat, Approve, the program exists', async () => {
    const res = await fetch(
      `${server?.url}/sessions/dm:lead/chat`,
      postAs('dm:lead', userMessage('Please watch our competitors.')),
    )
    check(res.status === 200, `chat: ${res.status}`)
    await res.text()
    const open = await get<{ decisions: Array<{ id: string; kind: string }> }>(
      '/decisions?status=open&kind=proposal',
    )
    check(open.decisions.length === 1, `open proposals: ${open.decisions.length}`)
    const before = (await get<{ programs: unknown[] }>('/programs')).programs.length
    await send('POST', `/decisions/${open.decisions[0]?.id}/approve`, {})
    const after = await get<{
      programs: Array<{ name: string; status: string; trigger: { kind: string } }>
    }>('/programs')
    check(after.programs.length === before + 1, 'the program was not created')
    const made = after.programs.find((p) => p.name === 'Competitor watch')
    check(made?.status === 'active' && made.trigger.kind === 'schedule', 'not an active schedule')
    return 'approved: an active scheduled program "Competitor watch"'
  })

  await scenario('3. escalation parks the run, Decide, the same run resumes', async () => {
    const program = await send<{ id: string }>('POST', '/programs', {
      ...base,
      agentId: 'researcher',
      name: 'Publisher',
      brief: 'Publish the weekly report after the client agrees.',
      authority: { read: ['/library/**'], write: ['/library/reports/**'] },
    })
    const started = await send<{ sessionId: string }>('POST', `/programs/${program.id}/run`)
    await until('the escalation is open', async () => {
      const d = await get<{ decisions: unknown[] }>('/decisions?status=open&kind=escalation')
      return d.decisions.length === 1
    })
    const parked = await get<{ decisions: Array<{ id: string; sessionId: string }> }>(
      '/decisions?status=open&kind=escalation',
    )
    check(
      parked.decisions[0]?.sessionId === started.sessionId,
      'the decision names another session',
    )
    const mid = (await tasks()).find((t) => t.sessionId === started.sessionId)
    check(mid?.status !== 'done', `the parked run is ${mid?.status}`)
    await send('POST', `/decisions/${parked.decisions[0]?.id}/approve`, { choice: 'publish' })
    await until('the run finished', async () => {
      const t = (await tasks()).find((x) => x.sessionId === started.sessionId)
      return t?.status === 'done'
    })
    return 'parked on the decision, resumed in the same session, done'
  })

  await scenario('4. queued task, Review, Send back, revised', async () => {
    const queued = await send<Task>('POST', '/tasks', {
      agentId: 'writer',
      title: 'Script: the island',
      brief: 'Write /library/scripts/island.md',
    })
    check(queued.status === 'queued', `status ${queued.status}`)
    const worker = await send<{ id: string }>('POST', '/programs', {
      ...base,
      agentId: 'writer',
      name: 'Script worker',
      brief: 'Take the task you were given.',
      authority: { read: ['/library/**'], write: ['/library/scripts/**'] },
      worker: { maxTasks: 1 },
    })
    await send('POST', `/programs/${worker.id}/run`)
    await until('the task is in Review', async () => {
      const t = (await tasks()).find((x) => x.id === queued.id)
      return t?.status === 'done' && t.report !== null && t.acceptedAt === null
    })
    const back = await send<Task>('POST', `/tasks/${queued.id}/send-back`, {
      note: 'Make it shorter.',
    })
    check(back.status === 'queued' && back.round === 2, `sent back: ${back.status} r${back.round}`)
    await new Promise((r) => setTimeout(r, 20)) // a new run id (ms)
    await send('POST', `/programs/${worker.id}/run`)
    await until('the revision is in Review', async () => {
      const t = (await tasks()).find((x) => x.id === queued.id)
      return t?.status === 'done' && t.round === 2 && t.report?.summary === 'revised'
    })
    const file = await get<{ content: string }>('/library/file?path=/library/scripts/island.md')
    check(file.content === 'v2 shorter', `file: ${file.content}`)
    await send('POST', `/tasks/${queued.id}/accept`)
    return 'queued -> Review -> sent back (round 2) -> revised -> accepted'
  })

  await scenario('5. heartbeat attention reaches the daily digest', async () => {
    const lead = (
      await get<{ agents: Array<{ id: string; slug: string }> }>('/agents')
    ).agents.find((a) => a.slug === 'lead')
    check(lead !== undefined, 'no lead')
    await send('PATCH', `/agents/${lead.id}/heartbeat`, {
      activeFrom: '00:00',
      activeTo: '00:00',
      everyMinutes: 1440,
    })
    const put = await fetch(
      `${server?.url}/memory/file?scope=agent&agentId=${lead.id}&path=HEARTBEAT.md`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '- check who owns what\n' }),
      },
    )
    check(put.ok, `checklist: ${put.status}`)
    await send('POST', `/agents/${lead.id}/heartbeat/run`)
    await until('the beat shows attention', async () => {
      const v = await get<{ beats: Array<{ status: string }> }>(`/agents/${lead.id}/heartbeat`)
      return v.beats[0]?.status === 'attention'
    })
    const before = await get<{ digest: { buffered: number; lastSentAt: number | null } }>(
      `/agents/${lead.id}/heartbeat`,
    )
    check(before.digest.buffered === 1, `buffered ${before.digest.buffered}`)
    // the digest fires at its cron slot: set it to the next minute (UTC = the team timezone)
    const when = new Date(Date.now() + (60 - new Date().getSeconds() > 5 ? 60_000 : 120_000))
    const time = `${String(when.getUTCHours()).padStart(2, '0')}:${String(when.getUTCMinutes()).padStart(2, '0')}`
    await send('PATCH', '/digest', { time, enabled: true })
    await until(
      'the digest is sent',
      async () => {
        const v = await get<{ digest: { lastSentAt: number | null; buffered: number } }>(
          `/agents/${lead.id}/heartbeat`,
        )
        return v.digest.lastSentAt !== null
      },
      150_000,
    )
    // the digest is a Briefing page plus one bell notification, never a chat message
    const page = await get<{ briefings: Array<{ body: string }> }>('/briefings')
    check(
      page.briefings.some((b) => b.body.includes('The audit program has no owner')),
      'the digest is not on the Briefing page',
    )
    const bell = await get<{ notifications: Array<{ kind: string }> }>('/notifications')
    check(
      bell.notifications.some((n) => n.kind === 'briefing'),
      'the bell has no "briefing ready" notification',
    )
    const after = await get<{ digest: { buffered: number } }>(`/agents/${lead.id}/heartbeat`)
    check(after.digest.buffered === 0, 'the buffer was not emptied')
    return `digest at ${time} UTC carried the heartbeat item`
  })
} finally {
  await server?.stop()
  work.cleanup()
}
finish()
