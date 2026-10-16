/** The consistency scan on a real server: memory files of an agent, and the Health page listing. */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { consistencyFindings } from '../src/app/consistency.ts'
import { listHealth, runHealthJob } from '../src/app/health.ts'
import { agentMemory } from '../src/domain/memory.ts'
import { compose, type Server } from '../src/main.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function boot(): Server {
  const dir = mkdtempSync(join(tmpdir(), 'team-consistency-'))
  dirs.push(dir)
  const server = compose({
    dbFile: join(dir, 'team.db'),
    instanceId: 'consistency-test',
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

describe('consistency scan', () => {
  test('memory files of an agent become findings on the Health page', async () => {
    const server = boot()
    const { deps } = server
    const agent = deps.agents.getBySlug('lead') ?? deps.agents.list()[0]
    if (agent === undefined) throw new Error('no agent')
    const root = agentMemory(agent.id)
    await deps.library.writeText(`${root}/follow-up.md`, 'id: <isi setelah approve>\n')
    await deps.library.writeText(`${root}/follow-up-program.md`, 'Follow up the quotations.\n')
    await deps.library.writeText(
      `${root}/status.md`,
      'Connection status: NOT connected\nprogram 99999999-9999-4999-8999-999999999999 is gone\n',
    )
    const found = await consistencyFindings(deps, { agentId: agent.id })
    const byKind = (k: string) => found.filter((f) => f.kind === k)
    expect(byKind('memory-placeholder')[0]?.memoryPath).toBe('follow-up.md')
    expect(byKind('memory-duplicate-topic')).toHaveLength(1)
    expect(byKind('memory-system-state')[0]?.line).toBe(1)
    expect(byKind('memory-dead-ref')[0]?.line).toBe(2)

    await runHealthJob(deps)
    const { findings } = await listHealth(deps, { kind: 'consistency' })
    expect(findings.length).toBe(found.length)
    const first = findings[0]
    expect(first?.consistency?.kind).toBeDefined()
    expect(first?.fix).not.toBe('')
    // one finding per fingerprint, dismissable
    deps.health.dismiss(first?.fingerprint ?? '', Date.now())
    const after = await listHealth(deps, { kind: 'consistency' })
    expect(after.findings.length).toBe(found.length - 1)
  })

  test('an empty workspace has no findings', async () => {
    const server = boot()
    expect(await consistencyFindings(server.deps)).toEqual([])
  })
})
