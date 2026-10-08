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

async function setupDrive(steps: Parameters<typeof scriptedModel>[0], stopOnBareDeny = true) {
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
      stopOnBareDeny,
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
    const { drive, env, model } = await setupDrive(
      [{ toolCalls: [read] }, { toolCalls: [edit('alpha', 'ALPHA')] }, { text: 'ok' }],
      false,
    )
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

  test('Yes + note: the note reaches the model after the tool result and is stored as data-eh.input', async () => {
    const { drive, env, model, session } = await setupDrive([
      { toolCalls: [read] },
      { toolCalls: [edit('alpha', 'ALPHA')] },
      { text: 'edited' },
      { text: 'noted' },
    ])
    const turn = drive('edit it')
    env.broker.answer((await nextPending(env.broker)).id, { approved: true, note: 'keep it small' })
    const result = await turn
    expect(result.stop).toBe('complete')
    expect(await readFile(join(env.root, 'a.txt'), 'utf8')).toBe('ALPHA\nbeta\n')
    const note = 'Note from the user about the approved edit_file call: keep it small'
    // step 2 (right after the approved tool) cannot carry it yet; step 3 sees it, last in the prompt
    expect(JSON.stringify(model.prompts[2])).not.toContain(note)
    expect(model.prompts).toHaveLength(4)
    const last = model.prompts[3] as Array<{ role: string; content: unknown }>
    expect(JSON.stringify(last.at(-1))).toContain(note)
    expect(last.at(-1)?.role).toBe('user')
    expect(last.map((m) => m.role)).toContain('tool')
    const stored = await session.messages()
    const parts = stored.flatMap((m) => m.parts) as Array<{
      type: string
      data?: { text?: string }
    }>
    const input = parts.find((p) => p.type === 'data-eh.input')
    expect(input?.data?.text).toBe(note)
  })

  test('Yes + note, then the continuation stops pending again: the note is re-sent and still reaches the model', async () => {
    const { drive, env, model, session } = await setupDrive([
      { toolCalls: [read] },
      { toolCalls: [edit('alpha', 'ALPHA')] },
      { toolCalls: [edit('beta', 'BETA')] },
      { text: 'both edited' },
      { text: 'ack' },
    ])
    const turn = drive('edit twice')
    env.broker.answer((await nextPending(env.broker)).id, { approved: true, note: 'be careful' })
    const second = await nextPending(env.broker)
    env.broker.answer(second.id, { approved: true })
    const result = await turn
    expect(result.stop).toBe('complete')
    const note = 'Note from the user about the approved edit_file call: be careful'
    expect(JSON.stringify(model.prompts.at(-1))).toContain(note)
    const inputs = (await session.messages())
      .flatMap((m) => m.parts)
      .filter((p) => p.type === 'data-eh.input')
    expect(inputs).toHaveLength(1)
  })

  test('bare No on the main agent stops the turn; the stored result is the denial', async () => {
    const { drive, env, session } = await setupDrive([
      { toolCalls: [read] },
      { toolCalls: [edit('alpha', 'ALPHA')] },
      { text: 'must not run', delayMs: 50 },
    ])
    const turn = drive('edit it')
    env.broker.answer((await nextPending(env.broker)).id, { approved: false })
    const result = await turn
    expect(result.stop).toBe('aborted')
    expect(await readFile(join(env.root, 'a.txt'), 'utf8')).toBe('alpha\nbeta\n')
    const parts = ((await session.messages()).at(-1)?.parts ?? []) as Array<{
      type: string
      state?: string
    }>
    expect(parts.find((p) => p.type === 'tool-edit_file')?.state).toBe('output-denied')
    expect(JSON.stringify(parts)).not.toContain('must not run')
    expect(JSON.stringify(parts)).not.toContain('Interrupted')
  })

  test('bare No continues when stopOnBareDeny is off (subagents)', async () => {
    const model = scriptedModel([
      { toolCalls: [read] },
      { toolCalls: [edit('alpha', 'ALPHA')] },
      { text: 'adapting' },
    ])
    const env = await makeAgentsEnv({ files: FILES, model })
    const session = env.agents.main.session(
      's2',
    ) as never as import('eharness').HarnessSession<CoderMessage>
    const turn = driveTurn(session.send('go'), {
      session,
      broker: env.broker,
      permissions: env.permissions,
      describe: env.describe,
      stopOnBareDeny: false,
    })
    env.broker.answer((await nextPending(env.broker)).id, { approved: false })
    const result = await turn
    expect(result.stop).toBe('complete')
    expect(model.prompts).toHaveLength(3)
  })
})
