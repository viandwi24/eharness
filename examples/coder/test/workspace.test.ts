/**
 * The workspace wiring of the example (docs/plans/P30-coder-example.md §2.1): `eharness` resolves
 * to the library source, and the library and the example load the same copy of `ai`.
 */
import { describe, expect, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'

const example = join(import.meta.dir, '..')
const repo = join(example, '..', '..')
const resolve = (specifier: string, from: string): string =>
  realpathSync(Bun.resolveSync(specifier, from))

describe('workspace', () => {
  test('eharness resolves to the library source', () => {
    expect(resolve('eharness', example)).toBe(realpathSync(join(repo, 'src', 'index.ts')))
    expect(resolve('eharness/filesystem', example)).toBe(
      realpathSync(join(repo, 'src', 'filesystem', 'index.ts')),
    )
  })

  test('one copy of ai for the library and the example', () => {
    expect(resolve('ai', example)).toBe(resolve('ai', join(repo, 'src')))
  })
})
