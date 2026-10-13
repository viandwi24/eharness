import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineHarnessAgent } from 'eharness'
import { code } from 'eharness/code'
import { filesystem } from 'eharness/filesystem'
import { inMemoryFs } from 'eharness/filesystem/memory'
import { scriptedModel } from 'eharness/testing'
import { remoteSandbox } from '../src/client.ts'
import { type RunningServer, startServer } from '../src/server.ts'

const hasPython = Bun.spawnSync(['python3', '--version']).exitCode === 0
const silent = { debug() {}, info() {}, warn() {}, error() {} }
const TOKEN = 'integration-token-1'
let dir: string
let server: RunningServer

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eh-sbx-int-'))
  server = await startServer({
    token: TOKEN,
    dataDir: dir,
    osSandbox: false,
    log: () => {},
    limits: { processes: 1_000_000 },
  })
})
afterAll(async () => {
  await server.stop()
  await rm(dir, { recursive: true, force: true })
})

describe.skipIf(!hasPython)('code() over the remote sandbox', () => {
  test('run_python syncs files in, runs remotely, writes results back; isolation is declared', async () => {
    const fs = inMemoryFs({
      seed: {
        '/work/a.csv': 'x,y\n1,2\n3,4\n',
        '/work/analyze.py':
          "import csv\nrows = list(csv.DictReader(open('work/a.csv')))\nopen('work/out.txt', 'w').write(str(sum(int(r['y']) for r in rows)))\nprint('summed')\n",
      },
    })
    const agent = defineHarnessAgent({
      model: scriptedModel([
        { toolCalls: [{ toolName: 'run_python', input: { file: '/work/analyze.py' } }] },
        { text: 'done' },
      ]),
      contextWindow: 100_000,
      logger: silent,
      plugins: [
        filesystem({ fs }),
        code({
          sandbox: () => remoteSandbox({ url: server.url, token: TOKEN }),
          requireIsolation: true,
        }),
      ],
    })
    const session = agent.session('s')
    await session.send('go').result
    expect((await fs.read('/work/out.txt'))?.content).toBe('6')
    const messages = (await session.messages()) as Array<{ parts: Array<Record<string, unknown>> }>
    const outputs = messages.flatMap((m) =>
      m.parts.filter((p) => p.type === 'tool-run_python').map((p) => String(p.output)),
    )
    expect(outputs[0]).toMatch(/^summed\nExit code 0/)
    expect(outputs[0]).toContain('Saved: /work/out.txt')
    await session.close()
    expect(server.sessions()).toBe(0)
  })
})
