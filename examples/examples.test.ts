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
      expect(out).toContain('input (plugin:todos): 2 todos are still open')
      expect(out).toContain('todos part: ✓ outline, ✓ draft')
      expect(out).toContain('turn complete: 0 todos open')
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
