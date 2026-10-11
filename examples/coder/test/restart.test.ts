/**
 * A coder that died mid-turn: the next one (same project) recovers the turn at once, says it was
 * interrupted, and Continue (a message) and `/retry` (regenerate) both work.
 */
import { describe, expect, test } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scriptedModel } from 'eharness/testing'
import { createController } from '../src/app/controller.ts'
import type { RunHooks } from '../src/contracts.ts'
import { onCleanup, setup } from './helpers.ts'

const hooks = (): RunHooks => ({
  onRun(run) {
    void (run.stream as ReadableStream).pipeTo(new WritableStream()).catch(() => {})
  },
})

describe('crash recovery of the CLI', () => {
  test('--continue after a crash: recovered at boot, Continue and /retry work', async () => {
    const { config } = await setup({ 'a.txt': 'a' })
    const first = await createController({
      config,
      model: scriptedModel([{ text: 'first answer' }]),
    })
    await first.run('first question', hooks())
    const sessionId = first.sessionId
    await first.close()

    // the process "died" in the middle of the reply: the turn is still active in the state file
    const dir = join(config.projectDataDir, 'sessions')
    const stateFile = join(dir, `${encodeURIComponent(sessionId)}.state.json`)
    const msgFile = join(dir, `${encodeURIComponent(sessionId)}.messages.json`)
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    const messages = JSON.parse(await readFile(msgFile, 'utf8')) as Array<{
      id: string
      role: string
      metadata: { eharness: Record<string, unknown> }
    }>
    const assistant = messages.findLast((m) => m.role === 'assistant')
    if (assistant === undefined) throw new Error('no assistant message')
    delete assistant.metadata.eharness.stop
    state.core.activeTurn = {
      turnId: 'dead-turn',
      kind: 'send',
      messageId: assistant.id,
      owner: 'coder',
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
    }
    await writeFile(msgFile, JSON.stringify(messages))
    await writeFile(stateFile, JSON.stringify(state))

    const second = await createController({
      config: { ...config, continueLast: true } as typeof config,
      model: scriptedModel([{ text: 'continued' }, { text: 'retried' }]),
    })
    onCleanup(() => second.close())
    expect(second.sessionId).toBe(sessionId)
    expect(await second.recoverInterrupted()).toBe(true)
    const stored = await second.messages()
    expect(
      stored.findLast((m) => m.role === 'assistant' && m.metadata?.eharness?.kind === undefined)
        ?.metadata?.eharness?.stop,
    ).toBe('interrupted')

    const sent = await second.run('Continue where you left off.', hooks())
    expect(sent.stop).toBe('complete')
    const retried = await second.retry(hooks())
    expect(retried.stop).toBe('complete')
    expect(JSON.stringify(await second.messages())).toContain('retried')
  })
})
