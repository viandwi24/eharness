import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LspManager } from '../src/lsp/index.ts'
import {
  createLspManager,
  createLspTools,
  encodeMessage,
  FrameParser,
  LspClient,
} from '../src/lsp/index.ts'

const FAKE = join(import.meta.dir, 'fixtures', 'fake-lsp.ts')
const dirs: string[] = []
const managers: LspManager[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.close()))
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function project(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lsp-test-'))
  dirs.push(root)
  await mkdir(join(root, 'src'), { recursive: true })
  const all = { 'src/a.ts': 'class Foo {\n  bar() {}\n}\nconst x: BAD = 1\n', ...files }
  for (const [name, text] of Object.entries(all)) await writeFile(join(root, name), text)
  return root
}

function manager(
  root: string,
  flags: string[] = [],
  extra: Record<string, unknown> = {},
): LspManager {
  const m = createLspManager({
    root,
    servers: { fake: { command: ['bun', FAKE, ...flags], extensions: ['.ts'] } },
    toReal: async (v) => (v.startsWith('/') ? join(root, v) : null),
    toVirtual: (r) => (r.startsWith(root) ? r.slice(root.length) || '/' : null),
    ...extra,
  })
  managers.push(m)
  return m
}

function execTool(t: unknown, input: unknown, _ctx?: unknown): Promise<string> {
  // biome-ignore lint/suspicious/noExplicitAny: calling a tool's execute directly in tests
  return (t as any).execute(input, { toolCallId: 't', messages: [] })
}

describe('framing', () => {
  const a = encodeMessage({ jsonrpc: '2.0', id: 1, result: 'é✓' })
  const b = encodeMessage({ jsonrpc: '2.0', id: 2, result: null })

  test('merged chunks', () => {
    expect(new FrameParser().push(Buffer.concat([a, b]))).toHaveLength(2)
  })
  test('split chunks, byte by byte', () => {
    const parser = new FrameParser()
    const out: unknown[] = []
    for (const byte of Buffer.concat([a, b])) out.push(...parser.push(Uint8Array.of(byte)))
    expect(out).toEqual([
      { jsonrpc: '2.0', id: 1, result: 'é✓' },
      { jsonrpc: '2.0', id: 2, result: null },
    ])
  })
})

describe('client', () => {
  test('request timeout', async () => {
    const root = await project()
    const client = await LspClient.start({
      command: ['bun', FAKE, '--hang-hover'],
      cwd: root,
      rootUri: `file://${root}`,
      requestTimeoutMs: 150,
    })
    await expect(client.request('textDocument/hover', {})).rejects.toThrow(/timed out/)
    await client.stop()
  })

  test('chunky server output still parses', async () => {
    const root = await project()
    const client = await LspClient.start({
      command: ['bun', FAKE, '--chunky'],
      cwd: root,
      rootUri: `file://${root}`,
    })
    expect(client.capabilities).toHaveProperty('hoverProvider')
    await client.stop()
  })

  test('spawn failure rejects', async () => {
    const root = await project()
    await expect(
      LspClient.start({
        command: ['definitely-not-a-binary-xyz'],
        cwd: root,
        rootUri: `file://${root}`,
      }),
    ).rejects.toThrow(/failed to start/)
  })
})

describe('manager + tool', () => {
  test('lazy start, definition, references, hover, symbols, diagnostics', async () => {
    const root = await project()
    const m = manager(root)
    expect(m.status()[0]?.state).toBe('idle')
    const { lsp } = createLspTools(m)
    const run = (input: Record<string, unknown>) =>
      execTool(lsp, input, { toolCallId: 't', messages: [] }) as Promise<string>

    expect(await run({ operation: 'definition', path: '/src/a.ts', line: 4, character: 10 })).toBe(
      '/src/a.ts:1:7  class Foo {',
    )
    expect(m.status()[0]?.state).toBe('running')
    expect(await run({ operation: 'references', path: '/src/a.ts', line: 1, character: 7 })).toBe(
      '/src/a.ts:1:7  class Foo {\n/src/a.ts:2:1  bar() {}',
    )
    const hover = await run({ operation: 'hover', path: '/src/a.ts', line: 1, character: 7 })
    expect(hover).toContain('const foo: number')
    expect(hover).toContain('config-replied=true')
    expect(await run({ operation: 'symbols', path: '/src/a.ts' })).toBe(
      'Class Foo  :1\n  Method bar  :2',
    )
    expect(await run({ operation: 'diagnostics', path: '/src/a.ts' })).toBe(
      '/src/a.ts:4:10 error BAD is not allowed (fake 1234)',
    )
    expect(await run({ operation: 'workspace_symbols', query: 'Foo' })).toBe(
      'Class Foo (in mod)  /src/a.ts:1',
    )
  })

  test('didChange when the file changed on disk', async () => {
    const root = await project()
    const m = manager(root)
    const { lsp } = createLspTools(m)
    const run = (input: Record<string, unknown>) =>
      execTool(lsp, input, { toolCallId: 't', messages: [] }) as Promise<string>
    expect(await run({ operation: 'diagnostics', path: '/src/a.ts' })).toContain('BAD')
    await writeFile(join(root, 'src/a.ts'), 'const ok = 1\n')
    expect(await run({ operation: 'diagnostics', path: '/src/a.ts' })).toBe(
      'No diagnostics for /src/a.ts.',
    )
    const hover = await run({ operation: 'hover', path: '/src/a.ts', line: 1, character: 1 })
    expect(hover).toContain('v=13')
  })

  test('errors: no server, out of range, missing args, outside workspace', async () => {
    const root = await project({ 'notes.md': '# hi\n' })
    const m = manager(root)
    const { lsp } = createLspTools(m)
    const run = (input: Record<string, unknown>) =>
      execTool(lsp, input, { toolCallId: 't', messages: [] }) as Promise<string>
    expect(await run({ operation: 'hover', path: '/notes.md', line: 1, character: 1 })).toMatch(
      /^ERROR: no language server configured for "\.md" files/,
    )
    expect(await run({ operation: 'hover', path: '/src/a.ts', line: 99, character: 1 })).toMatch(
      /^ERROR: line 99 is out of range/,
    )
    expect(await run({ operation: 'hover', path: '/src/a.ts' })).toMatch(/^ERROR: hover needs/)
    expect(await run({ operation: 'diagnostics', path: 'relative.ts' })).toMatch(
      /^ERROR: path outside/,
    )
    expect(await run({ operation: 'diagnostics', path: '/src/missing.ts' })).toMatch(
      /^ERROR: cannot read/,
    )
  })

  test('no servers configured at all', async () => {
    const root = await project()
    const m = createLspManager({
      root,
      servers: {},
      toReal: async (v) => join(root, v),
      toVirtual: (r) => r,
    })
    managers.push(m)
    if (!m.available) {
      const { lsp } = createLspTools(m)
      const out = await execTool(
        lsp,
        { operation: 'hover', path: '/src/a.ts', line: 1, character: 1 },
        { toolCallId: 't', messages: [] },
      )
      expect(out).toMatch(/^ERROR: no language server configured/)
    }
  })

  test('failing server command reports ERROR and status failed', async () => {
    const root = await project()
    const m = createLspManager({
      root,
      servers: { bad: { command: ['definitely-not-a-binary-xyz'], extensions: ['.ts'] } },
      toReal: async (v) => join(root, v),
      toVirtual: (r) => r,
    })
    managers.push(m)
    const { lsp } = createLspTools(m)
    const out = await execTool(
      lsp,
      { operation: 'diagnostics', path: '/src/a.ts' },
      { toolCallId: 't', messages: [] },
    )
    expect(out).toMatch(/^ERROR: language server "bad" failed to start/)
    expect(m.status()[0]?.state).toBe('failed')
  })

  test('crash then lazy restart once', async () => {
    const root = await project()
    const marker = join(root, 'crashed')
    const m = manager(root, [`--crash-once=${marker}`])
    const { lsp } = createLspTools(m)
    const run = (input: Record<string, unknown>) =>
      execTool(lsp, input, { toolCallId: 't', messages: [] }) as Promise<string>
    const first = await run({ operation: 'hover', path: '/src/a.ts', line: 1, character: 1 })
    expect(first).toMatch(/^ERROR: .*exited/)
    expect(m.status()[0]?.state).toBe('failed')
    const second = await run({ operation: 'hover', path: '/src/a.ts', line: 1, character: 1 })
    expect(second).toContain('const foo: number')
    expect(m.status()[0]?.state).toBe('running')
  })

  test('second crash is not restarted again', async () => {
    const root = await project()
    const m = manager(root, ['--crash-once=/nonexistent-dir/never'])
    const { lsp } = createLspTools(m)
    const run = () =>
      execTool(
        lsp,
        { operation: 'hover', path: '/src/a.ts', line: 1, character: 1 },
        { toolCallId: 't', messages: [] },
      ) as Promise<string>
    // every hover crashes the server (the marker cannot be created)
    await run()
    await run() // restart, crashes again
    expect(await run()).toMatch(/^ERROR: .*already restarted once/)
  })

  test('close leaves no process behind', async () => {
    const root = await project()
    const m = manager(root)
    await m.diagnostics('/src/a.ts')
    expect(Bun.spawnSync(['pgrep', '-f', FAKE]).stdout.toString().trim()).not.toBe('')
    await m.close()
    const ps = Bun.spawnSync(['pgrep', '-f', FAKE])
    expect(ps.stdout.toString().trim()).toBe('')
    expect(existsSync(root)).toBe(true)
  })
})
