import { describe, expect, test } from 'bun:test'
import { scriptedModel } from 'eharness/testing'
import type { RunHooks } from '../src/contracts.ts'
import { makeController, nextPending } from './helpers.ts'

/** Hooks that drain every run's stream. */
function hooks(): RunHooks & { runs: number; done: Promise<void>[] } {
  const done: Promise<void>[] = []
  const h = {
    runs: 0,
    done,
    onRun(run: Parameters<RunHooks['onRun']>[0]) {
      h.runs++
      done.push(
        (async () => {
          const reader = (run.stream as ReadableStream<unknown>).getReader()
          while (!(await reader.read()).done) {}
        })(),
      )
    },
  }
  return h
}

const sleep = (command: string) => ({ toolName: 'bash', input: { command } })

describe('controller.steer', () => {
  test('a steer during a tool call reaches the next step of the same turn', async () => {
    const model = scriptedModel([{ toolCalls: [sleep('sleep 0.4')] }, { text: 'handled both' }])
    const { controller } = await makeController({
      model,
      flags: { permissionMode: 'bypassPermissions' },
    })
    const h = hooks()
    const turn = controller.run('start', h)
    await new Promise((r) => setTimeout(r, 150))
    const steered = await controller.steer('also check the docs', hooks())
    expect(steered).toEqual({ delivered: 'step' })
    const result = await turn
    await Promise.all(h.done)
    expect(result.stop).toBe('complete')
    expect(JSON.stringify(model.prompts.at(-1))).toContain('also check the docs')
    expect(model.calls.length).toBe(2)
    const roles = (await controller.messages()).map((m) => m.role)
    expect(roles).toEqual(['user', 'assistant'])
  })

  test('a steer after the turn ended runs as a turn of its own', async () => {
    const model = scriptedModel([{ text: 'first' }, { text: 'second' }])
    const { controller } = await makeController({ model })
    const first = hooks()
    await controller.run('one', first)
    const h = hooks()
    const steered = await controller.steer('two', h)
    await Promise.all(h.done)
    expect(steered.delivered).toBe('turn')
    if (steered.delivered === 'turn') expect(steered.result.stop).toBe('complete')
    expect(h.runs).toBe(1)
    const texts = (await controller.messages()).filter((m) => m.role === 'user')
    expect(texts.length).toBe(2)
  })

  test('a steer dropped by an approval stop runs as a follow-up turn once the approval is answered', async () => {
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'write_file', input: { path: '/new.txt', content: 'x' } }] },
      { text: 'written' },
      { text: 'steer answered' },
    ])
    const { controller } = await makeController({ model })
    const h = hooks()
    const turn = controller.run('write it', h)
    const request = await nextPending(controller.broker)
    const steered = await controller.steer('and also this', hooks())
    expect(steered).toEqual({ delivered: 'step' })
    controller.broker.answer(request.id, { approved: true })
    const result = await turn
    await Promise.all(h.done)
    expect(result.stop).toBe('complete')
    expect(JSON.stringify(model.prompts.at(-1))).toContain('and also this')
    // the follow-up turn was driven with the caller's hooks
    expect(h.runs).toBeGreaterThanOrEqual(3)
  })
})
