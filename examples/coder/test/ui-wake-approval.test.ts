/**
 * A turn woken by a background task that asks for an approval, then continues after the answer:
 * the live message the UI shows must leave `approval-requested` (regression: the card kept
 * "awaiting approval" above the output).
 */
import { describe, expect, test } from 'bun:test'
import { scriptedModel } from 'eharness/testing'
import type { CoderMessage } from '../src/contracts.ts'
import { runTurn } from '../src/ui/driver.ts'
import { initialState, reduce, type ViewAction, type ViewState } from '../src/ui/state.ts'
import { makeController, nextPending, routerModel } from './helpers.ts'

/** A view fed by the driver, with the helpers the two tests share. */
function view() {
  let state: ViewState = initialState()
  const states: string[] = []
  const dispatch = (a: ViewAction): void => {
    state = reduce(state, a)
    const m = messages().at(-1)
    const part = m?.parts.find(
      (p) => p.type === 'tool-bash' && JSON.stringify(p).includes('touch made.txt'),
    ) as { state?: string } | undefined
    if (part?.state !== undefined && states.at(-1) !== part.state) states.push(part.state)
  }
  /** Committed messages, then the live one. */
  const messages = (): CoderMessage[] => [
    ...state.entries.flatMap((e) => (e.kind === 'message' ? [e.message] : [])),
    ...(state.live ? [state.live] : []),
  ]
  const woken = (): { state?: string } =>
    messages()
      .flatMap((m) => m.parts)
      .find((p) => p.type === 'tool-bash' && JSON.stringify(p).includes('touch made.txt')) as {
      state?: string
    }
  /** Wait until the woken turn's text is on screen and the view is idle (turn finished). */
  const settled = async (text: string): Promise<void> => {
    const start = Date.now()
    while (state.running || !JSON.stringify(messages().at(-1) ?? '').includes(text)) {
      if (Date.now() - start > 8000) throw new Error('the woken turn never finished')
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  return {
    dispatch,
    states,
    woken,
    settled,
    get state() {
      return state
    },
  }
}

describe('woken turn with an approval', () => {
  test('a woken turn is a turn of the view: running, committed, and its tool part leaves approval-requested', async () => {
    const model = scriptedModel([
      {
        toolCalls: [
          { toolName: 'bash', input: { command: 'sleep 0.3; echo hi', run_in_background: true } },
        ],
      },
      { text: 'started' },
      // the exit event wakes the idle session
      {
        toolCalls: [
          { toolName: 'read_file', input: { path: '/a.txt' } },
          { toolName: 'list_files', input: { path: '/' } },
          { toolName: 'bash', input: { command: 'touch made.txt' } },
        ],
      },
      { text: 'woken turn done' },
    ])
    const { controller } = await makeController({ model, files: { 'a.txt': 'alpha\n' } })
    const v = view()
    const turn = runTurn(controller, 'start a task', v.dispatch)
    const first = await nextPending(controller.broker)
    controller.broker.answer(first.id, { approved: true })
    await turn
    const woken = await nextPending(controller.broker)
    expect(woken.toolName).toBe('bash')
    // the user takes a moment: the parked state reaches the UI, which shows a running turn
    await new Promise((r) => setTimeout(r, 300))
    expect(v.states).toContain('approval-requested')
    expect(v.state.running).toBe(true)
    controller.broker.answer(woken.id, { approved: true })
    await v.settled('woken turn done')
    expect(v.woken().state).toBe('output-available')
    // committed to the transcript, not left in the live region
    expect(v.state.live).toBeNull()
    // two messages (the first turn and the woken one); progressive commit may split one into chunks
    const ids = v.state.entries.flatMap((e) => (e.kind === 'message' ? [e.message.id] : []))
    expect(new Set(ids).size).toBe(2)
  })

  test('a background subagent wakes the idle session; its Bash call asks and continues', async () => {
    const model = routerModel((route) => {
      if (route.isChild) return { text: 'CHILD REPORT', delayMs: 300 }
      if (route.conversation.includes('Background subagent')) {
        return route.toolResults > 1
          ? { text: 'woken done' }
          : {
              toolCalls: [
                { toolName: 'read_file', input: { path: '/a.txt' } },
                { toolName: 'bash', input: { command: 'touch made.txt' } },
              ],
            }
      }
      if (route.toolResults === 0) {
        return {
          toolCalls: [
            {
              toolName: 'agent',
              input: {
                subagent_type: 'explore',
                description: 'look around',
                prompt: 'look',
                run_in_background: true,
              },
            },
          ],
        }
      }
      return { text: 'launched' }
    })
    const { controller } = await makeController({ model, files: { 'a.txt': 'alpha\n' } })
    const v = view()
    const turn = runTurn(controller, 'go', v.dispatch)
    // answer whatever asks: the Bash of the woken turn after a pause
    const answered: string[] = []
    const answering = (async () => {
      for (let i = 0; i < 4; i++) {
        const request = await nextPending(controller.broker)
        answered.push(request.toolName)
        if (request.toolName === 'bash') await new Promise((r) => setTimeout(r, 300))
        controller.broker.answer(request.id, { approved: true })
        if (request.toolName === 'bash') return
      }
    })()
    await turn
    await answering
    await v.settled('woken done')
    expect(answered).toContain('bash')
    expect(v.states).toContain('approval-requested')
    expect(v.woken().state).toBe('output-available')
    expect(v.state.live).toBeNull()
  })

  test('the event that wakes an idle session is shown once, before the woken reply, live and after resume', async () => {
    const model = routerModel((route) => {
      if (route.isChild) return { text: 'CHILD REPORT', delayMs: 200 }
      if (route.conversation.includes('Background subagent')) return { text: 'woken done' }
      if (route.toolResults === 0) {
        return {
          toolCalls: [
            {
              toolName: 'agent',
              input: {
                subagent_type: 'explore',
                description: 'look around',
                prompt: 'look',
                run_in_background: true,
              },
            },
          ],
        }
      }
      return { text: 'launched' }
    })
    const { controller } = await makeController({ model, files: { 'a.txt': 'alpha\n' } })
    const v = view()
    const answering = (async () => {
      for (;;) {
        const request = await nextPending(controller.broker)
        controller.broker.answer(request.id, { approved: true })
      }
    })()
    answering.catch(() => undefined)
    await runTurn(controller, 'go', v.dispatch)
    await v.settled('woken done')
    const order = (entries: ViewState['entries']): string[] =>
      entries.flatMap((e) =>
        e.kind === 'message'
          ? [
              e.message.metadata?.eharness?.kind === 'eh.event'
                ? 'event'
                : JSON.stringify(e.message).includes('woken done')
                  ? 'reply'
                  : 'other',
            ]
          : [],
      )
    const live = order(v.state.entries)
    expect(live.filter((k) => k === 'event')).toHaveLength(1)
    expect(live.indexOf('event')).toBeLessThan(live.indexOf('reply'))
    // resume: the stored conversation renders the same
    const loaded = reduce(initialState(), { type: 'load', messages: await controller.messages() })
    const stored = order(loaded.entries)
    expect(stored.filter((k) => k === 'event')).toHaveLength(1)
    expect(stored.indexOf('event')).toBeLessThan(stored.indexOf('reply'))
  })
})
