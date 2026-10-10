/**
 * Optional real-model smoke (costs money): one chat turn with the Lead that delegates a tiny
 * research task to a role agent and reports back. Needs OPENROUTER_API_KEY (environment or the
 * repo root `.env`; never printed). Model: `TEAM_MODEL` (default of the server).
 * Run: bun examples/team/scripts/smoke-real.ts
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  approvals,
  json,
  messages,
  parseSse,
  post,
  type StoredMessage,
  sleep,
  startInstance,
  tasks,
  userMessage,
  Workdir,
} from './lib.ts'

function loadKey(): string {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY
  const file = join(dirname(import.meta.path), '../../../.env')
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*OPENROUTER_API_KEY\s*=\s*(.*)\s*$/.exec(line)
      if (m) return (m[1] as string).replace(/^['"]|['"]$/g, '')
    }
  }
  console.error('OPENROUTER_API_KEY not found in the environment or the repo root .env')
  process.exit(2)
}

const key = loadKey()
const work = new Workdir()
const server = await startInstance('smoke', 4103, work, [], {
  OPENROUTER_API_KEY: key,
  TEAM_SCRIPTED_MODEL: '',
})
let code = 0
try {
  const prompt =
    'Ask the researcher to find out, in two sentences, what the AI SDK `streamText` function does ' +
    'and to save the answer to /library/research/streamtext.md. Then tell me what they found.'
  console.log(`> ${prompt}`)
  const res = await fetch(`${server.url}/agents/lead/chat`, post(userMessage(prompt)))
  if (res.status !== 200) throw new Error(`chat ${res.status}: ${await res.text()}`)
  const first = parseSse(await res.text())
  console.log(`lead turn 1: ${first.chunks.length} chunks`)

  const end = Date.now() + 240_000
  let lastLead = ''
  for (;;) {
    for (const item of await approvals(server)) {
      console.log(`approving ${item.toolName} of ${item.agentName} (smoke run: auto-approve)`)
      await fetch(`${server.url}/approvals/${item.id}`, post({ approved: true }))
    }
    const all = await tasks(server)
    const open = all.some((t) => t.status === 'running' || t.status === 'needs_action')
    const lead = await messages(server, 'lead')
    const text = lead.at(-1)?.role === 'assistant' ? textOf(lead.at(-1)) : ''
    if (!open && all.length > 0 && text !== '' && text === lastLead) break
    lastLead = text
    if (Date.now() > end) throw new Error('timed out after 240 s')
    await sleep(3000)
  }

  console.log('\n--- transcript ---')
  for (const m of await messages(server, 'lead')) {
    const tools = m.parts
      .filter((p) => String(p.type).startsWith('tool-'))
      .map((p) => String(p.type).slice(5))
    console.log(
      `[${m.role}] ${textOf(m).slice(0, 400).replace(/\n/g, ' ')}${tools.length ? `  (tools: ${tools.join(', ')})` : ''}`,
    )
  }
  console.log('\n--- tasks ---')
  let cost = 0
  for (const t of (
    await json<{ tasks: Array<Record<string, unknown>> }>(await fetch(`${server.url}/tasks`))
  ).tasks) {
    cost += Number(t.costUsd ?? 0)
    console.log(
      `${t.status}  ${t.title}  tokens=${t.tokens}  cost=$${Number(t.costUsd ?? 0).toFixed(4)}  summary=${String(t.summary ?? '').slice(0, 200)}`,
    )
  }
  const stats = await json<{ usage: Record<string, unknown> }>(
    await fetch(`${server.url}/agents/lead/stats`),
  )
  console.log('\nlead usage:', JSON.stringify(stats.usage))
  console.log(`tasks cost total: $${cost.toFixed(4)}`)
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
  console.error(server.log.slice(-15).join('\n'))
  code = 1
} finally {
  await server.stop()
  work.cleanup()
}
process.exit(code)

function textOf(m: StoredMessage | undefined): string {
  return (m?.parts ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => String(p.text))
    .join('')
}
