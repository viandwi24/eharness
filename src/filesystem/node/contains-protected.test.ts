import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPermissionEngine } from '../../permissions/engine.ts'
import { nodeContainsProtected, nodeRealpath } from '../node.ts'

let root: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'eh-contains-'))
  await mkdir(join(root, 'src/deep/er'), { recursive: true })
  await mkdir(join(root, 'clean'), { recursive: true })
  await mkdir(join(root, 'app/.git'), { recursive: true })
  await writeFile(join(root, 'src/a.ts'), 'x')
  await writeFile(join(root, 'src/deep/er/.ENV.local'), 'KEY=1')
  await writeFile(join(root, 'clean/b.ts'), 'x')
  await symlink(join(root, 'src'), join(root, 'clean/link'))
})
afterAll(() => rm(root, { recursive: true, force: true }))

describe('nodeContainsProtected', () => {
  test('finds a match at any depth, case-insensitively', async () => {
    expect(await nodeContainsProtected(root, ['**/.env*'])).toBe(true)
    expect(await nodeContainsProtected(join(root, 'src'), ['.env*'])).toBe(true)
  })
  test('no match, missing path and no patterns are false', async () => {
    expect(await nodeContainsProtected(join(root, 'clean'), ['.env*'])).toBe(false)
    expect(await nodeContainsProtected(join(root, 'nope'), ['.env*'])).toBe(false)
    expect(await nodeContainsProtected(root, [])).toBe(false)
  })
  test('symlinks are not followed', async () => {
    expect(await nodeContainsProtected(join(root, 'clean'), ['.env*'])).toBe(false)
  })
  test('a directory pattern and an anchored pattern match', async () => {
    expect(await nodeContainsProtected(root, ['.git'])).toBe(true)
    expect(await nodeContainsProtected(join(root, 'src'), ['deep/er/.env*'])).toBe(true)
  })
  test('a file is tested by its own name', async () => {
    expect(await nodeContainsProtected(join(root, 'src/deep/er/.ENV.local'), ['.env*'])).toBe(true)
    expect(await nodeContainsProtected(join(root, 'src/a.ts'), ['.env*'])).toBe(false)
  })
  test('exceeding a bound fails closed', async () => {
    expect(await nodeContainsProtected(root, ['nothing-here'], { maxEntries: 2 })).toBe(true)
    expect(await nodeContainsProtected(root, ['nothing-here'], { maxDepth: 1 })).toBe(true)
    expect(await nodeContainsProtected(root, ['nothing-here'])).toBe(false)
  })
})

describe('with the permission engine', () => {
  test('grep -r asks where an .env lives and approves where none does', async () => {
    const engine = (dir: string) =>
      createPermissionEngine({
        roots: () => [{ virtual: '/', real: dir }],
        realpath: nodeRealpath,
        containsProtected: nodeContainsProtected,
      })
    const call = (command: string) => ({ toolName: 'bash', input: { command } })
    expect((await engine(root).decideAsync(call('grep -r KEY .'))).status).toBe('user-approval')
    expect((await engine(join(root, 'clean')).decideAsync(call('grep -r KEY .'))).status).toBe(
      'approved',
    )
  })
})
