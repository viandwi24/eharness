import { afterEach, describe, expect, test } from 'bun:test'
import type { Workspace } from '../src/contracts.ts'
import {
  completeItem,
  completeMention,
  createFileLister,
  folderPaths,
  matchMentions,
  matchPaths,
  mentionAt,
} from '../src/ui/mentions.ts'

describe('mentionAt', () => {
  test('detects the token ending at the cursor', () => {
    expect(mentionAt('look at @src/a', 14)).toEqual({ start: 8, query: 'src/a' })
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionAt('hi @a and', 5)).toEqual({ start: 3, query: 'a' })
  })
  test('ignores emails, finished tokens and mid-word @', () => {
    expect(mentionAt('me@host', 7)).toBeUndefined()
    expect(mentionAt('@a ', 3)).toBeUndefined()
    expect(mentionAt('plain', 5)).toBeUndefined()
    expect(mentionAt('@a@b', 4)).toBeUndefined()
  })
})

describe('matchPaths', () => {
  const paths = ['src/long/path/readme.md', 'README.md', 'a/readme.txt', 'x.ts']
  test('case-insensitive substring, shortest first', () => {
    expect(matchPaths(paths, 'readme')).toEqual([
      'README.md',
      'a/readme.txt',
      'src/long/path/readme.md',
    ])
    expect(matchPaths(paths, 'zzz')).toEqual([])
  })
  test('empty query lists, capped at 8', () => {
    const many = Array.from({ length: 20 }, (_, i) => `f${String(i).padStart(2, '0')}`)
    expect(matchPaths(many, '')).toHaveLength(8)
  })
  test('ties sort alphabetically', () => {
    expect(matchPaths(['b', 'a'], '')).toEqual(['a', 'b'])
  })
})

describe('completeMention', () => {
  test('replaces the token and adds a space', () => {
    expect(completeMention('see @sr now', 4, 7, 'src/a.ts')).toEqual({
      text: 'see @src/a.ts  now',
      cursor: 14,
    })
  })
})

describe('createFileLister', () => {
  const realNow = Date.now
  afterEach(() => {
    Date.now = realNow
  })
  const workspace = (list: () => Promise<Array<{ path: string }>>): Workspace =>
    ({ fs: { list } }) as unknown as Workspace

  test('strips the leading slash and caches for 10 s', async () => {
    let calls = 0
    let now = 1000
    Date.now = () => now
    const lister = createFileLister(
      workspace(async () => {
        calls++
        return [{ path: '/a.ts' }, { path: '/b/c.ts' }]
      }),
    )
    expect(await lister()).toEqual(['a.ts', 'b/c.ts'])
    now += 9_000
    await lister()
    expect(calls).toBe(1)
    now += 2_000
    await lister()
    expect(calls).toBe(2)
  })

  test('concurrent calls share one listing; failures fall back to the cache or empty', async () => {
    let calls = 0
    const lister = createFileLister(
      workspace(async () => {
        calls++
        throw new Error('boom')
      }),
    )
    expect(await Promise.all([lister(), lister()])).toEqual([[], []])
    expect(calls).toBe(1)
  })
})

describe('folders and agents', () => {
  const paths = ['src/ui/a.ts', 'src/b.ts', 'README.md']
  test('folderPaths lists every directory prefix with a trailing slash', () => {
    expect(folderPaths(paths).sort()).toEqual(['src/', 'src/ui/'])
  })
  test('matchMentions mixes files, folders and agents with kinds', () => {
    const items = matchMentions(paths, 'src/ui', ['reviewer'])
    expect(items).toEqual([
      { kind: 'folder', value: 'src/ui/' },
      { kind: 'file', value: 'src/ui/a.ts' },
    ])
    expect(matchMentions(paths, 'agent-rev', ['reviewer'])).toEqual([
      { kind: 'agent', value: 'agent-reviewer' },
    ])
    expect(matchMentions(paths, '', ['x'])).toHaveLength(6)
  })
  test('completeItem keeps the cursor on a folder (no space) and spaces files and agents', () => {
    expect(completeItem('@sr', 0, 3, { kind: 'folder', value: 'src/' })).toEqual({
      text: '@src/',
      cursor: 5,
    })
    expect(completeItem('@a', 0, 2, { kind: 'agent', value: 'agent-x' })).toEqual({
      text: '@agent-x ',
      cursor: 9,
    })
    expect(completeItem('@a', 0, 2, { kind: 'file', value: 'a.ts' }).text).toBe('@a.ts ')
  })
})
