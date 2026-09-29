import { describe, expect, test } from 'bun:test'
import { fileSystemConformance } from '../testing/file-system.conformance.ts'
import { memoryFs } from './memory.ts'
import type { FileSystem } from './types.ts'
import { contentVersion } from './version.ts'

describe('memoryFs() conformance', () => {
  for (const c of fileSystemConformance(() => memoryFs(), {
    requireStat: true,
    requireGrep: true,
  })) {
    test(c.name, c.run)
  }
})

describe('memoryFs()', () => {
  test('normalizes seed paths and versions seed content', async () => {
    const fs = memoryFs({ 'src//a.md': 'a', '/b.md': 'ø' })
    expect((await fs.list()).map((f) => [f.path, f.size])).toEqual([
      ['/b.md', 2],
      ['/src/a.md', 1],
    ])
    expect((await fs.read('/src/a.md'))?.version).toBe(await contentVersion('a'))
    expect(typeof (await fs.stat?.('/b.md'))?.updatedAt).toBe('number')
  })

  test('rejects invalid seeds and non-string content', async () => {
    expect(() => memoryFs({ '/../x': 'a' })).toThrow(TypeError)
    expect(() => memoryFs({ '/a': 1 as unknown as string })).toThrow(TypeError)
    await expect(memoryFs().write('/a', 1 as unknown as string)).rejects.toThrow(TypeError)
  })

  test('two instances never share files', async () => {
    const a = memoryFs()
    const b = memoryFs()
    await a.write('/x.md', 'x')
    expect(await b.read('/x.md')).toBeNull()
  })

  test('grep ignores the lastIndex of global and sticky patterns; maxHits 0 returns nothing', async () => {
    const fs = memoryFs({ '/a.md': 'x\nx\nx' })
    const sticky = /x/gy
    expect((await fs.grep?.(sticky))?.length).toBe(3)
    expect(sticky.lastIndex).toBe(0)
    expect(await fs.grep?.(/x/, { maxHits: 0 })).toEqual([])
    expect((await fs.grep?.(/X/i))?.length).toBe(3)
  })
})

describe('fileSystemConformance catches broken adapters', () => {
  const failing = async (broken: () => FileSystem): Promise<string[]> => {
    const failed: string[] = []
    for (const c of fileSystemConformance(broken)) {
      try {
        await c.run()
      } catch {
        failed.push(c.name)
      }
    }
    return failed
  }

  test('counter versions, ignored ifVersion and unsorted lists fail', async () => {
    let counter = 0
    const counterVersions = (): FileSystem => {
      const fs = memoryFs()
      return {
        ...fs,
        read: async (path) => {
          const entry = await fs.read(path)
          return entry === null ? null : { ...entry, version: `v${counter}` }
        },
        write: async (path, content) => {
          await fs.write(path, content)
          counter++
          return { ok: true, version: `v${counter}` }
        },
      }
    }
    expect(await failing(counterVersions)).toContain('version changes iff the content changes')
    expect(await failing(counterVersions)).toContain(
      'ifVersion null creates only when the file does not exist',
    )

    const unsorted = (): FileSystem => {
      const fs = memoryFs()
      return { ...fs, list: async (prefix) => (await fs.list(prefix)).reverse() }
    }
    expect(await failing(unsorted)).toContain(
      'list is recursive, sorted by path and filtered by prefix',
    )
  })
})
