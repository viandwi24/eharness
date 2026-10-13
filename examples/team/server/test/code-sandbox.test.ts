/**
 * The Files & Sandbox connector (docs/plans/P44-code-sandbox.md, phase F): an agent writes data and
 * a script into the library, `run_python` runs it in the local sandbox and the report lands in the
 * database-backed library; a second run does not copy unchanged files in again; a failing script
 * saves nothing. Scripted model, real `python3` (skipped when it is missing), standard library only.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ScriptedCallOptions, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { createAgent, updateAgent } from '../src/app/agents.ts'
import { builtinId } from '../src/domain/connectors.ts'
import { libraryFs } from '../src/infra/eh/library-fs.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'
import { postAs, userMessage } from './support/http.ts'

const hasPython = Bun.which('python3') !== null
const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const SALES = 'region,amount\nnorth,10\nsouth,20\nnorth,5\n'
const ANALYZE = `import csv, os
rows = list(csv.DictReader(open('library/work/sales.csv')))
tot = {}
for r in rows:
    tot[r['region']] = tot.get(r['region'], 0) + int(r['amount'])
with open('library/work/report.md', 'w') as f:
    f.write('# Report\\n' + ''.join(f'- {k}: {v}\\n' for k, v in sorted(tot.items())))
print('mtime', os.stat('library/work/sales.csv').st_mtime_ns)
`
const BROKEN = `open('library/work/ghost.md', 'w').write('should not be saved')
raise SystemExit(3)
`

function toolText(call: ScriptedCallOptions): string {
  const msgs = call.prompt as unknown as Array<{
    role: string
    content: Array<Record<string, unknown>>
  }>
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m?.role !== 'tool') continue
    const out = m.content.find((p) => p.type === 'tool-result')?.output as
      | { value: unknown }
      | undefined
    return typeof out?.value === 'string' ? out.value : JSON.stringify(out?.value)
  }
  return ''
}

describe.skipIf(!hasPython)('run_python over the library', () => {
  test('CSV -> script -> report in the database; unchanged files are not copied again; a failed run saves nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-code-'))
    dirs.push(dir)
    const results: string[] = []
    const record =
      (step: ScriptedStepInput): ScriptedStepInput =>
      (call: ScriptedCallOptions) => {
        results.push(toolText(call))
        return typeof step === 'function' ? step(call) : step
      }
    let n = 0
    const call = (toolName: string, input: unknown): ScriptedStepInput => ({
      toolCalls: [{ toolName, toolCallId: `c${++n}`, input }],
    })
    const model = scriptedModel([
      call('write_file', { path: '/library/work/sales.csv', content: SALES }),
      record(call('write_file', { path: '/library/work/analyze.py', content: ANALYZE })),
      record(call('run_python', { file: '/library/work/analyze.py' })),
      record(call('run_python', { file: '/library/work/analyze.py' })),
      record(call('write_file', { path: '/library/work/broken.py', content: BROKEN })),
      record(call('run_python', { file: '/library/work/broken.py' })),
      record({ text: 'done' }),
    ] as ScriptedStepInput[])
    const config: ModelConfig = {
      provider: 'scripted',
      defaultModel: 'none',
      resolve: () => model as never,
    }
    const server = compose({
      dbFile: join(dir, 'team.db'),
      models: config,
      tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 },
      eventsPollMs: 30,
      reconcile: { onBoot: false, everyMs: 0 },
      routines: { tickMs: 0 },
      code: { driver: 'local', install: 'off' },
    })
    servers.push(server)
    const def = createAgent(server.deps, {
      slug: 'analyst-x',
      name: 'Analyst X',
      role: 'custom',
      instructions: 'You analyse files.',
      model: 'm',
      connectors: {
        [builtinId('files')]: {
          enabled: 'on',
          capabilities: { read: 'allow', edit: 'allow', delete: 'allow', run: 'allow' },
        },
      },
    })
    updateAgent(server.deps, def.id, { model: 'm' })
    const mode = await server.app.request('/agents/analyst-x/mode', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'bypass' }),
    })
    expect(mode.status).toBe(200)

    const res = await server.app.request(
      '/sessions/dm:analyst-x/chat',
      postAs('dm:analyst-x', userMessage('analyse the sales')),
    )
    expect(res.status).toBe(200)
    await res.text()

    // each result is the answer to the call before it: [2] the first run, [3] the second, [5] the failing one
    const first = results[2] ?? ''
    const second = results[3] ?? ''
    const failed = results[5] ?? ''
    expect(first).toContain('Exit code 0')
    expect(first).toContain('/library/work/report.md')
    const fs = libraryFs(server.conn.sqlite)
    expect((await fs.read('/library/work/report.md'))?.content).toBe(
      '# Report\n- north: 15\n- south: 20\n',
    )
    // the second run copied nothing in: the sandbox file is the one of the first run
    const mtime = (t: string): string => /mtime (\d+)/.exec(t)?.[1] ?? 'missing'
    expect(mtime(second)).toBe(mtime(first))
    expect(mtime(first)).not.toBe('missing')
    // a failing script saves nothing
    expect(failed).toContain('Exit code 3')
    expect(await fs.stat?.('/library/work/ghost.md')).toBeNull()

    const info = (await (await server.app.request('/settings/code')).json()) as {
      driver: string
    }
    expect(info.driver).toBe('local')
  }, 60_000)
})
