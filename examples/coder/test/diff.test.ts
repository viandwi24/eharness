import { describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scriptedModel } from 'eharness/testing'
import { agentEditedPaths, computeDiff } from '../src/app/diff.ts'
import type { CoderMessage } from '../src/contracts.ts'
import { gitInit, makeController, tempDir, writeFiles } from './helpers.ts'

const toRoot = (p: string): string | null => (p.startsWith('/@') ? null : p.replace(/^\//, ''))

const changes = (...items: Array<[string, string]>): CoderMessage[] => [
  {
    id: 'm1',
    role: 'assistant',
    parts: items.map(([path, action]) => ({
      type: 'data-filesystem.change',
      data: { path, action, version: 'v' },
    })),
  } as unknown as CoderMessage,
]

async function git(root: string, ...args: string[]): Promise<void> {
  await Bun.spawn(['git', ...args], { cwd: root, stdout: 'ignore', stderr: 'ignore' }).exited
}

describe('computeDiff', () => {
  test('modified, staged, deleted, untracked and binary files with counts and agent flag', async () => {
    const root = await tempDir()
    await writeFiles(root, {
      'a.txt': 'one\ntwo\nthree\n',
      'b.txt': 'keep\n',
      'gone.txt': 'bye\n',
      'staged.txt': 'x\n',
    })
    await writeFile(join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3]))
    await gitInit(root)
    await writeFile(join(root, 'a.txt'), 'one\nTWO\nthree\nfour\n')
    await rm(join(root, 'gone.txt'))
    await writeFile(join(root, 'staged.txt'), 'x\ny\n')
    await git(root, 'add', 'staged.txt')
    await writeFiles(root, { 'new/dir/file.ts': 'export const a = 1\n' })
    await writeFile(join(root, 'bin.dat'), Buffer.from([0, 9, 9, 9, 9]))
    const result = await computeDiff({
      root,
      messages: changes(['/a.txt', 'edit'], ['/new/dir/file.ts', 'create']),
      toRoot,
    })
    expect(result.git).toBe(true)
    expect(result.branch).toBe('main')
    const by = Object.fromEntries(result.files.map((f) => [f.path, f]))
    expect(by['a.txt']).toMatchObject({
      status: 'modified',
      added: 2,
      removed: 1,
      editedByAgent: true,
    })
    expect(by['a.txt']?.patch).toContain('+TWO')
    expect(by['gone.txt']).toMatchObject({
      status: 'deleted',
      added: 0,
      removed: 1,
      editedByAgent: false,
    })
    expect(by['staged.txt']).toMatchObject({ added: 1, removed: 0 })
    expect(by['new/dir/file.ts']).toMatchObject({
      status: 'untracked',
      added: 1,
      editedByAgent: true,
      binary: false,
    })
    expect(by['new/dir/file.ts']?.patch).toContain('+export const a = 1')
    expect(by['bin.dat']).toMatchObject({ binary: true, patch: '' })
    expect(by['b.txt']).toBeUndefined()
  })

  test('a clean tree has no files; an untracked file over 200 KB is truncated', async () => {
    const root = await tempDir()
    await writeFiles(root, { 'a.txt': 'x\n' })
    await gitInit(root)
    expect((await computeDiff({ root, messages: [], toRoot })).files).toEqual([])
    await writeFile(join(root, 'big.txt'), `${'line\n'.repeat(80_000)}`)
    const { files } = await computeDiff({ root, messages: [], toRoot })
    expect(files[0]?.path).toBe('big.txt')
    expect(files[0]?.patch.length).toBeLessThan(205 * 1024)
    expect(files[0]?.patch).toContain('truncated')
  })

  test('a project below the repository top uses project-relative paths', async () => {
    const top = await tempDir()
    await writeFiles(top, { 'sub/a.txt': 'a\n', 'outside.txt': 'o\n' })
    await gitInit(top)
    await writeFile(join(top, 'sub/a.txt'), 'a\nb\n')
    await writeFile(join(top, 'outside.txt'), 'o\nchanged\n')
    const result = await computeDiff({ root: join(top, 'sub'), messages: [], toRoot })
    expect(result.files.map((f) => f.path)).toEqual(['a.txt'])
    expect(result.files[0]).toMatchObject({ added: 1, removed: 0 })
  })

  test('a repository without commits lists staged and untracked files', async () => {
    const root = await tempDir()
    await Bun.spawn(['git', 'init', '-q', '-b', 'main'], { cwd: root }).exited
    await writeFiles(root, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
    await git(root, 'add', 'a.txt')
    const result = await computeDiff({ root, messages: [], toRoot })
    const by = Object.fromEntries(result.files.map((f) => [f.path, f]))
    expect(by['a.txt']).toMatchObject({ status: 'added', added: 1 })
    expect(by['b.txt']?.status).toBe('untracked')
  })

  test('not a git repository: the files the agent edited, as additions', async () => {
    const root = await tempDir()
    await mkdir(join(root, 'src'))
    await writeFiles(root, { 'src/a.ts': 'const a = 1\n', 'untouched.txt': 'x\n' })
    const result = await computeDiff({
      root,
      messages: changes(['/src/a.ts', 'create'], ['/old.txt', 'delete'], ['/@dirs/x/f.ts', 'edit']),
      toRoot,
    })
    expect(result.git).toBe(false)
    expect(result.files.map((f) => [f.path, f.status, f.added])).toEqual([
      ['src/a.ts', 'added', 1],
      ['old.txt', 'deleted', 0],
    ])
    expect(result.files[0]?.editedByAgent).toBe(true)
  })

  test('agentEditedPaths keeps the last action per file', () => {
    const map = agentEditedPaths(changes(['/a', 'create'], ['/a', 'delete']), toRoot)
    expect([...map]).toEqual([['a', 'delete']])
  })

  test('the controller maps virtual paths of the session messages', async () => {
    const { controller, root } = await makeController({
      model: scriptedModel([
        { toolCalls: [{ toolName: 'write_file', input: { path: '/made.txt', content: 'hi\n' } }] },
        { text: 'done' },
      ]),
      files: { 'a.txt': 'a\n' },
      flags: { permissionMode: 'acceptEdits' },
    })
    await gitInit(root)
    await controller.run('make a file', {
      onRun: (run) => void run.stream.cancel().catch(() => {}),
    })
    const diff = await controller.diff()
    expect(diff.git).toBe(true)
    const made = diff.files.find((f) => f.path === 'made.txt')
    expect(made).toMatchObject({ status: 'untracked', editedByAgent: true })
  })
})
