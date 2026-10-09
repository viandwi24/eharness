/**
 * The task list and woken turns. Background shells and subagents are the library's `shellTasks`
 * and `subagentTasks` services (tested in the library, and through the controller in
 * integration.test.ts); what is tested here is the app's part: the merged list and stop, and that
 * a run the controller did not start (a wake) is driven through `session.onRun`.
 */
import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scriptedModel } from 'eharness/testing'
import { makeController, nextPending, routerModel } from './helpers.ts'

describe('background subagents in the task list', () => {
  test('the subagentTasks service feeds /tasks: running with a tail, stoppable', async () => {
    const model = routerModel((route) => {
      if (route.isChild) return { text: 'CHILD REPORT', delayMs: 20_000 }
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
    const { controller } = await makeController({
      model,
      flags: { permissionMode: 'bypassPermissions' },
    })
    const seen: string[] = []
    controller.onTasks((tasks) => seen.push(tasks.map((t) => t.status).join()))
    await controller.run('go', { onRun() {} })
    expect(controller.tasks()).toMatchObject([
      { id: 'agent-1', kind: 'agent', label: 'explore: look around', status: 'running' },
    ])
    await controller.stopTask('agent-1')
    expect(controller.tasks()[0]).toMatchObject({ status: 'stopped' })
    expect(controller.tasks()[0]?.endedAt).toBeGreaterThan(0)
    expect(seen).toContain('stopped')
  })
})

describe('a session woken by a background event', () => {
  test('session.onRun hands the woken run to the controller: its approval reaches the broker and the edit lands', async () => {
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
