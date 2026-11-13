/**
 * Turn reminder placement and the provider prompt cache (spec 02 §5–6): with
 * `reminders.turnPlacement: 'end'`, the request of turn N+1 starts with the exact bytes of the
 * stable prefix of turn N's last request (everything before its trailing reminders), so a
 * provider's prefix cache covers the whole previous turn. The default `'turn-start'` places the
 * reminder inside what becomes history and the prefix diverges there.
 */
import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { HarnessAgentConfig } from '../agent/types.ts'
import { isHarnessError } from '../errors.ts'
import { spyMessages } from '../session/test-kit.ts'
import { type ScriptedCallOptions, scriptedModel } from '../testing/scripted-model.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const REMINDER = '<system-reminder>'

/** Two turns; turn 1 calls a tool (two steps), turn 2 answers directly. */
async function twoTurns(reminders?: HarnessAgentConfig['reminders']) {
  const model = scriptedModel([
    { toolCalls: [{ toolName: 'lookup', input: { q: 'a' } }] },
    { text: 'A1' },
    { text: 'A2' },
  ])
  let turn = 0
  const agent = defineHarnessAgent({
    model,
    contextWindow: 100_000,
    storage: { messages: spyMessages() },
    logger: silent,
    instructions: [
      'You are a careful assistant.',
      { text: () => `Turn ${++turn}: volatile context.`, refresh: 'turn' },
    ],
    tools: {
      lookup: tool({
        description: 'Look up',
        inputSchema: z.object({ q: z.string() }),
        execute: async ({ q }) => `result for ${q}`,
      }),
    },
    ...(reminders === undefined ? {} : { reminders }),
  })
  const session = agent.session('s1')
  expect((await session.send('Q1').result).stop).toBe('complete')
  expect((await session.send('Q2').result).stop).toBe('complete')
  return model.calls
}

type Prompt = ScriptedCallOptions['prompt']
const isReminder = (m: Prompt[number]) =>
  m.role === 'user' &&
  m.content.length === 1 &&
  m.content[0]?.type === 'text' &&
  m.content[0].text.startsWith(REMINDER)

/** The prompt without its trailing reminder messages (the part a cache breakpoint covers). */
function stablePrefix(prompt: Prompt): Prompt {
  let end = prompt.length
  while (end > 0 && isReminder(prompt[end - 1] as Prompt[number])) end--
  return prompt.slice(0, end)
}

/** Serialized bytes of a prompt prefix, without the closing bracket of the array. */
const bytes = (prompt: Prompt) => JSON.stringify(prompt).slice(0, -1)

describe('turn reminder placement and prompt caching (spec 02 §5)', () => {
  test("'end': turn N+1 starts with the exact bytes of turn N's stable prefix", async () => {
    const calls = await twoTurns({ turnPlacement: 'end' })
    expect(calls).toHaveLength(3)
    const lastOfTurn1 = (calls[1] as ScriptedCallOptions).prompt
    const firstOfTurn2 = (calls[2] as ScriptedCallOptions).prompt
    const stable = stablePrefix(lastOfTurn1)
    expect(JSON.stringify(firstOfTurn2).startsWith(bytes(stable))).toBe(true)
    // the stable prefix holds the whole of turn 1 so far (user message, tool call, tool result)
    expect(stable.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool'])
    // the reminder is last (after the newest user message) and carries this turn's text
    expect(JSON.stringify(firstOfTurn2.at(-1))).toContain('Turn 2: volatile context.')
    expect(firstOfTurn2.at(-2)?.role).toBe('user')
    expect(JSON.stringify(firstOfTurn2)).not.toContain('Turn 1: volatile context.')
    // within a turn, steps also extend the previous step's stable prefix
    const firstOfTurn1 = (calls[0] as ScriptedCallOptions).prompt
    expect(JSON.stringify(lastOfTurn1).startsWith(bytes(stablePrefix(firstOfTurn1)))).toBe(true)
  })

  test("default 'turn-start': the prefix diverges where turn N's reminder was", async () => {
    const calls = await twoTurns()
    const lastOfTurn1 = (calls[1] as ScriptedCallOptions).prompt
    const firstOfTurn2 = (calls[2] as ScriptedCallOptions).prompt
    const stable = stablePrefix(lastOfTurn1)
    // turn 1's reminder sits before its user message; turn 2 no longer sends it
    expect(isReminder(stable[1] as Prompt[number])).toBe(true)
    expect(JSON.stringify(firstOfTurn2).startsWith(bytes(stable))).toBe(false)
    expect(JSON.stringify(firstOfTurn2).startsWith(bytes(stable.slice(0, 1)))).toBe(true)
  })

  test('an invalid reminders.turnPlacement is EH_CONFIG_INVALID', () => {
    let error: unknown
    try {
      defineHarnessAgent({
        model: scriptedModel([]),
        reminders: { turnPlacement: 'middle' as never },
      })
    } catch (e) {
      error = e
    }
    expect(isHarnessError(error) && error.code).toBe('EH_CONFIG_INVALID')
  })
})
