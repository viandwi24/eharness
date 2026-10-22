/**
 * The server process of the soak test: the real `compose()` (same boot repair, routine ticker,
 * heartbeat and digest runners, SQLite file) with the soak brain as model and a few control
 * routes under `/__soak/` that only this script uses (they are not part of the product API):
 *
 *   GET  /__soak/info      agent ids by slug and the brain counters
 *   POST /__soak/digest    run the digest now (the cron slot is once a day, so it cannot be waited for)
 *   POST /__soak/task      queue a task (body: agentId, title, brief); the product has no owner-facing create route
 *   GET  /__soak/parked    the sessions with a pending wait (a parked run) among `?sessions=a,b`
 *
 * Env: PORT, TEAM_DB, TEAM_INSTANCE_ID, SOAK_SEED, SOAK_FAULT_RATE, SOAK_ESCALATE_RATE.
 */
import { updateAgent } from '../../server/src/app/agents.ts'
import { runDigest } from '../../server/src/app/heartbeat.ts'
import { createTask } from '../../server/src/app/work-queue.ts'
import { checklistPath } from '../../server/src/domain/heartbeat.ts'
import { compose } from '../../server/src/main.ts'
import { soakModels } from './brain.ts'

const num = (name: string, fallback: number): number => {
  const v = Number(process.env[name])
  return process.env[name] !== undefined && Number.isFinite(v) ? v : fallback
}

const { config, stats } = soakModels({
  seed: num('SOAK_SEED', 1),
  faultRate: num('SOAK_FAULT_RATE', 0.12),
  escalateRate: num('SOAK_ESCALATE_RATE', 0.25),
})
const port = num('PORT', 4700)
const server = compose({
  dbFile: process.env.TEAM_DB as string,
  instanceId: process.env.TEAM_INSTANCE_ID ?? `soak-${port}`,
  models: config,
  catalog: { scripted: { contextWindow: 100_000_000, pricing: { input: 1, output: 2 } } } as never,
  tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 },
  eventsPollMs: 100,
  // the ticker and the repair pass run fast so a short run sees many slots and recoveries
  routines: { tickMs: 500, recoverAfterMs: 3000, graceMs: 20_000 },
  reconcile: { onBoot: true, everyMs: 3000 },
  debug: { invariants: true },
})
await server.providersReady
await server.connectorsReady
await server.ready

const slugs = ['lead', 'researcher', 'writer'] as const
const ids: Record<string, string> = {}
for (const slug of slugs) {
  const def = server.deps.agents.getBySlug(slug)
  if (def === undefined) throw new Error(`seed missing: ${slug}`)
  ids[slug] = def.id
  if (def.model !== `m-${slug}`) updateAgent(server.deps, def.id, { model: `m-${slug}` })
}
// the lead's heartbeat needs a checklist to run at all
const leadId = ids.lead as string
if ((await server.deps.library.read(checklistPath(leadId))) === undefined) {
  await server.deps.library.writeText(
    checklistPath(leadId),
    '- look at the board and the programs\n',
  )
}

const http = Bun.serve({
  port,
  hostname: '127.0.0.1',
  idleTimeout: 0,
  async fetch(request, bunServer) {
    const url = new URL(request.url)
    if (url.pathname === '/__soak/info') return Response.json({ agents: ids, brain: stats })
    if (url.pathname === '/__soak/digest' && request.method === 'POST') {
      return Response.json({ outcome: await runDigest(server.deps) })
    }
    if (url.pathname === '/__soak/task' && request.method === 'POST') {
      const body = (await request.json()) as { agentId: string; title: string; brief?: string }
      return Response.json(createTask(server.deps, body), { status: 201 })
    }
    if (url.pathname === '/__soak/parked') {
      const sessions = (url.searchParams.get('sessions') ?? '').split(',').filter(Boolean)
      const parked: string[] = []
      for (const id of sessions) {
        if ((await server.factory.peek(id).pending()) !== null) parked.push(id)
      }
      return Response.json({ parked })
    }
    return server.app.fetch(request, bunServer)
  },
})
console.log(`soak server on http://127.0.0.1:${http.port}`)
const stop = async (): Promise<void> => {
  http.stop(true)
  await server.close()
  process.exit(0)
}
process.on('SIGTERM', () => void stop())
process.on('SIGINT', () => void stop())
