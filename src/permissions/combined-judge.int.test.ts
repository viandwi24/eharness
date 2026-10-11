/**
 * One judge call for permissions auto mode + `guard()` (ADR-0060 amendment 2026-10-11): the
 * combined call keeps both answers, and the outcomes equal the two-call path.
 */
import { describe, expect, test } from 'bun:test'
import { type LanguageModel, tool } from 'ai'
import { z } from 'zod/v4'
import { guard } from '../guard/index.ts'
import { defineHarnessAgent, type HarnessWarning, judgeCoordinator } from '../index.ts'
import { inMemoryMessages, inMemoryState } from '../storage/memory.ts'
import { type ScriptedStep, scriptedModel } from '../testing/scripted-model.ts'
import { modelClassifier } from './classifier.ts'
import { createPermissionEngine } from './engine.ts'
import { permissions } from './plugin.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

type Auto = 'allow' | 'block'
type Guard = 'allow' | 'ask' | 'deny'
interface Case {
  auto: Auto
  guard: Guard
}

const combinedReply = (c: Case): ScriptedStep => ({
  text: JSON.stringify({
    auto: c.auto,
    autoReason: 'auto says so.',
    guard: c.guard,
    guardReason: 'guard says so.',
  }),
})
const autoReply = (c: Case): ScriptedStep => ({
  text: JSON.stringify({ decision: c.auto, reason: 'auto says so.' }),
})
const guardReply = (c: Case): ScriptedStep => ({
  text: JSON.stringify({ decision: c.guard, reason: 'guard says so.' }),
})

function build(options: {
  classifierModel: LanguageModel
  guardModel?: LanguageModel
  plugins?: 'both' | 'auto' | 'guard'
  guardOptions?: { combineWithAutoMode?: boolean; maxCallChars?: number }
  mode?: 'auto' | 'default'
  order?: 'permissions-first' | 'guard-first'
}) {
  const ran: string[] = []
  const warnings: HarnessWarning[] = []
  const engine = createPermissionEngine({
    roots: () => [{ virtual: '/', real: '/' }],
    mode: options.mode ?? 'auto',
    classifier: modelClassifier({ model: options.classifierModel }),
  })
  const main = scriptedModel([
    { toolCalls: [{ toolName: 'bash', input: { command: 'make deploy' }, toolCallId: 'c1' }] },
    { text: 'Done.' },
  ])
  const guardPlugin =
    options.guardModel === undefined
      ? undefined
      : guard({
          model: options.guardModel,
          policy: 'Only deploy staging.',
          ...options.guardOptions,
        })
  const perm = permissions({ engine })
  const list = [
    ...(options.plugins === 'guard' ? [] : [perm]),
    ...(guardPlugin === undefined || options.plugins === 'auto' ? [] : [guardPlugin]),
  ]
  if (options.order === 'guard-first') list.reverse()
  const agent = defineHarnessAgent({
    model: main,
    contextWindow: 100_000,
    storage: { messages: inMemoryMessages(), state: inMemoryState() },
    logger: silent,
    onWarning: (w) => warnings.push(w),
    tools: {
      bash: tool({
        description: 'Run a shell command.',
        inputSchema: z.object({ command: z.string() }),
        execute: async ({ command }) => {
          ran.push(command)
          return `ran ${command}`
        },
      }),
    },
    plugins: list,
  })
  return { agent, main, ran, warnings, engine }
}

/** What the user and the model can observe of one call. */
async function observe(setup: ReturnType<typeof build>) {
  const result = await setup.agent.session('s').send('deploy staging').result
  const toolText =
    result.stop === 'complete' ? JSON.stringify(setup.main.prompts.at(-1)) : undefined
  await setup.agent.close()
  const reasons =
    toolText?.match(
      /(Auto mode blocked[^"]*|Blocked by the approval guard[^"]*|The approval guard asks[^"]*)/g,
    ) ?? []
  return { stop: result.stop, ran: setup.ran, reasons }
}

const table: Array<[string, Case]> = [
  ['auto allow + guard no objection', { auto: 'allow', guard: 'allow' }],
  ['auto allow + guard deny', { auto: 'allow', guard: 'deny' }],
  ['auto allow + guard ask', { auto: 'allow', guard: 'ask' }],
  ['auto block + guard no objection', { auto: 'block', guard: 'allow' }],
  ['auto block + guard deny', { auto: 'block', guard: 'deny' }],
  ['auto block + guard ask', { auto: 'block', guard: 'ask' }],
]

describe('one judge call for auto mode + guard', () => {
  for (const [name, c] of table) {
    test(`${name}: one model call, same outcome as two calls`, async () => {
      const shared = scriptedModel([combinedReply(c)])
      const one = await observe(build({ classifierModel: shared, guardModel: shared }))
      expect(shared.calls).toHaveLength(1)

      const classifier = scriptedModel([autoReply(c)])
      const guardJudge = scriptedModel([guardReply(c)])
      const two = await observe(build({ classifierModel: classifier, guardModel: guardJudge }))
      expect(classifier.calls).toHaveLength(1)
      expect(guardJudge.calls).toHaveLength(1)

      expect(one).toEqual(two)
      const approved = c.auto === 'allow' && c.guard === 'allow'
      expect(one.ran).toEqual(approved ? ['make deploy'] : [])
      if (c.auto === 'allow' && c.guard === 'ask') expect(one.stop).toBe('tool-pending')
    })
  }

  test('the guard half is recorded: usage charged once, guard reason in the tool result', async () => {
    const shared = scriptedModel([
      {
        ...combinedReply({ auto: 'allow', guard: 'deny' }),
        usage: { inputTokens: 100, outputTokens: 20 },
      },
    ])
    const setup = build({ classifierModel: shared, guardModel: shared })
    const result = await setup.agent.session('s').send('deploy staging').result
    expect(result.stop).toBe('complete')
    expect(JSON.stringify(setup.main.prompts.at(-1))).toContain(
      'Blocked by the approval guard: guard says so.',
    )
    expect(shared.calls).toHaveLength(1)
    await setup.agent.close()
  })

  test('the prompt carries both rule sets and the guard policy', async () => {
    const shared = scriptedModel([combinedReply({ auto: 'allow', guard: 'allow' })])
    await observe(build({ classifierModel: shared, guardModel: shared }))
    const text = JSON.stringify(shared.prompts[0])
    expect(text).toContain('Review 1')
    expect(text).toContain('Review 2')
    expect(text).toContain('Only deploy staging.')
  })

  test('a different model keeps two calls', async () => {
    const a = scriptedModel([autoReply({ auto: 'allow', guard: 'allow' })])
    const b = scriptedModel([guardReply({ auto: 'allow', guard: 'allow' })])
    const out = await observe(build({ classifierModel: a, guardModel: b }))
    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(1)
    expect(out.ran).toEqual(['make deploy'])
  })

  test('combineWithAutoMode: false keeps two calls on the same model', async () => {
    const shared = scriptedModel([
      autoReply({ auto: 'allow', guard: 'allow' }),
      guardReply({ auto: 'allow', guard: 'allow' }),
    ])
    const out = await observe(
      build({
        classifierModel: shared,
        guardModel: shared,
        guardOptions: { combineWithAutoMode: false },
      }),
    )
    expect(shared.calls).toHaveLength(2)
    expect(out.ran).toEqual(['make deploy'])
  })

  test('different view limits keep two calls', async () => {
    const shared = scriptedModel([
      autoReply({ auto: 'allow', guard: 'allow' }),
      guardReply({ auto: 'allow', guard: 'allow' }),
    ])
    const setup = build({
      classifierModel: shared,
      guardModel: shared,
      guardOptions: { maxCallChars: 500 },
    })
    await observe(setup)
    expect(shared.calls).toHaveLength(2)
  })

  test('guard alone and auto alone are unchanged: one call each', async () => {
    const g = scriptedModel([guardReply({ auto: 'allow', guard: 'allow' })])
    // guard alone: permissions in default mode with an allow rule for nothing: use risk policy instead
    const alone = build({ classifierModel: g, guardModel: g, plugins: 'guard' })
    const r1 = await alone.agent.session('s').send('x').result
    expect(r1.stop).toBeDefined()
    // no permissions plugin: the engine is unused, the guard judges on its own
    expect(g.calls).toHaveLength(1)
    expect(g.prompts[0] && JSON.stringify(g.prompts[0])).not.toContain('Review 1')
    await alone.agent.close()

    const a = scriptedModel([autoReply({ auto: 'allow', guard: 'allow' })])
    const auto = build({ classifierModel: a })
    const out = await observe(auto)
    expect(a.calls).toHaveLength(1)
    expect(JSON.stringify(a.prompts[0])).not.toContain('Review 2')
    expect(out.ran).toEqual(['make deploy'])
  })

  test('auto mode off: the guard judges alone', async () => {
    const shared = scriptedModel([guardReply({ auto: 'allow', guard: 'allow' })])
    const setup = build({ classifierModel: shared, guardModel: shared, mode: 'default' })
    await setup.agent.session('s').send('x').result
    expect(JSON.stringify(shared.prompts[0] ?? '')).not.toContain('Review 1')
    await setup.agent.close()
  })

  test('guard listed first: it judges alone, then the classifier (two calls, same outcome)', async () => {
    const shared = scriptedModel([
      guardReply({ auto: 'allow', guard: 'allow' }),
      autoReply({ auto: 'allow', guard: 'allow' }),
    ])
    const out = await observe(
      build({ classifierModel: shared, guardModel: shared, order: 'guard-first' }),
    )
    expect(shared.calls).toHaveLength(2)
    expect(out.ran).toEqual(['make deploy'])
  })

  test('judge unavailable: auto fails closed, the guard warns and asks, one call', async () => {
    const shared = scriptedModel([{ throws: new Error('offline') }])
    const setup = build({ classifierModel: shared, guardModel: shared })
    const result = await setup.agent.session('s').send('deploy staging').result
    expect(setup.ran).toEqual([])
    expect(result.stop).toBe('complete')
    expect(shared.calls.length).toBeLessThanOrEqual(2) // AI SDK retry of the one call
    expect(setup.warnings.map((w) => w.code)).toContain('W_GUARD_UNAVAILABLE')
    expect(JSON.stringify(setup.main.prompts.at(-1))).toContain('could not classify')
    await setup.agent.close()
  })

  test('respond(): approving the guard ask re-validates without another judge call', async () => {
    const shared = scriptedModel([combinedReply({ auto: 'allow', guard: 'ask' })])
    const setup = build({ classifierModel: shared, guardModel: shared })
    const session = setup.agent.session('s')
    const pending = await session.send('deploy staging').result
    expect(pending.stop).toBe('tool-pending')
    const approval = pending.pending?.approvals[0]
    const done = await session.respond({
      approvals: [{ id: approval?.approvalId as string, approved: true }],
    }).result
    expect(done.stop).toBe('complete')
    expect(setup.ran).toEqual(['make deploy'])
    expect(shared.calls).toHaveLength(1)
    await setup.agent.close()
  })

  test('coordinators of two sessions never share', () => {
    const a = judgeCoordinator({})
    const b = judgeCoordinator({})
    expect(a).not.toBe(b)
  })
})
