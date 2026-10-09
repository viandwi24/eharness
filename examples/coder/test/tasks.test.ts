/**
 * The task list: background shells are the library's `shellTasks` (tested in the library, and
 * through the controller in integration.test.ts); what is tested here is the app's part: the hub
 * derives background subagents from stored messages and states, and a session woken by a
 * background event is driven by the controller (its approvals are answered).
 */
import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionStateSnapshot } from 'eharness'
import { scriptedModel } from 'eharness/testing'
import { createTaskHub } from '../src/app/tasks.ts'
import type { CoderMessage } from '../src/contracts.ts'
import { makeController, nextPending } from './helpers.ts'

const CHILD = 'p1:agent:call-1'

const started = (): CoderMessage =>
  ({
    id: 'a1',
    role: 'assistant',
    parts: [
      {
        type: 'tool-agent',
        toolCallId: 'call-1',
        state: 'output-available',
        input: {},
        output: `Started background subagent ${CHILD} (explore): look. around. You will be notified when it finishes.`,
      },
    ],
  }) as unknown as CoderMessage

const finished = (status: 'completed' | 'failed'): CoderMessage =>
  ({
    id: 'e1',
    role: 'user',
    parts: [
      {
        type: 'data-eh.event',
        data: {
          name: 'subagent',
          text: 'done',
          data: { sessionId: CHILD, agent: 'explore', status },
        },
      },
    ],
  }) as unknown as CoderMessage

const childText = (text: string, stop?: string): CoderMessage =>
  ({
    id: 'c1',
    role: 'assistant',
    parts: [{ type: 'step-start' }, { type: 'text', text }],
    metadata: { eharness: stop === undefined ? {} : { stop } },
  }) as unknown as CoderMessage

function hub(opts: {
  messages: CoderMessage[]
  child?: CoderMessage[]
  state?: Partial<SessionStateSnapshot['core']> | null
}) {
  const stopped: string[] = []
  const storage = {
    state: {
      get: async (id: string) =>
        id === CHILD
          ? opts.state === null
            ? null
            : { v: 1, rev: 1, core: opts.state ?? {}, plugins: {} }
          : null,
    },
    messages: {
      load: async ({ sessionId }: { sessionId: string }) =>
        sessionId === CHILD ? (opts.child ?? []) : [],
    },
  }
  const h = createTaskHub({
    session: () => 'p1',
    storage: storage as never,
    messages: async () => opts.messages,
    stopAgent: async (id, agent) => void stopped.push(`${agent}:${id}`),
  })
  return { h, stopped }
}

describe('background subagents in the task list', () => {
  test('a child with an active turn is running, with its latest text as the tail', async () => {
    const { h } = hub({
      messages: [started()],
      child: [childText('looking at src')],
      state: { activeTurn: { turnId: 't' } as never },
    })
    await h.refresh()
    expect(h.tasks()).toMatchObject([
      {
        id: 'agent-1',
        kind: 'agent',
        label: 'explore: look. around',
        status: 'running',
        tail: 'looking at src',
      },
    ])
    expect(h.taskOutput('agent-1')).toBe('looking at src')
    h.close()
  })

  test('the report event decides: completed or failed (also after a restart)', async () => {
    for (const status of ['completed', 'failed'] as const) {
      const { h } = hub({
        messages: [started(), finished(status)],
        child: [childText('REPORT', 'complete')],
      })
      await h.refresh()
      expect(h.tasks()[0]).toMatchObject({ status, tail: 'REPORT' })
      expect(h.tasks()[0]?.endedAt).toBeGreaterThan(0)
      h.close()
    }
  })

  test('a child that stopped without a report event is judged by its stop reason', async () => {
    const aborted = hub({ messages: [started()], child: [childText('half', 'aborted')], state: {} })
    await aborted.h.refresh()
    expect(aborted.h.tasks()[0]?.status).toBe('failed')
    const done = hub({ messages: [started()], child: [childText('ok', 'complete')], state: {} })
    await done.h.refresh()
    expect(done.h.tasks()[0]?.status).toBe('completed')
  })

  test('stopTask aborts the child once and the task stays stopped', async () => {
    const { h, stopped } = hub({
      messages: [started()],
      child: [childText('x')],
      state: { activeTurn: { turnId: 't' } as never },
    })
    await h.refresh()
    await h.stopTask('agent-1')
    await h.stopTask('agent-1')
    expect(stopped).toEqual([`explore:${CHILD}`])
    await h.refresh()
    expect(h.tasks()[0]?.status).toBe('stopped')
    h.close()
  })

  test('listeners are told about changes and can unsubscribe', async () => {
    const { h } = hub({
      messages: [started(), finished('completed')],
      child: [childText('R', 'complete')],
    })
    const seen: string[] = []
    const off = h.onTasks((list) => seen.push(list.map((t) => t.status).join()))
    await h.refresh()
    expect(seen).toEqual(['completed'])
    off()
    h.changed()
    expect(seen).toHaveLength(1)
  })
})

describe('a session woken by a background event', () => {
  test('the controller drives the woken turn: its approval reaches the broker and the edit lands', async () => {
    const model = scriptedModel([
      {
        toolCalls: [
          { toolName: 'bash', input: { command: 'sleep 0.4; echo hi', run_in_background: true } },
        ],
      },
      { text: 'started' },
      // the exit event wakes the idle session: read, edit (needs approval), answer
      { toolCalls: [{ toolName: 'read_file', input: { path: '/a.txt' } }] },
      {
        toolCalls: [
          {
            toolName: 'edit_file',
            input: { path: '/a.txt', old_string: 'alpha', new_string: 'ALPHA' },
          },
        ],
      },
      { text: 'edited after the task ended' },
    ])
    const { controller, root } = await makeController({ model, files: { 'a.txt': 'alpha\n' } })
    const chunks: string[] = []
    const hooks = {
      onRun(run: { stream: ReadableStream<unknown> }) {
        void (async () => {
          const reader = run.stream.getReader()
          for (;;) {
            const r = await reader.read()
            if (r.done) return
            chunks.push((r.value as { type: string }).type)
          }
        })()
      },
    }
    const turn = controller.run('start a task', hooks)
    const bash = await nextPending(controller.broker)
    expect(bash.toolName).toBe('bash')
    controller.broker.answer(bash.id, { approved: true })
    // the turn ends, the task exits afterwards and wakes the idle session
    await turn
    // the woken turn asks for the edit, with nobody having called run()
    const edit = await nextPending(controller.broker)
    expect(edit.toolName).toBe('edit_file')
    controller.broker.answer(edit.id, { approved: true })
    const start = Date.now()
    while ((await readFile(join(root, 'a.txt'), 'utf8')) !== 'ALPHA\n') {
      if (Date.now() - start > 8000) throw new Error('the woken turn never edited the file')
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(JSON.stringify(model.prompts.at(-1))).toContain('exited with code 0')
    // the UI hooks received the woken runs too (the send, its respond, the wake and its respond)
    expect(chunks.filter((c) => c === 'finish').length).toBeGreaterThanOrEqual(3)
  })
})
