import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scriptedModel } from 'eharness/testing'
import { driveTurn } from '../src/agents/index.ts'
import type { CoderMessage } from '../src/contracts.ts'
import { makeAgentsEnv, nextPending } from './helpers.ts'

const FILES = { 'a.txt': 'alpha\nbeta\n' }
const edit = (old: string, next: string) => ({
  toolName: 'edit_file',
  input: { path: '/a.txt', old_string: old, new_string: next },
})
const read = { toolName: 'read_file', input: { path: '/a.txt' } }

async function setupDrive(steps: Parameters<typeof scriptedModel>[0]) {
  const model = scriptedModel(steps)
  const env = await makeAgentsEnv({ files: FILES, model })
  const session = env.agents.main.session(
    's1',
  ) as never as import('eharness').HarnessSession<CoderMessage>
  const drive = (text: string, signal?: AbortSignal) =>
    driveTurn(session.send(text, { abortSignal: signal }), {
      session,
      broker: env.broker,
      permissions: env.permissions,
      describe: env.describe,
      signal,
    })
  return { model, env, session, drive }
}

describe('driveTurn', () => {
  test('a read-only turn needs no approval', async () => {
    const { drive, env } = await setupDrive([{ toolCalls: [read] }, { text: 'done' }])
    const result = await drive('go')
    expect(result.stop).toBe('complete')
    expect(env.broker.pending()).toEqual([])
  })

  test('tool-pending: the broker is asked with title and detail; approving runs the tool', async () => {
    const { drive, env, model } = await setupDrive([
      { toolCalls: [read] },
      { toolCalls: [edit('alpha', 'ALPHA')] },
      { text: 'edited' },
    ])
    const turn = drive('edit it')
    const request = await nextPending(env.broker)
    expect(request.toolName).toBe('edit_file')
    expect(request.title).toContain('a.txt')
    expect(request.detail).toContain('-alpha')
    expect(request.detail).toContain('+ALPHA')
    expect(request.agent).toBeUndefined()
    // not applied before the answer
    expect(await readFile(join(env.root, 'a.txt'), 'utf8')).toBe('alpha\nbeta\n')
    env.broker.answer(request.id, { approved: true })
    const result = await turn
    expect(result.stop).toBe('complete')
    expect(await readFile(join(env.root, 'a.txt'), 'utf8')).toBe('ALPHA\nbeta\n')
    expect(model.prompts).toHaveLength(3)
  })

  test('deny with feedback: the model sees the reason and the file is untouched', async () => {
    const { drive, env, model } = await setupDrive([
      { toolCalls: [read] },
      { toolCalls: [edit('alpha', 'ALPHA')] },
      { text: 'ok, skipping' },
    ])
    const turn = drive('edit it')
    const request = await nextPending(env.broker)
    env.broker.answer(request.id, { approved: false, feedback: 'use gamma instead, not ALPHA' })
    const result = await turn
    expect(result.stop).toBe('complete')
    expect(await readFile(join(env.root, 'a.txt'), 'utf8')).toBe('alpha\nbeta\n')
    expect(JSON.stringify(model.prompts[2])).toContain('use gamma instead, not ALPHA')
  })

  test('deny without feedback uses the default reason', async () => {
    const { drive, env, model } = await setupDrive([
      { toolCalls: [read] },
      { toolCalls: [edit('alpha', 'ALPHA')] },
      { text: 'ok' },
    ])
    const turn = drive('edit it')
    env.broker.answer((await nextPending(env.broker)).id, { approved: false })
    await turn
    expect(JSON.stringify(model.prompts[2])).toContain('Denied by the user.')
  })

  test("remember: 'session' adds the rule, the next identical call needs no prompt", async () => {
    const { drive, env } = await setupDrive([
      { toolCalls: [read] },
      { toolCalls: [edit('alpha', 'ALPHA')] },
      { toolCalls: [edit('beta', 'BETA')] },
      { text: 'both' },
    ])
    const turn = drive('edit twice')
    const request = await nextPending(env.broker)
    expect(request.suggestedRule).toBeDefined()
    env.broker.answer(request.id, { approved: true, remember: 'session' })
    const result = await turn
    expect(result.stop).toBe('complete')
    expect(env.permissions.rules().allow).toContain(request.suggestedRule as string)
    expect(await readFile(join(env.root, 'a.txt'), 'utf8')).toBe('ALPHA\nBETA\n')
    expect(env.broker.pending()).toEqual([])
  })

  test('abort while waiting for the user ends the turn without running the tool', async () => {
    const { drive, env } = await setupDrive([
      { toolCalls: [read] },
      { toolCalls: [edit('alpha', 'ALPHA')] },
      { text: 'never' },
    ])
    const abort = new AbortController()
    const turn = drive('edit it', abort.signal)
    await nextPending(env.broker)
    abort.abort()
    const result = await turn
    expect(result.stop).not.toBe('complete')
    expect(env.broker.pending()).toEqual([])
    expect(await readFile(join(env.root, 'a.txt'), 'utf8')).toBe('alpha\nbeta\n')
  })

  test('onRun sees the first run and every respond continuation', async () => {
    const { session, env } = await setupDrive([
      { toolCalls: [read] },
      { toolCalls: [edit('alpha', 'ALPHA')] },
      { text: 'ok' },
    ])
    let runs = 0
    const turn = driveTurn(session.send('go'), {
      session,
      broker: env.broker,
      permissions: env.permissions,
      describe: env.describe,
      onRun: (run) => {
        runs++
        void run.result
      },
    })
    env.broker.answer((await nextPending(env.broker)).id, { approved: true })
    await turn
    expect(runs).toBe(2)
  })
})
