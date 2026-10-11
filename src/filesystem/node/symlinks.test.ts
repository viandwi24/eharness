/** K-09: symlink-aware permission decisions, O_NOFOLLOW reads and checkpoint-store ids. */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPermissionEngine } from '../../permissions/engine.ts'
import { nodeCheckpointStore } from './checkpoint-store.ts'
import { diskFs } from './disk-fs.ts'
import { realpathLoose } from './guard.ts'

const dirs: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'eh-k09-'))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

describe('permission decisions follow symlinks (P5-4)', () => {
  test('g -> .git and x -> .env keep their protection', async () => {
    const root = temp()
    mkdirSync(join(root, '.git/hooks'), { recursive: true })
    writeFileSync(join(root, '.env'), 'SECRET=1')
    symlinkSync('.git', join(root, 'g'))
    symlinkSync('.env', join(root, 'x'))
    const engine = createPermissionEngine({
      roots: () => [{ virtual: '/', real: root }],
      mode: 'acceptEdits',
      realpath: realpathLoose,
    })
    const edit = (path: string) => ({ toolName: 'edit_file', input: { path } })
    expect((await engine.decideAsync(edit('/g/hooks/pre-commit'))).status).toBe('user-approval')
    expect((await engine.decideAsync(edit('/ok.ts'))).status).toBe('approved')
    expect(
      (await engine.decideAsync({ toolName: 'read_file', input: { path: '/x' } })).status,
    ).toBe('user-approval')
    expect(
      (await engine.decideAsync({ toolName: 'bash', input: { command: 'cat x' } })).status,
    ).toBe('user-approval')
    expect(realpathSync(join(root, 'x'))).toBe(join(realpathSync(root), '.env'))
  })
})

describe('diskFs containment', () => {
  test('a symlink to the outside is rejected on read and write', async () => {
    const root = temp()
    const outside = temp()
    writeFileSync(join(outside, 'secret.txt'), 'nope')
    symlinkSync(outside, join(root, 'link'))
    const fs = diskFs({ root })
    await expect(fs.read('/link/secret.txt')).rejects.toThrow('outside the workspace')
    await expect(fs.write('/link/new.txt', 'x')).rejects.toThrow('outside the workspace')
  })
})

describe('nodeCheckpointStore ids (P5-16)', () => {
  test("'..', '.' and '' never leave the store directory", async () => {
    const base = temp()
    const dir = join(base, 'store')
    const store = nodeCheckpointStore({ dir })
    for (const id of ['..', '.', '']) {
      await store.delete(id)
      expect(await store.list(id)).toEqual([])
    }
    expect(realpathSync(base)).toBeTruthy()
    mkdirSync(join(base, 'keep'))
    await store.delete('..') // must not remove the parent
    expect(() => realpathSync(join(base, 'keep'))).not.toThrow()
  })
})
