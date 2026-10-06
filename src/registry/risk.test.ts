import { describe, expect, test } from 'bun:test'
import { toolTraits } from '../index.ts'

describe('toolTraits (spec 11 §3.2)', () => {
  const cases: Array<[string, unknown, ReturnType<typeof toolTraits>]> = [
    ['no metadata', undefined, {}],
    ['null metadata', null, {}],
    ['a non-object', 'read', {}],
    ['app risk', { risk: 'write' }, { risk: 'write' }],
    ['app risk external', { risk: 'external' }, { risk: 'external' }],
    [
      'app risk wins, even lower than the hints',
      { risk: 'read', annotations: { destructiveHint: true, openWorldHint: true } },
      { risk: 'read', hints: { destructiveHint: true, openWorldHint: true } },
    ],
    [
      'destructiveHint → destructive',
      { annotations: { destructiveHint: true } },
      { risk: 'destructive', hints: { destructiveHint: true } },
    ],
    [
      'openWorldHint → external',
      { annotations: { openWorldHint: true } },
      { risk: 'external', hints: { openWorldHint: true } },
    ],
    [
      'destructive > external',
      { annotations: { destructiveHint: true, openWorldHint: true } },
      { risk: 'destructive', hints: { destructiveHint: true, openWorldHint: true } },
    ],
    [
      'readOnlyHint never lowers a destructive hint',
      { annotations: { readOnlyHint: true, destructiveHint: true } },
      { risk: 'destructive', hints: { readOnlyHint: true, destructiveHint: true } },
    ],
    [
      'readOnlyHint alone gives no risk (never read)',
      { annotations: { readOnlyHint: true } },
      { hints: { readOnlyHint: true } },
    ],
    [
      'false hints give no risk',
      { annotations: { destructiveHint: false, openWorldHint: false } },
      { hints: { destructiveHint: false, openWorldHint: false } },
    ],
    [
      'idempotentHint is reported, never used for idempotent',
      { annotations: { idempotentHint: true } },
      { hints: { idempotentHint: true } },
    ],
    ['app idempotent', { idempotent: true }, { idempotent: true }],
    [
      'app idempotent false',
      { risk: 'write', idempotent: false },
      { risk: 'write', idempotent: false },
    ],
    ['a non-boolean idempotent is ignored', { idempotent: 'yes' }, {}],
    [
      'invalid risk strings are ignored (hints still apply)',
      { risk: 'Destructive', annotations: { openWorldHint: true } },
      { risk: 'external', hints: { openWorldHint: true } },
    ],
    ['an unknown risk is ignored', { risk: 'safe' }, {}],
    ['a non-string risk is ignored', { risk: 1 }, {}],
    [
      'non-boolean hints and title are dropped',
      { annotations: { title: 'X', destructiveHint: 'true', openWorldHint: 1 } },
      {},
    ],
    ['malformed annotations', { annotations: 'destructive' }, {}],
  ]
  for (const [name, metadata, expected] of cases) {
    test(name, () => {
      expect(toolTraits(metadata)).toEqual(expected)
    })
  }

  test('the hints are a copy of the known keys', () => {
    const annotations = { openWorldHint: true, extra: 1 }
    const traits = toolTraits({ annotations })
    expect(traits.hints).toEqual({ openWorldHint: true })
    expect(traits.hints).not.toBe(annotations as never)
  })
})
