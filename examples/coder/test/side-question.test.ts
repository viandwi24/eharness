import { describe, expect, test } from 'bun:test'
import type { UIMessage } from 'ai'
import { scriptedModel } from 'eharness/testing'
import { createStorage } from '../src/app/sessions.ts'
import { createSideQuestion, SIDE_QUESTION_INSTRUCTIONS } from '../src/app/side-question.ts'
import { setup } from './helpers.ts'

const messages: UIMessage[] = [
  { id: 'a', role: 'user', parts: [{ type: 'text', text: 'rename Foo to Bar in util.ts' }] },
  {
    id: 'b',
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: 'PRIVATE REASONING', state: 'done' },
      {
        type: 'tool-edit_file',
        toolCallId: 'c1',
        state: 'output-available',
        input: { path: '/util.ts' },
        output: 'Edited /util.ts',
      },
      { type: 'text', text: 'Renamed.' },
    ],
  },
]

describe('side question', () => {
  test('answers from the stored context, streams accumulated text and stores nothing', async () => {
    const { config } = await setup()
    const storage = createStorage(config)
    await storage.messages.save('s', messages)
    const before = JSON.stringify(await storage.messages.load({ sessionId: 's' }))
    const model = scriptedModel([{ text: 'It is in util.ts.' }])
    const ask = createSideQuestion({ storage, sessionId: () => 's', model: () => model })
    const deltas: string[] = []
    const answer = await ask('which file did we edit?', (t) => deltas.push(t))
    expect(answer).toBe('It is in util.ts.')
    expect(deltas.at(-1)).toBe('It is in util.ts.')

    const call = model.calls[0]
    const wire = JSON.stringify(call?.prompt)
    expect(wire).toContain(SIDE_QUESTION_INSTRUCTIONS)
    expect(wire).toContain('rename Foo to Bar in util.ts')
    expect(wire).toContain('which file did we edit?')
    expect(wire).toContain('[edit_file(') // tool call as text
    expect(wire).not.toContain('PRIVATE REASONING')
    expect(call?.tools ?? []).toEqual([])

    // nothing stored: messages, state and no new sessions
    expect(JSON.stringify(await storage.messages.load({ sessionId: 's' }))).toBe(before)
    expect(await storage.state.get('s')).toBeNull()
    expect(await storage.messages.load({ sessionId: 'other' })).toEqual([])
  })

  test('starts from the compaction marker and an empty session still works', async () => {
    const { config } = await setup()
    const storage = createStorage(config)
    await storage.messages.save('s', [
      { id: 'a', role: 'user', parts: [{ type: 'text', text: 'OLD TOPIC' }] },
      { id: 'b', role: 'assistant', parts: [{ type: 'text', text: 'old answer' }] },
      { id: 'c', role: 'user', parts: [{ type: 'text', text: 'new topic' }] },
      {
        id: 'd',
        role: 'user',
        metadata: { eharness: { v: 1, createdAt: 1, kind: 'eh.compaction' } },
        parts: [
          {
            type: 'data-eh.compaction',
            data: {
              summary: 'SUMMARY OF OLD TOPIC',
              resumeFromId: 'c',
              tokens: { before: 1, after: 1 },
              trigger: 'manual',
            },
          },
        ],
      } as UIMessage,
    ])
    await storage.state.set('s', {
      v: 1,
      rev: 1,
      core: { compaction: { markerId: 'd', resumeFromId: 'c' } },
      plugins: {},
    })
    const model = scriptedModel([{ text: 'ok' }, { text: 'fresh' }])
    const ask = createSideQuestion({ storage, sessionId: () => 's', model: () => model })
    await ask('what now?', () => {})
    const wire = JSON.stringify(model.calls[0]?.prompt)
    expect(wire).toContain('SUMMARY OF OLD TOPIC')
    expect(wire).toContain('new topic')
    expect(wire).not.toContain('"text":"OLD TOPIC"') // the raw old message is gone
    expect(wire).not.toContain('old answer')

    const empty = createSideQuestion({ storage, sessionId: () => 'nothing', model: () => model })
    expect(await empty('hi?', () => {})).toBe('fresh')
  })
})
