/** Path containment helpers and ignore rules. */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGuard, isInside, loadIgnoreRules, realpathLoose } from '../src/workspace/guard.ts'

const dirs: string[] = []
async function temp(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'coder-guard-')))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('isInside', () => {
  test('root, children and look-alike siblings', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true)
    expect(isInside('/a/b', '/a/b/c')).toBe(true)
    expect(isInside('/a/b', '/a/bc')).toBe(false)
    expect(isInside('/a/b', '/a')).toBe(false)
  })
})

describe('realpathLoose', () => {
  test('resolves non-existing tails below the real parent', async () => {
    const root = await temp()
    expect(await realpathLoose(join(root, 'x', 'y', 'z.txt'))).toBe(join(root, 'x', 'y', 'z.txt'))
  })
})

describe('createGuard', () => {
  test('resolves virtual paths below the root', async () => {
    const root = await temp()
    const guard = createGuard(root)
    expect(await guard.resolve('/')).toBe(root)
    expect(await guard.resolve('/a/./b//c')).toBe(join(root, 'a/b/c'))
  })

  test('rejects relative paths, "..", NUL and symlink escapes', async () => {
    const root = await temp()
    const outside = await temp()
    await symlink(outside, join(root, 'out'))
    await mkdir(join(root, 'dir'))
    await symlink(join(root, 'dir'), join(root, 'inner'))
    const guard = createGuard(root)
    for (const bad of ['rel', '/a/../b', '/..', '/a\u0000b', '/out', '/out/new.txt']) {
      await expect(guard.resolve(bad)).rejects.toThrow('path outside the workspace')
    }
    expect(await guard.resolve('/inner/f.txt')).toBe(join(root, 'dir/f.txt'))
  })
})

describe('loadIgnoreRules', () => {
  test('.git and node_modules always, root .gitignore applied', async () => {
    const root = await temp()
    await writeFile(join(root, '.gitignore'), 'dist/\n*.log\n!keep.log\n')
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'sub/.gitignore'), 'nested.txt\n')
    const rules = await loadIgnoreRules(root)
    expect(rules.isHidden('.git', true)).toBe(true)
    expect(rules.isHidden('.git/config', false)).toBe(true)
    expect(rules.isHidden('a/node_modules/x.js', false)).toBe(true)
    expect(rules.isHidden('dist', true)).toBe(true)
    expect(rules.isHidden('dist/a.js', false)).toBe(true)
    expect(rules.isHidden('x.log', false)).toBe(true)
    expect(rules.isHidden('keep.log', false)).toBe(false)
    expect(rules.isHidden('src/a.ts', false)).toBe(false)
    expect(rules.isHidden('sub/nested.txt', false)).toBe(false) // nested .gitignore not applied
    expect(rules.isHidden('', true)).toBe(false)
    expect(rules.isHidden('../x', false)).toBe(false)
  })

  test('works without a .gitignore', async () => {
    const rules = await loadIgnoreRules(await temp())
    expect(rules.isHidden('a.ts', false)).toBe(false)
    expect(rules.isHidden('node_modules', true)).toBe(true)
  })
})
