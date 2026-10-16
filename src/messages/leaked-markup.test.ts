import { describe, expect, test } from 'bun:test'
import type { UIMessageChunk } from 'ai'
import { createLeakFilter, stripLeakedToolMarkup } from './leaked-markup.ts'

const TAIL = 'url" string="true">https://www.youtube.com/@ExampleChannel'

describe('stripLeakedToolMarkup', () => {
  test('production fragment', () => expect(stripLeakedToolMarkup(TAIL)).toBe(''))
  test('DSML block', () => {
    const t =
      'Opening it.\n<｜DSML｜tool_calls><｜DSML｜invoke name="x"><｜DSML｜parameter name="url" string="true">u</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>'
    expect(stripLeakedToolMarkup(t)).toBe('Opening it.')
  })
  test('other shapes', () => {
    expect(stripLeakedToolMarkup('a <tool_call>{"n":1}</tool_call> b')).toBe('a  b')
    expect(stripLeakedToolMarkup('<|tool▁calls▁begin|>x<|tool▁calls▁end|>')).toBe('')
    expect(stripLeakedToolMarkup('hi <｜DSML｜invoke name="x">')).toBe('hi')
    expect(
      stripLeakedToolMarkup('<function_calls><invoke name="a"></invoke></function_calls>'),
    ).toBe('')
  })
  test('false positives untouched', () => {
    const fenced = 'Example:\n```xml\n<tool_call>{"a":1}</tool_call>\n```'
    expect(stripLeakedToolMarkup(fenced)).toBe(fenced)
    for (const s of [
      'Use the <tool_call> tag in Qwen.',
      'Set url" string="true"> in prose? no: see docs',
      'a < b and "x"',
      'plain',
    ]) {
      expect(stripLeakedToolMarkup(s)).toBe(s)
    }
  })
})

describe('createLeakFilter', () => {
  const run = (chunks: UIMessageChunk[]): UIMessageChunk[] => {
    const f = createLeakFilter()
    return [...chunks.flatMap((c) => f.push(c)), ...f.flush()]
  }
  const text = (id: string, ...deltas: string[]): UIMessageChunk[] => [
    { type: 'text-start', id },
    ...deltas.map((delta) => ({ type: 'text-delta', id, delta }) as UIMessageChunk),
    { type: 'text-end', id },
  ]
  test('drops the leaked part, keeps order of the rest', () => {
    const call = { type: 'tool-input-start', toolCallId: 'c', toolName: 'p' } as UIMessageChunk
    const out = run([...text('t', 'url" string', '="true">https://x.y'), call])
    expect(out).toEqual([call])
  })
  test('normal text streams unchanged', () => {
    const chunks = text('t', 'Hello there, this is', ' a normal answer.')
    expect(run(chunks)).toEqual(chunks)
  })
  test('short text passes', () => {
    const chunks = text('t', 'ok')
    expect(run(chunks)).toEqual(chunks)
  })
})
