/**
 * Agent health on a real server: the job over stored sessions, bell notice once per fingerprint,
 * the routes, and the authority suggestions of programs (create, approve, reject).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { uuidv7 } from 'eharness'
import * as domain from '../src/domain/health.ts'
import * as schema from '../src/http/schemas/agent-health.ts'
import { compose, type Server } from '../src/main.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function boot(): Server {
  const dir = mkdtempSync(join(tmpdir(), 'team-health-'))
  dirs.push(dir)
  const server = compose({
    dbFile: join(dir, 'team.db'),
    instanceId: 'health-test',
    models: {
      provider: 'scripted',
      defaultModel: 'none',
      resolve: () => {
        throw new Error('no model')
      },
    },
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
  } as never)
  servers.push(server)
  return server
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

async function makeProgram(server: Server, over: Record<string, unknown> = {}) {
  const res = await server.app.request(
    '/programs',
    json('POST', {
      agentId: 'researcher',
      name: 'Weekly audit',
      brief: 'Audit the topics.',
      authority: { read: ['/library/data/**'] },
      gates: [],
      escalation: '',
      forbidden: [],
      budget: { perRunUsd: null, perDayUsd: null },
      ...over,
    }),
  )
  if (res.status !== 201) throw new Error(await res.text())
  return (await res.json()) as { id: string; agentId: string }
}

const REASON = 'Outside the authority of program "Weekly audit": x is not granted to this run.'
let at = Date.now() - 60_000
function storeDenials(server: Server, sessionId: string, tool: string, n: number, reason = REASON) {
  const parts = Array.from({ length: n }, (_, i) => ({
    type: `tool-${tool}`,
    toolCallId: `${sessionId}-${tool}-${i}`,
    state: 'output-denied',
    input: { i },
    approval: { id: `ap${i}`, approved: false, reason },
  }))
  server.conn.sqlite
    .query(
      'INSERT INTO eh_messages (session_id, id, role, parts, metadata, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
    )
    .run(sessionId, uuidv7(), 'assistant', JSON.stringify(parts), at++)
}

const get = async (server: Server, path: string) =>
  (await server.app.request(path)).json() as Promise<any>

test('the schema lists match the domain', () => {
  expect([...schema.FINDING_KINDS]).toEqual([...domain.FINDING_KINDS])
  expect([...schema.FINDING_SEVERITIES]).toEqual([...domain.FINDING_SEVERITIES])
})

describe('health job', () => {
  test('repeated denials across runs: one high finding, one bell notice, dismissable', async () => {
    const server = boot()
    const p = await makeProgram(server)
    const now = Date.now()
    for (const n of [1, 2, 3])
      storeDenials(server, `program:${p.id}:${now - n * 1000}`, 'channel_describe', 1)

    const first = await server.healthScan()
    expect(first).toMatchObject({ notified: 1 })
    const again = await server.healthScan()
    expect(again.notified).toBe(0)

    const bell = await get(server, '/notifications')
    const health = bell.notifications.filter((n: { title: string }) =>
      n.title.startsWith('Health:'),
    )
    expect(health).toHaveLength(1)
    expect(health[0].link).toBe('/attention')

    const list = await get(server, '/agent-health/findings')
    expect(list.open).toBe(1)
    const f = list.findings[0]
    expect(f).toMatchObject({
      kind: 'repeated-denial',
      severity: 'high',
      programId: p.id,
      programName: 'Weekly audit',
      agentName: expect.any(String),
      count: 3,
    })
    expect(f.link).toBe(`/programs/${p.id}`)
    expect(f.fix).toContain('authority')

    // filters
    expect((await get(server, '/agent-health/findings?severity=medium')).findings).toHaveLength(0)
    expect((await get(server, `/agent-health/findings?agent=${p.agentId}`)).findings).toHaveLength(
      1,
    )
    expect((await get(server, '/agent-health/findings?kind=tool-loop')).findings).toHaveLength(0)

    const fp = encodeURIComponent(f.fingerprint)
    expect(
      (await server.app.request(`/agent-health/findings/${fp}/dismiss`, json('POST'))).status,
    ).toBe(200)
    expect((await get(server, '/agent-health/findings')).findings).toHaveLength(0)
    expect((await get(server, '/agent-health/findings?dismissed=true')).findings[0].dismissed).toBe(
      true,
    )
    expect(
      (await server.app.request(`/agent-health/findings/${fp}/dismiss`, json('DELETE'))).status,
    ).toBe(200)
    expect((await get(server, '/agent-health/findings')).findings).toHaveLength(1)
    expect(
      (await server.app.request(`/agent-health/findings/${fp}/dismiss`, json('DELETE'))).status,
    ).toBe(409)
  })

  test('a dismissed high finding raises no notice', async () => {
    const server = boot()
    const p = await makeProgram(server)
    for (const n of [1, 2, 3])
      storeDenials(server, `program:${p.id}:${Date.now() - n * 1000}`, 'list_topics', 1)
    const f = (await get(server, '/agent-health/findings')).findings[0]
    server.deps.health.dismiss(f.fingerprint, Date.now())
    expect((await server.healthScan()).notified).toBe(0)
  })

  test('model call errors and a failed program run show up', async () => {
    const server = boot()
    const now = Date.now()
    const agent = server.deps.agents.getBySlug('lead')
    for (let i = 0; i < 3; i++) {
      server.conn.sqlite
        .query(
          `INSERT INTO model_calls (id, created_at, kind, agent_id, session_id, provider, model_id, status, started_at, duration_ms, error_name, error_message)
           VALUES (?, ?, 'step', ?, 'dm:x', 'p', 'm', 'error', ?, 5, 'APICallError', 'Rate limited: slow down')`,
        )
        .run(uuidv7(), now, agent?.id ?? null, now - i * 1000)
    }
    const list = await get(server, '/agent-health/findings')
    const provider = list.findings.find((f: { kind: string }) => f.kind === 'provider-error')
    expect(provider).toMatchObject({ count: 3, severity: 'high', agentId: agent?.id })
  })
})

describe('authority suggestions', () => {
  const decisions = async (server: Server) =>
    (await get(server, '/decisions?status=open&kind=amendment')).decisions as Array<{
      id: string
      title: string
      programId: string
      sessionId: string | null
      payload: {
        suggestion?: { tool: string; runs: number; denials: number }
        authority: { tools: string[] }
      }
    }>

  test('two runs denied a tool: one item; approving widens the authority; no second item', async () => {
    const server = boot()
    const p = await makeProgram(server)
    const now = Date.now()
    storeDenials(server, `program:${p.id}:${now - 2000}`, 'list_topics', 2)
    storeDenials(server, `program:${p.id}:${now - 1000}`, 'list_topics', 1)

    await server.healthScan()
    await server.healthScan()
    const open = await decisions(server)
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({
      title: 'Add list_topics to the authority of program Weekly audit?',
      programId: p.id,
      sessionId: null,
    })
    expect(open[0]?.payload.suggestion).toEqual({ tool: 'list_topics', runs: 2, denials: 3 })

    const res = await server.app.request(`/decisions/${open[0]?.id}/approve`, json('POST', {}))
    expect(res.status).toBe(200)
    const program = (await get(server, `/programs/${p.id}`)) as {
      authority: { tools: string[]; read: string[] }
    }
    expect(program.authority.tools).toContain('list_topics')
    expect(program.authority.read).toEqual(['/library/data/**'])
    // now granted: the program's own authority removes the candidate
    await server.healthScan()
    expect(await decisions(server)).toHaveLength(0)
  })

  test('rejecting silences that program and tool; another tool still asks', async () => {
    const server = boot()
    const p = await makeProgram(server)
    const now = Date.now()
    storeDenials(server, `program:${p.id}:${now - 2000}`, 'list_topics', 3)
    await server.healthScan()
    const first = (await decisions(server))[0]
    expect(
      (await server.app.request(`/decisions/${first?.id}/reject`, json('POST', {}))).status,
    ).toBe(200)
    await server.healthScan()
    expect(await decisions(server)).toHaveLength(0)
    storeDenials(server, `program:${p.id}:${now - 1000}`, 'channel_describe', 3)
    await server.healthScan()
    const next = await decisions(server)
    expect(next.map((d) => d.payload.suggestion?.tool)).toEqual(['channel_describe'])
    // the rejected tool is still not asked, even with more denials
    storeDenials(server, `program:${p.id}:${now - 500}`, 'list_topics', 5)
    await server.healthScan()
    expect(await decisions(server)).toHaveLength(1)
  })

  test('never forbidden, destructive, file or unknown tools; paused programs are left alone', async () => {
    const server = boot()
    const p = await makeProgram(server, { forbidden: ['list_topics'] })
    const now = Date.now()
    storeDenials(server, `program:${p.id}:${now - 3000}`, 'list_topics', 4)
    storeDenials(server, `program:${p.id}:${now - 2900}`, 'channel_delete_message', 4)
    storeDenials(server, `program:${p.id}:${now - 2800}`, 'grep', 4)
    storeDenials(server, `program:${p.id}:${now - 2700}`, 'mystery', 4)
    storeDenials(
      server,
      `program:${p.id}:${now - 2600}`,
      'channel_describe',
      1,
      'Forbidden by program "Weekly audit": x',
    )
    await server.healthScan()
    expect(await decisions(server)).toHaveLength(0)
  })
})
