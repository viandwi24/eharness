/**
 * The turn principal reaches children and wake turns (ADR-0069, spec 20 §2.4): a durable
 * background child of a turn asked by P runs for P on another instance, and the wake turn its
 * report starts on a third process runs for P as well, although no session default names P.
 */
import { expect, test } from 'bun:test'
import {
  defineHarnessAgent,
  definePlugin,
  type HarnessAgent,
  type HarnessPlugin,
  type Principal,
} from '../index.ts'
import { inMemoryInbox, inMemoryMessages, inMemoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { until } from '../testing/test-utils.ts'
import { subagent } from './index.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
// biome-ignore lint/suspicious/noExplicitAny: loosely typed agents in tests
type Agent = HarnessAgent<any>
const P: Principal = { id: 'ana' }

const newStorage = () => ({
  messages: inMemoryMessages(),
  state: inMemoryState(),
  inbox: inMemoryInbox(),
})

function recorder(label: string, seen: string[]): HarnessPlugin {
  const id = (ctx: { principal: Principal | undefined }) => `${label}:${ctx.principal?.id ?? '-'}`
  return definePlugin({
    name: `rec-${label}`,
    setup: () => ({
      hooks: {
        'turn.start': (ctx) => void seen.push(`${id(ctx)}:start`),
        'step.prepare': (ctx) => void seen.push(`${id(ctx)}:step`),
        'turn.end': (ctx) => void seen.push(`${id(ctx)}:end`),
      },
    }),
  }) as unknown as HarnessPlugin
}

/** One process: a main agent and its worker agent (the child side) on shared storage. */
function process_(
  storage: ReturnType<typeof newStorage>,
  opts: {
    label: string
    seen: string[]
    main: Parameters<typeof scriptedModel>[0]
    worker: Parameters<typeof scriptedModel>[0]
    deadWorker?: boolean
  },
): { main: Agent; worker: Agent } {
  const holder: { main?: Agent; worker?: Agent } = {}
  const worker = defineHarnessAgent({
    model: scriptedModel(opts.worker),
    contextWindow: 100_000,
    storage:
      opts.deadWorker === true
        ? { ...storage, inbox: { ...storage.inbox, claim: async () => [] } }
        : storage,
    logger: silent,
    inbox: { pollMs: 20 },
    plugins: [
      subagent({
        agents: {},
        approvals: 'park',
        parentAgent: () => holder.main as Agent,
        selfAgent: () => holder.worker as Agent,
      }),
      recorder(`${opts.label}-child`, opts.seen),
    ] as never,
  }) as Agent
  holder.worker = worker
  const main = defineHarnessAgent({
    model: scriptedModel(opts.main),
    contextWindow: 100_000,
    storage,
    logger: silent,
    inbox: { pollMs: 20 },
    plugins: [
      subagent({
        agents: { worker: { agent: worker, description: 'does work' } },
        approvals: 'park',
        background: true,
        selfAgent: () => holder.main as Agent,
      }),
      recorder(`${opts.label}-main`, opts.seen),
    ] as never,
  }) as Agent
  holder.main = main
  return { main, worker }
}

const dump = async (agent: Agent, id: string): Promise<string> =>
  JSON.stringify(await agent.session(id).messages())

test('the child of a turn asked by P runs for P on another instance, and its report wakes the parent for P', async () => {
  const storage = newStorage()
  const seen: string[] = []
  const spawn = {
    toolName: 'agent',
    toolCallId: 'c1',
    input: {
      subagent_type: 'worker',
      description: 'review',
      prompt: 'review the change',
      name: 'reviewer',
      run_in_background: true,
    },
  }
  // process A starts the turn for P but cannot run the child (its worker never claims)
  const a = process_(storage, {
    label: 'a',
    seen,
    main: [{ toolCalls: [spawn] }, { text: 'delegated' }],
    worker: [{ text: 'never used' }],
    deadWorker: true,
  })
  // the session itself has no default principal: only the turn knows P
  await a.main.session('p1').send('go', { principal: P }).result
  await until('delegated', async () => (await dump(a.main, 'p1')).includes('delegated'))
  const children = await a.main.session('p1').children()
  expect(children.map((c) => c.principal)).toEqual([P])
  expect((await storage.state.get('p1'))?.core.principal).toBeUndefined()
  await Promise.all([a.main.close(), a.worker.close()])
  expect(
    seen.filter((r) => r.startsWith('a-main:')).every((r) => r.startsWith('a-main:ana:')),
  ).toBe(true)

  // process B runs the child and the wake turn of the report
  const b = process_(storage, {
    label: 'b',
    seen,
    main: [{ text: 'I saw the report' }],
    worker: [{ text: 'child report' }],
  })
  b.worker.session('p1:agent:c1')
  await until('parent woke', async () => (await dump(b.main, 'p1')).includes('I saw the report'))
  await until('wake turn ended', () => seen.includes('b-main:ana:end'))

  const child = seen.filter((r) => r.startsWith('b-child:'))
  expect(child).toEqual(['b-child:ana:start', 'b-child:ana:step', 'b-child:ana:end'])
  expect(seen.filter((r) => r.startsWith('b-main:'))).toEqual([
    'b-main:ana:start',
    'b-main:ana:step',
    'b-main:ana:end',
  ])
  expect(seen.filter((r) => !r.includes(':ana:'))).toEqual([])
  await Promise.all([b.main.close(), b.worker.close()])
})
