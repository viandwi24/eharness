/**
 * Runs the examples offline (scripted model, no network) so `bun test` keeps them working, runs
 * the adapter examples' conformance suites as individual tests, and checks that the README quick
 * start is the code of `examples/quick-start.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fileSystemConformance,
  messageAdapterConformance,
  stateAdapterConformance,
} from 'eharness/testing'
import { kvFileSystem, mapKeyValueStore } from './custom-fs-adapter.ts'
import { jsonFileMessages, jsonFileState } from './json-file-storage.ts'
import {
  bunSqlPool,
  migrate,
  postgresLock,
  postgresMessages,
  postgresState,
} from './postgres-storage.ts'

const root = join(import.meta.dir, '..')

/** Run `bun examples/<file>` offline; returns stdout. */
async function run(file: string, env: Record<string, string | undefined> = {}): Promise<string> {
  const { AI_GATEWAY_API_KEY: _key, DATABASE_URL: _db, ...base } = process.env
  const child = Bun.spawn(['bun', join(root, 'examples', file)], {
    cwd: root,
    env: { ...base, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${file} exited with ${code}\n${stdout}\n${stderr}`)
  return stdout
}

describe('examples run offline', () => {
  const timeout = 30_000

  test(
    'basic-cli',
    async () => {
      const out = await run('basic-cli.ts')
      expect(out).toContain('→ write_file')
      expect(out).toContain('✎ create /notes/todo.md')
      expect(out).toContain('[complete · 2 steps')
      expect(out).toContain('- [ ] Try eharness')
    },
    timeout,
  )

  test(
    'quick-start',
    async () => {
      const out = await run('quick-start.ts')
      expect(out).toContain('complete after 3 steps')
      expect(out).toContain('2 messages stored')
    },
    timeout,
  )

  test(
    'tool-context',
    async () => {
      const out = await run('tool-context.ts')
      expect(out).toContain('progress 50%')
      expect(out).toContain('invoice draft')
      expect(out).toContain('invoice sent')
      expect(out).toContain('complete: 1 invoice part stored')
      expect(out).toContain('Invoice #1 for u_42 in session chat-1')
      expect(out).toContain('request: "Invoice 120 for me"')
    },
    timeout,
  )

  test(
    'next-route (useChat approval round trip)',
    async () => {
      const out = await run('next-route.demo.ts')
      expect(out).toContain('delete_file: waiting for your approval')
      expect(out).toContain('delete_file: ok')
      expect(out).toContain('stored messages: 2 (client: 2)')
      expect(out).toContain('same assistant id on client and server: true')
      expect(out).toContain('/drafts/old.md exists: false')
    },
    timeout,
  )

  test(
    'plugin-authoring',
    async () => {
      const out = await run('plugin-authoring.ts')
      expect(out).toContain('stop: complete, steps: 4')
      expect(out).toContain('input (plugin:checklist): 2 items are still open')
      expect(out).toContain('checklist part: ✓ outline, ✓ draft')
      expect(out).toContain('turn complete: 0 items open')
    },
    timeout,
  )

  test(
    'long-running (progress guard, wrap-up)',
    async () => {
      const out = await run('long-running.ts')
      expect(out).toContain('warning W_LOOP_STUCK:')
      expect(out).toContain('→ stuck after 6 steps')
      expect(out).toContain('→ max-steps after 4 steps: Read pages 1–3 of 10.')
    },
    timeout,
  )

  test(
    'budget-and-cost',
    async () => {
      const out = await run('budget-and-cost.ts')
      expect(out).toContain('step 1: turn so far $0.2300') // incl. the nested summarizer call
      expect(out).toContain('→ complete after 3 steps, $0.3275')
      expect(out).toContain('warning W_BUDGET: The turn budget of $0.5 is 84% used.')
      expect(out).toContain('→ cost-cap after 3 steps, $0.6300')
      expect(out).toContain('→ cost-cap after 0 steps') // session budget used up before the turn
      expect(out).toContain('stored on the first answer: $0.3275')
      expect(out).toContain('session total: $0.9575')
      expect(out).toContain('context window from the catalog: 200000')
    },
    timeout,
  )

  test(
    'risk-approvals',
    async () => {
      const out = await run('risk-approvals.ts')
      expect(out).toContain('audit: read_record approved by risk in ops-1')
      expect(out).toContain('turn: tool-pending')
      expect(out).toContain('inbox: delete_record {"id":"r1"} (risk: destructive)')
      expect(out).toContain('audit: delete_record approved by user u_7 in ops-1')
      expect(out).toContain('respond: complete; same message: true')
      expect(out).toContain('r1 exists: false; audit entries: 2')
    },
    timeout,
  )

  test(
    'todos',
    async () => {
      const out = await run('todos.ts')
      expect(out).toContain('[>] Read the report')
      expect(out).toContain('nudge (plugin:todos): You stopped with open todos:')
      expect(out).toContain('[-] Send it')
      expect(out).toContain('complete after 5 steps')
      expect(out).toContain(
        'latest: Read the report (completed), Fix the typos (completed), Send it (cancelled)',
      )
    },
    timeout,
  )

  test(
    'memory',
    async () => {
      const out = await run('memory.ts')
      expect(out).toContain('tool: /memories/users/u1/ is empty.')
      expect(out).toContain('tool: Created /memories/users/u1/profile.md.')
      expect(out).toContain('tool: REJECTED: /memories/org/style.md is read-only.')
      expect(out).toContain('turn 2: complete')
      expect(out).toContain('audit: u1 create /memories/users/u1/profile.md (25 bytes)')
      expect(out).toContain('admin: /memories/users/u1/ (1 file):')
    },
    timeout,
  )

  test(
    'subagent-tool',
    async () => {
      const out = await run('subagent-tool.ts')
      expect(out).toContain('preliminary: {"status":"working","text":"Finding:')
      expect(out).toContain('final: {"status":"done"')
      expect(out).toContain('complete; output tokens incl. the subagent: 15')
    },
    timeout,
  )

  test(
    'json-file-storage',
    async () => {
      const out = await run('json-file-storage.ts')
      expect(out).not.toContain('✗')
      expect(out).toContain('after restart: 4 messages, last turn complete')
    },
    timeout,
  )

  test(
    'custom-fs-adapter',
    async () => {
      const out = await run('custom-fs-adapter.ts')
      expect(out).not.toContain('✗')
      expect(out).toContain('store keys: tenant-1:file:/hello.md')
    },
    timeout,
  )

  test(
    'postgres-storage without DATABASE_URL',
    async () => {
      expect(await run('postgres-storage.ts')).toContain('DATABASE_URL is not set')
    },
    timeout,
  )
})

describe('json-file-storage conformance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eharness-json-test-'))
  afterAll(() => rm(dir, { recursive: true, force: true }))
  const messages = messageAdapterConformance(() => jsonFileMessages(dir), { requireLastId: true })
  for (const c of messages) test(`messages: ${c.name}`, c.run)
  for (const c of stateAdapterConformance(() => jsonFileState(dir))) test(`state: ${c.name}`, c.run)
})

describe('custom-fs-adapter conformance', () => {
  const cases = fileSystemConformance(() => kvFileSystem(mapKeyValueStore()), { requireStat: true })
  for (const c of cases) test(c.name, c.run)
})

const databaseUrl = process.env.DATABASE_URL ?? ''
describe.skipIf(databaseUrl === '')('postgres-storage (DATABASE_URL)', () => {
  const schema = `eharness_test_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
  let db: Awaited<ReturnType<typeof bunSqlPool>>
  beforeAll(async () => {
    db = await bunSqlPool(databaseUrl)
    await db.query(`CREATE SCHEMA ${schema}`)
    await migrate(db, { schema })
  })
  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await db.close()
  })
  const messages = messageAdapterConformance(() => postgresMessages(db, { schema }), {
    requireLastId: true,
  })
  for (const c of messages) test(`messages: ${c.name}`, c.run)
  for (const c of stateAdapterConformance(() => postgresState(db, { schema }))) {
    test(`state: ${c.name}`, c.run)
  }
  test('advisory lock: a second acquire is rejected until release', async () => {
    const lock = postgresLock(db)
    const signal = new AbortController().signal
    const release = await lock.acquire('s', { signal })
    await expect(lock.acquire('s', { signal })).rejects.toThrow('locked elsewhere')
    await release()
    const again = await lock.acquire('s', { signal })
    await again()
  })
  test('the example script passes', async () => {
    const out = await run('postgres-storage.ts', { DATABASE_URL: databaseUrl })
    expect(out).not.toContain('✗')
    expect(out).toContain('advisory lock: second acquire rejected')
    expect(out).toContain('turn: complete; stored messages: 2')
  }, 30_000)
})

describe('README', () => {
  test('the quick start is examples/quick-start.ts', async () => {
    const readme = await readFile(join(root, 'README.md'), 'utf8')
    const example = await readFile(join(root, 'examples/quick-start.ts'), 'utf8')
    const block = readme.match(/## Quick start\n[\s\S]*?```ts\n([\s\S]*?)```/)?.[1]
    const code = example.match(
      /\/\/ --- quick start ---\n([\s\S]*?)\/\/ --- end quick start ---/,
    )?.[1]
    expect(block).toBeDefined()
    expect(code).toBeDefined()
    const readmeModel =
      "  model: 'anthropic/claude-sonnet-4.6', // AI Gateway id or any AI SDK model"
    expect(block).toBe(code?.replace('  model: demoModel,', readmeModel))
  })
})
