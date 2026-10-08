/** The library `glob` tool over the coder workspace: containment holds through the guarded disk fs. */
import { describe, expect, test } from 'bun:test'
import { mkdir, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type ScriptedStep, scriptedModel } from 'eharness/testing'
import type { CoderMessage } from '../src/contracts.ts'
import { makeAgentsEnv, tempDir } from './helpers.ts'

type Input = { pattern: string; path?: string }

/** A project (real directory `root`) and a `run` that calls the library `glob` tool through an agent. */
async function makeWorkspace() {
  let armed: Input | undefined
  const step = (): ScriptedStep =>
    armed === undefined
      ? { text: 'done' }
      : {
          toolCalls: [
            {
              toolName: 'glob',
              input: (() => {
                const i = armed
                armed = undefined
                return i
              })(),
            },
          ],
        }
  const env = await makeAgentsEnv({
    files: {},
    model: scriptedModel(Array.from({ length: 80 }, () => step)),
    flags: { permissionMode: 'bypassPermissions' },
  })
  let n = 0
  const run = async (_ws: unknown, input: Input): Promise<string> => {
    armed = input
    const session = env.agents.main.session(
      `g${n++}`,
    ) as never as import('eharness').HarnessSession<CoderMessage>
    await session.send('glob').result
    const parts = (await session.messages()).flatMap((m) => m.parts) as Array<{
      type: string
      output?: unknown
      errorText?: string
    }>
    const part = parts.find((p) => p.type === 'tool-glob')
    return String(part?.output ?? part?.errorText ?? '')
  }
  const root = env.root
  return { ws: undefined, root, base: await tempDir('coder-outside-'), run }
}

describe('glob tool (library)', () => {
  test('newest first, ignored paths excluded, virtual paths', async () => {
    const { ws, root, run } = await makeWorkspace()
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
    const { ws, root, run } = await makeWorkspace()
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
    const { ws, root, run } = await makeWorkspace()
    await writeFile(join(root, 'a.txt'), '')
    expect(await run(ws, { pattern: '*.zzz' })).toBe('No files match.')
    expect(await run(ws, { pattern: '../*.txt' })).toStartWith('ERROR:')
    expect(await run(ws, { pattern: 'a/../../*.txt' })).toStartWith('ERROR:')
    expect(await run(ws, { pattern: '/etc/*' })).toStartWith('ERROR:')
    expect(await run(ws, { pattern: '*', path: '/../x' })).toStartWith('ERROR:')
    // a relative path is taken from the root, like every file tool path
    expect(await run(ws, { pattern: '*', path: 'relative' })).toBe('No files match.')
  })
})

describe('glob containment', () => {
  test('rejects backslash, .., absolute and ~ patterns', async () => {
    const { ws, root, base, run } = await makeWorkspace()
    await writeFile(join(base, 'secret.txt'), 's')
    await writeFile(join(root, 'a.txt'), 'a')
    for (const pattern of ['..\\/*', '..\\/..\\/*', '../*', 'a/../../*', '/etc/*', '~/x', 'a\\b']) {
      expect(await run(ws, { pattern })).toStartWith('ERROR:')
    }
    expect(await run(ws, { pattern: '*.txt' })).toBe('/a.txt')
  })

  test('symlinks leaving the mount are not listed', async () => {
    const { ws, root, base, run } = await makeWorkspace()
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
