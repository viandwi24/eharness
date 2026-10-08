/** The `glob` and `request_directory_access` tools. */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CoderConfig, Workspace } from '../src/contracts.ts'
import { createGlobTool, createWorkspace } from '../src/workspace/index.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function makeWorkspace(): Promise<{ ws: Workspace; root: string; base: string }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'coder-glob-')))
  dirs.push(base)
  const root = join(base, 'project')
  const data = join(base, 'data')
  await mkdir(root)
  const ws = await createWorkspace({
    root,
    projectDataDir: data,
    additionalDirectories: [],
  } as unknown as CoderConfig)
  return { ws, root, base }
}

async function run(ws: Workspace, input: { pattern: string; path?: string }): Promise<string> {
  const t = createGlobTool(ws)
  return (await t.execute?.(input, { toolCallId: 't', messages: [], context: {} })) as string
}

describe('glob tool', () => {
  test('newest first, ignored paths excluded, virtual paths', async () => {
    const { ws, root } = await makeWorkspace()
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'node_modules/p'), { recursive: true })
    await mkdir(join(root, 'dist'))
    await writeFile(join(root, '.gitignore'), 'dist/\n')
    await writeFile(join(root, 'src/old.ts'), '')
    await writeFile(join(root, 'src/new.ts'), '')
    await writeFile(join(root, 'src/mid.ts'), '')
    await writeFile(join(root, 'node_modules/p/i.ts'), '')
    await writeFile(join(root, 'dist/o.ts'), '')
    await utimes(join(root, 'src/old.ts'), 1000, 1000)
    await utimes(join(root, 'src/mid.ts'), 2000, 2000)
    await utimes(join(root, 'src/new.ts'), 3000, 3000)
    expect(await run(ws, { pattern: '**/*.ts' })).toBe('/src/new.ts\n/src/mid.ts\n/src/old.ts')
    expect(await run(ws, { pattern: '*.ts', path: '/src/' })).toBe(
      '/src/new.ts\n/src/mid.ts\n/src/old.ts',
    )
  })

  test('caps at 200 with a message', async () => {
    const { ws, root } = await makeWorkspace()
    await Promise.all(
      Array.from({ length: 205 }, (_, i) =>
        writeFile(join(root, `f${String(i).padStart(3, '0')}.txt`), ''),
      ),
    )
    const lines = (await run(ws, { pattern: '*.txt' })).split('\n')
    expect(lines).toHaveLength(201)
    expect(lines[200]).toBe('(Showing 200 of 205 matches; narrow the pattern.)')
  })

  test('No files match., and ERROR for bad patterns or paths', async () => {
    const { ws, root } = await makeWorkspace()
    await writeFile(join(root, 'a.txt'), '')
    expect(await run(ws, { pattern: '*.zzz' })).toBe('No files match.')
    expect(await run(ws, { pattern: '../*.txt' })).toStartWith('ERROR:')
    expect(await run(ws, { pattern: 'a/../../*.txt' })).toStartWith('ERROR:')
    expect(await run(ws, { pattern: '/etc/*' })).toStartWith('ERROR:')
    expect(await run(ws, { pattern: '*', path: '/../x' })).toStartWith('ERROR:')
    expect(await run(ws, { pattern: '*', path: 'relative' })).toStartWith('ERROR:')
  })
})

describe('glob containment', () => {
  test('rejects backslash, .., absolute and ~ patterns', async () => {
    const { ws, root, base } = await makeWorkspace()
    await writeFile(join(base, 'secret.txt'), 's')
    await writeFile(join(root, 'a.txt'), 'a')
    for (const pattern of ['..\\/*', '..\\/..\\/*', '../*', 'a/../../*', '/etc/*', '~/x', 'a\\b']) {
      expect(await run(ws, { pattern })).toStartWith('ERROR:')
    }
    expect(await run(ws, { pattern: '*.txt' })).toBe('/a.txt')
  })

  test('symlinks leaving the mount are not listed', async () => {
    const { ws, root, base } = await makeWorkspace()
    await mkdir(join(base, 'outside'))
    await writeFile(join(base, 'outside/leak.txt'), 'x')
    await symlink(join(base, 'outside'), join(root, 'link'))
    await symlink(join(base, 'outside/leak.txt'), join(root, 'leak-link.txt'))
    await writeFile(join(root, 'ok.txt'), 'ok')
    const out = await run(ws, { pattern: '**/*.txt' })
    expect(out).toContain('/ok.txt')
    expect(out).not.toContain('leak')
  })
})
