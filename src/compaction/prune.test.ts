import { describe, expect, test } from 'bun:test'
import type { ModelMessage, ToolResultPart } from 'ai'
import { sanitizeModelMessages } from '../messages/sanitize.ts'
import { TOOL_OUTPUT_PRUNED } from '../messages/texts.ts'
import {
  DEFAULT_PRUNE_KEEP_TURNS,
  DEFAULT_PRUNE_MIN_CHARS,
  PRUNE_MEDIA_CHARS,
  prunableChars,
  pruneMessages,
  pruneTurns,
  type ResolvedPrune,
  resolvePrune,
} from './prune.ts'

const defaults = resolvePrune({ prune: {} }) as ResolvedPrune

/** One completed turn: user → assistant(tool-call) → tool(tool-result) → assistant text. */
function turn(tag: string, output: ToolResultPart['output'], toolName = 'read'): ModelMessage[] {
  const toolCallId = `call-${tag}`
  return [
    { role: 'user', content: [{ type: 'text', text: `Q ${tag}` }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId, toolName, input: { tag } }],
    },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName, output }] },
    { role: 'assistant', content: [{ type: 'text', text: `A ${tag}` }] },
  ]
}

const text = (n: number, c = 'y'): ToolResultPart['output'] => ({
  type: 'text',
  value: c.repeat(n),
})

function results(messages: readonly ModelMessage[]): ToolResultPart[] {
  const out: ToolResultPart[] = []
  for (const m of messages) {
    if (m.role !== 'tool') continue
    for (const p of m.content) if (p.type === 'tool-result') out.push(p)
  }
  return out
}

describe('resolvePrune', () => {
  test('off by default; {} turns it on with the defaults', () => {
    expect(resolvePrune(undefined)).toBeUndefined()
    expect(resolvePrune(false)).toBeUndefined()
    expect(resolvePrune({})).toBeUndefined()
    expect(resolvePrune({ prune: false })).toBeUndefined()
    expect(defaults.keepTurns).toBe(DEFAULT_PRUNE_KEEP_TURNS)
    expect(defaults.minChars).toBe(DEFAULT_PRUNE_MIN_CHARS)
    expect(DEFAULT_PRUNE_KEEP_TURNS).toBe(2)
    expect(DEFAULT_PRUNE_MIN_CHARS).toBe(2_000)
  })
})

describe('pruneMessages', () => {
  test('replaces large outputs with the default placeholder; keeps ids, names and inputs', () => {
    const input = turn('1', text(3_000))
    const { messages, stats } = pruneMessages(input, defaults)
    const [result] = results(messages)
    const placeholder = TOOL_OUTPUT_PRUNED.replace('{tool}', 'read').replace('{n}', '3000')
    expect(result?.output).toEqual({ type: 'text', value: placeholder })
    expect(placeholder).toBe('[output of read pruned: 3000 chars]')
    expect(result?.toolCallId).toBe('call-1')
    expect(result?.toolName).toBe('read')
    expect(messages[1]).toBe(input[1] as ModelMessage) // the call is untouched
    expect(stats).toEqual({ outputs: 1, chars: 3_000 - placeholder.length })
    // the input is not mutated
    expect(results(input)[0]?.output).toEqual(text(3_000))
  })

  test('minChars: only outputs above the threshold; json measured serialized', () => {
    expect(pruneMessages(turn('1', text(2_000)), defaults).stats.outputs).toBe(0)
    expect(pruneMessages(turn('1', text(2_001)), defaults).stats.outputs).toBe(1)
    const small = { ...defaults, minChars: 10 }
    expect(
      pruneMessages(turn('1', { type: 'json', value: { a: 'xxxxxxx' } }), small).stats,
    ).toEqual(expect.objectContaining({ outputs: 1 }))
    expect(prunableChars({ type: 'json', value: { a: 'x' } })).toBe(9)
    expect(
      prunableChars({
        type: 'content',
        value: [
          { type: 'text', text: 'abc' },
          { type: 'text', text: 'de' },
        ],
      }),
    ).toBe(5)
  })

  test('media is measured by a fixed size, not by its base64 length', () => {
    const huge = 'A'.repeat(1_000_000)
    expect(
      prunableChars({
        type: 'content',
        value: [
          { type: 'text', text: 'abc' },
          { type: 'image-data', data: huge, mediaType: 'image/png' },
        ],
      }),
    ).toBe(3 + PRUNE_MEDIA_CHARS)
    expect(
      prunableChars({
        type: 'json',
        value: {
          type: 'media-ref',
          path: '/a',
          version: 'v',
          mediaType: 'image/png',
          bytes: 9,
          text: 'ab',
        },
      }),
    ).toBe(2 + PRUNE_MEDIA_CHARS)
    const pruned = pruneMessages(
      turn('1', {
        type: 'content',
        value: [{ type: 'image-data', data: huge, mediaType: 'image/png' }],
      } as ToolResultPart['output']),
      defaults,
    )
    expect(pruned.stats.outputs).toBe(1)
    expect(pruned.stats.chars).toBeLessThan(PRUNE_MEDIA_CHARS)
  })

  test('errors and execution-denied are never pruned', () => {
    const big = 'e'.repeat(5_000)
    for (const output of [
      { type: 'error-text', value: big },
      { type: 'error-json', value: { big } },
      { type: 'execution-denied', reason: big },
    ] as ToolResultPart['output'][]) {
      const input = turn('1', output)
      const { messages, stats } = pruneMessages(input, defaults)
      expect(stats.outputs).toBe(0)
      expect(messages).toEqual(input)
    }
  })

  test('exclude: final tool names are never pruned', () => {
    const prune = resolvePrune({ prune: { exclude: ['read'] } }) as ResolvedPrune
    expect(pruneMessages(turn('1', text(5_000)), prune).stats.outputs).toBe(0)
    expect(pruneMessages(turn('1', text(5_000), 'grep'), prune).stats.outputs).toBe(1)
  })

  test('replaceWith receives the AI SDK ToolResultPart and its text is used', () => {
    const seen: ToolResultPart[] = []
    const prune = resolvePrune({
      prune: {
        replaceWith: (part) => {
          seen.push(part)
          return `<${part.toolName}:${part.toolCallId} elided>`
        },
      },
    }) as ResolvedPrune
    const { messages } = pruneMessages(turn('1', text(3_000)), prune)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      type: 'tool-result',
      toolCallId: 'call-1',
      toolName: 'read',
      output: text(3_000),
    })
    expect(results(messages)[0]?.output).toEqual({ type: 'text', value: '<read:call-1 elided>' })
  })

  test('a throwing or non-string replaceWith falls back to the default placeholder', () => {
    for (const replaceWith of [
      () => {
        throw new Error('boom')
      },
      () => 42 as unknown as string,
    ]) {
      const prune = resolvePrune({ prune: { replaceWith } }) as ResolvedPrune
      const { messages } = pruneMessages(turn('1', text(3_000)), prune)
      expect(results(messages)[0]?.output).toEqual({
        type: 'text',
        value: '[output of read pruned: 3000 chars]',
      })
    }
  })

  test('provider-executed results inside assistant messages are left alone', () => {
    const input: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'p1',
            toolName: 'web_search',
            input: {},
            providerExecuted: true,
          },
          { type: 'tool-result', toolCallId: 'p1', toolName: 'web_search', output: text(9_000) },
        ],
      },
    ]
    expect(pruneMessages(input, defaults).messages).toEqual(input)
  })
})

describe('pruneTurns', () => {
  const turns = Array.from({ length: 5 }, (_, i) => turn(String(i), text(3_000)))

  test('keepTurns: the newest completed turns are never pruned', () => {
    const { turns: out, stats } = pruneTurns(turns, defaults)
    expect(stats.outputs).toBe(3)
    for (const [i, t] of out.entries()) {
      const output = results(t)[0]?.output as { value: string } | undefined
      const pruned = output?.value.startsWith('[output of')
      expect(pruned).toBe(i < 3)
    }
    // kept turns are returned as is (same objects: byte-identical prefix)
    expect(out[3]).toBe(turns[3] as ModelMessage[])
    expect(out[4]).toBe(turns[4] as ModelMessage[])
    const none = resolvePrune({ prune: { keepTurns: 10 } }) as ResolvedPrune
    expect(pruneTurns(turns, none).stats.outputs).toBe(0)
    const all = resolvePrune({ prune: { keepTurns: 0 } }) as ResolvedPrune
    expect(pruneTurns(turns, all).stats.outputs).toBe(5)
  })

  test('deterministic: same input twice → identical output, independent of the clock', () => {
    const a = JSON.stringify(pruneTurns(turns, defaults).turns)
    const realNow = Date.now
    Date.now = () => realNow() + 86_400_000
    try {
      expect(JSON.stringify(pruneTurns(turns, defaults).turns)).toBe(a)
    } finally {
      Date.now = realNow
    }
  })

  test('cache-stable: one more completed turn only changes the newly aged turn', () => {
    const before = pruneTurns(turns.slice(0, 4), defaults).turns
    const after = pruneTurns(turns, defaults).turns
    // turns 0..1 identical, turn 2 newly aged, turn 3 still kept
    expect(JSON.stringify(after.slice(0, 2))).toBe(JSON.stringify(before.slice(0, 2)))
    expect(JSON.stringify(after[2])).not.toBe(JSON.stringify(before[2]))
    expect(JSON.stringify(after[3])).toBe(JSON.stringify(before[3]))
  })

  test('property: pairs never split (sanitize finds nothing to fix) over random views', () => {
    let seed = 42
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    const outputs = (): ToolResultPart['output'] => {
      const r = random()
      if (r < 0.4) return text(Math.floor(random() * 6_000))
      if (r < 0.6)
        return { type: 'json', value: { data: 'z'.repeat(Math.floor(random() * 5_000)) } }
      if (r < 0.75) return { type: 'error-text', value: 'x'.repeat(Math.floor(random() * 5_000)) }
      if (r < 0.85) return { type: 'execution-denied', reason: 'no' }
      return {
        type: 'content',
        value: [{ type: 'text', text: 'c'.repeat(Math.floor(random() * 5_000)) }],
      }
    }
    for (let run = 0; run < 200; run++) {
      const count = 1 + Math.floor(random() * 8)
      const view: ModelMessage[][] = []
      for (let t = 0; t < count; t++) {
        const calls = 1 + Math.floor(random() * 3)
        const names = ['read', 'grep', 'bash']
        const msgs: ModelMessage[] = [{ role: 'user', content: `Q${t}` }]
        const ids = Array.from({ length: calls }, (_, i) => `c-${run}-${t}-${i}`)
        msgs.push({
          role: 'assistant',
          content: ids.map((toolCallId, i) => ({
            type: 'tool-call' as const,
            toolCallId,
            toolName: names[i % 3] as string,
            input: { i },
          })),
        })
        msgs.push({
          role: 'tool',
          content: ids.map((toolCallId, i) => ({
            type: 'tool-result' as const,
            toolCallId,
            toolName: names[i % 3] as string,
            output: outputs(),
          })),
        })
        view.push(msgs)
      }
      const prune = resolvePrune({
        prune: {
          keepTurns: Math.floor(random() * 3),
          minChars: Math.floor(random() * 3_000),
          exclude: random() < 0.3 ? ['grep'] : [],
        },
      }) as ResolvedPrune
      const flat = pruneTurns(view, prune).turns.flat()
      expect(sanitizeModelMessages(flat)).toEqual(flat)
      const calls = flat.flatMap((m) =>
        m.role === 'assistant' && Array.isArray(m.content)
          ? m.content.filter((p) => p.type === 'tool-call').map((p) => p.toolCallId)
          : [],
      )
      expect(results(flat).map((r) => r.toolCallId)).toEqual(calls)
      expect(flat.length).toBe(view.flat().length)
    }
  })
})
