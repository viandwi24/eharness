import { describe, expect, test } from 'bun:test'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HarnessSession } from 'eharness'
import { createAgentTool, driveTurn } from '../src/agents/index.ts'
import type { AgentProgress, CoderMessage } from '../src/contracts.ts'
import { makeAgentsEnv, nextPending, routerModel } from './helpers.ts'

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  )

async function setupAgents(
  model: ReturnType<typeof routerModel>,
  files: Record<string, string> = {},
) {
  const env = await makeAgentsEnv({ files: { 'a.txt': 'alpha\n', ...files }, model })
  const session = env.agents.main.session('main-1') as never as HarnessSession<CoderMessage>
  const drive = (text: string) => {
    const run = session.send(text)
    const chunks: Array<{ type: string; [k: string]: unknown }> = []
    const reading = (async () => {
      const reader = (run.stream as ReadableStream<{ type: string }>).getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        chunks.push(value)
      }
    })()
    return {
      chunks,
      result: driveTurn(run, {
        session,
        broker: env.broker,
        permissions: env.permissions,
        describe: env.describe,
        onRun: (r) => {
          if (r !== run) {
            void (async () => {
              const reader = (r.stream as ReadableStream<{ type: string }>).getReader()
              for (;;) {
                const { done, value } = await reader.read()
                if (done) return
                chunks.push(value)
              }
            })()
          }
        },
      }).then(async (r) => {
        await reading
        return r
      }),
    }
  }
  return { env, session, drive }
}

const spawn = (type: string, prompt: string, toolCallId?: string) => ({
  toolName: 'agent',
  input: { subagent_type: type, description: 'task', prompt },
  ...(toolCallId ? { toolCallId } : {}),
})

describe('agent tool', () => {
  test('explore child is read-only: no write tools offered, a write attempt changes nothing', async () => {
    const model = routerModel((r) => {
      if (!r.isChild) {
        return r.toolResults === 0
          ? { toolCalls: [spawn('explore', 'CHILD-TASK write a file')] }
          : { text: 'main done' }
      }
      if (r.toolResults === 0) {
        return {
          toolCalls: [{ toolName: 'write_file', input: { path: '/evil.txt', content: 'x' } }],
        }
      }
      return { text: 'REPORT: could not write' }
    })
    const { env, drive } = await setupAgents(model)
    const { result } = drive('explore')
    const done = await result
    expect(done.stop).toBe('complete')
    const child = model.routes.filter((r) => r.isChild)
    expect(child.length).toBeGreaterThanOrEqual(1)
    for (const r of child) {
      for (const t of ['write_file', 'edit_file', 'delete_file', 'agent', 'exit_plan_mode']) {
        expect(r.tools).not.toContain(t)
      }
      expect(r.tools).toEqual(
        expect.arrayContaining(['read_file', 'grep', 'glob', 'bash', 'web_fetch', 'web_search']),
      )
    }
    expect(await exists(join(env.root, 'evil.txt'))).toBe(false)
    expect(env.broker.pending()).toEqual([])
    // the main agent got the child's final text as the tool result
    const mainLast = model.routes.filter((r) => !r.isChild).at(-1)
    expect(mainLast?.conversation).toContain('REPORT: could not write')
  })

  test('two agent calls in one step run concurrently; each returns its own final text', async () => {
    const started: Record<string, number> = {}
    const model = routerModel((r) => {
      if (!r.isChild) {
        return r.toolResults === 0
          ? { toolCalls: [spawn('explore', 'TASK-A', 'ca'), spawn('explore', 'TASK-B', 'cb')] }
          : { text: 'main done' }
      }
      const key = r.firstUser.includes('TASK-A') ? 'A' : 'B'
      started[key] ??= Date.now()
      return { text: `REPORT-${key} first line\nREPORT-${key} last line`, delayMs: 80 }
    })
    const { drive } = await setupAgents(model)
    const { result } = drive('two at once')
    const done = await result
    expect(done.stop).toBe('complete')
    // a serial run would start B only after A streamed all its parts (5 x 80 ms)
    expect(Math.abs((started.A ?? 0) - (started.B ?? 1e12))).toBeLessThan(250)
    const mainLast = model.routes.filter((r) => !r.isChild).at(-1)
    expect(mainLast?.conversation).toContain('REPORT-A first line')
    expect(mainLast?.conversation).toContain('REPORT-B last line')
    // children never see the parent's conversation
    for (const r of model.routes.filter((x) => x.isChild))
      expect(r.conversation).not.toContain('two at once')
  })

  test('the concurrency cap queues extra children', async () => {
    let running = 0
    let peak = 0
    const model = routerModel(() => {
      running++
      peak = Math.max(peak, running)
      setTimeout(() => {
        running--
      }, 120)
      return { text: 'ok', delayMs: 30 }
    })
    const { env } = await setupAgents(model)
    // the cap belongs to the tool deps: build the tool through the real factory with maxConcurrent 2
    const agentTool = createAgentTool(
      {
        definitions: () => env.definitions,
        agentFor: env.agents.agentFor,
        broker: env.broker,
        permissions: env.permissions,
        describe: env.describe,
        maxConcurrent: 2,
      },
      0,
    ) as unknown as (ctx: unknown) => {
      execute: (input: unknown, opts: unknown) => AsyncGenerator<unknown>
    }
    const tool = agentTool({ session: { id: 'main-x' }, turn: { id: 't', addUsage: () => {} } })
    const outputs = await Promise.all(
      [1, 2, 3, 4].map(async (i) => {
        let last: unknown
        for await (const o of tool.execute(
          { subagent_type: 'explore', description: 'd', prompt: `TASK-${i}` },
          { toolCallId: `c${i}`, abortSignal: undefined },
        )) {
          last = o
        }
        return last
      }),
    )
    expect(outputs).toEqual(['ok', 'ok', 'ok', 'ok'])
    expect(peak).toBeLessThanOrEqual(2)
  })

  test('preliminary AgentProgress updates, then the final text', async () => {
    const model = routerModel((r) => {
      if (!r.isChild) {
        return r.toolResults === 0
          ? { toolCalls: [spawn('explore', 'look around', 'cx')] }
          : { text: 'main done' }
      }
      if (r.toolResults === 0)
        return { toolCalls: [{ toolName: 'read_file', input: { path: '/a.txt' } }], delayMs: 20 }
      return { text: 'FINAL REPORT', delayMs: 20 }
    })
    const { drive } = await setupAgents(model)
    const { result, chunks } = drive('go')
    await result
    const outputs = chunks.filter(
      (c) => c.type === 'tool-output-available' && c.toolCallId === 'cx',
    )
    expect(outputs.length).toBeGreaterThanOrEqual(2)
    const preliminary = outputs
      .filter((c) => c.preliminary === true && typeof c.output === 'object')
      .map((c) => c.output as AgentProgress)
    expect(preliminary.length).toBeGreaterThanOrEqual(1)
    expect(preliminary[0]?.agent).toBe('explore')
    expect(preliminary[0]?.description).toBe('task')
    expect(preliminary[0]?.sessionId).toBe('main-1:agent:cx')
    expect(preliminary.some((p) => p.status === 'running')).toBe(true)
    expect(preliminary.some((p) => p.lastTool?.startsWith('read_file'))).toBe(true)
    expect(preliminary.at(-1)?.status).toBe('done')
    expect(preliminary.at(-1)?.text).toBe('FINAL REPORT')
    expect(outputs.at(-1)?.preliminary).not.toBe(true)
    expect(outputs.at(-1)?.output).toBe('FINAL REPORT')
  })

  test("the child's usage reaches the parent turn usage", async () => {
    const model = routerModel((r) => {
      if (!r.isChild) {
        return r.toolResults === 0
          ? {
              toolCalls: [spawn('explore', 'x', 'cu')],
              usage: { inputTokens: 10, outputTokens: 5 },
            }
          : { text: 'done', usage: { inputTokens: 20, outputTokens: 7 } }
      }
      return { text: 'child', usage: { inputTokens: 1000, outputTokens: 100 } }
    })
    const { drive } = await setupAgents(model)
    const result = await drive('go').result
    expect(result.stop).toBe('complete')
    expect(result.usage.inputTokens).toBe(1030)
    expect(result.usage.outputTokens).toBe(112)
  })

  test('unknown subagent type -> ERROR string listing the available ones', async () => {
    const model = routerModel((r) =>
      r.toolResults === 0 ? { toolCalls: [spawn('nope', 'x', 'cn')] } : { text: 'ok' },
    )
    const { drive } = await setupAgents(model)
    const result = await drive('go').result
    expect(result.stop).toBe('complete')
    const text = model.routes.at(-1)?.conversation ?? ''
    expect(text).toContain('ERROR: unknown subagent_type')
    expect(text).toContain('nope')
    expect(text).toContain('explore')
  })

  test('depth limit: the child at maxAgentDepth has no agent tool', async () => {
    const model = routerModel((r) => {
      const depth = r.isChild ? (r.firstUser.includes('LEVEL-2') ? 2 : 1) : 0
      if (depth === 0) {
        return r.toolResults === 0
          ? { toolCalls: [spawn('general-purpose', 'LEVEL-1')] }
          : { text: 'done' }
      }
      if (depth === 1) {
        return r.toolResults === 0
          ? { toolCalls: [spawn('general-purpose', 'LEVEL-2')] }
          : { text: 'level1 done' }
      }
      return { text: 'level2 done' }
    })
    const { drive } = await setupAgents(model)
    const result = await drive('go').result
    expect(result.stop).toBe('complete')
    const byDepth = (d: number) =>
      model.routes.filter((r) => (r.isChild ? (r.firstUser.includes('LEVEL-2') ? 2 : 1) : 0) === d)
    expect(byDepth(0)[0]?.tools).toContain('agent')
    expect(byDepth(1)[0]?.tools).toContain('agent')
    expect(byDepth(2)).not.toHaveLength(0)
    expect(byDepth(2)[0]?.tools).not.toContain('agent')
  })

  test("a child's approval goes through the broker with the agent name, and the answer reaches the child", async () => {
    const model = routerModel((r) => {
      if (!r.isChild) {
        return r.toolResults === 0
          ? { toolCalls: [spawn('general-purpose', 'edit a.txt')] }
          : { text: 'done' }
      }
      if (r.toolResults === 0)
        return { toolCalls: [{ toolName: 'read_file', input: { path: '/a.txt' } }] }
      if (r.toolResults === 1) {
        return {
          toolCalls: [
            {
              toolName: 'edit_file',
              input: { path: '/a.txt', old_string: 'alpha', new_string: 'ALPHA' },
            },
          ],
        }
      }
      return { text: 'child finished' }
    })
    const { env, drive } = await setupAgents(model)
    const turn = drive('go')
    const request = await nextPending(env.broker)
    expect(request.agent).toBe('general-purpose')
    expect(request.toolName).toBe('edit_file')
    expect(request.title).toContain('a.txt')
    env.broker.answer(request.id, { approved: true })
    const result = await turn.result
    expect(result.stop).toBe('complete')
    expect(await readFile(join(env.root, 'a.txt'), 'utf8')).toBe('ALPHA\n')
  })

  test("a child's denial feedback reaches the child model", async () => {
    const model = routerModel((r) => {
      if (!r.isChild) {
        return r.toolResults === 0
          ? { toolCalls: [spawn('general-purpose', 'edit a.txt')] }
          : { text: 'done' }
      }
      if (r.toolResults === 0)
        return { toolCalls: [{ toolName: 'read_file', input: { path: '/a.txt' } }] }
      if (r.toolResults === 1) {
        return {
          toolCalls: [
            {
              toolName: 'edit_file',
              input: { path: '/a.txt', old_string: 'alpha', new_string: 'ALPHA' },
            },
          ],
        }
      }
      return { text: 'child adapted' }
    })
    const { env, drive } = await setupAgents(model)
    const turn = drive('go')
    const request = await nextPending(env.broker)
    env.broker.answer(request.id, { approved: false, feedback: 'do not touch a.txt' })
    const result = await turn.result
    expect(result.stop).toBe('complete')
    expect(await readFile(join(env.root, 'a.txt'), 'utf8')).toBe('alpha\n')
    const childLast = model.routes.filter((r) => r.isChild).at(-1)
    expect(childLast?.conversation).toContain('do not touch a.txt')
  })

  test('a custom reviewer agent with tools Read, Grep cannot use bash', async () => {
    const model = routerModel((r) => {
      if (!r.isChild) {
        return r.toolResults === 0 ? { toolCalls: [spawn('reviewer', 'review')] } : { text: 'done' }
      }
      return { text: 'reviewed' }
    })
    const env = await makeAgentsEnv({
      files: {
        'a.txt': 'x',
        '.coder/agents/reviewer.md':
          '---\nname: reviewer\ndescription: Reviews\ntools: read_file, grep\n---\nReview.\n',
      },
      flags: { trustProject: true },
      model,
    })
    const session = env.agents.main.session('m') as never as HarnessSession<CoderMessage>
    const result = await driveTurn(session.send('go'), {
      session,
      broker: env.broker,
      permissions: env.permissions,
      describe: env.describe,
    })
    expect(result.stop).toBe('complete')
    const child = model.routes.find((r) => r.isChild)
    expect(child?.tools.sort()).toEqual(['grep', 'read_file'])
  })

  test('nested children do not deadlock with maxConcurrent 2 (cap is per depth)', async () => {
    const model = routerModel((r) => {
      if (!r.isChild) {
        return r.toolResults === 0
          ? {
              toolCalls: [1, 2, 3].map((i) => spawn('general-purpose', `L1-${i}`, `c${i}`)),
            }
          : { text: 'main done' }
      }
      if (r.firstUser.startsWith('L1-')) {
        return r.toolResults === 0
          ? { toolCalls: [spawn('explore', `L2-${r.firstUser}`)], delayMs: 20 }
          : { text: `done ${r.firstUser}` }
      }
      return { text: 'grandchild ok', delayMs: 20 }
    })
    const env = await makeAgentsEnv({
      files: { 'a.txt': 'x' },
      model,
      maxConcurrentAgents: 2,
    })
    const session = env.agents.main.session('m') as never as HarnessSession<CoderMessage>
    const result = await Promise.race([
      driveTurn(session.send('go'), {
        session,
        broker: env.broker,
        permissions: env.permissions,
        describe: env.describe,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('deadlock')), 10_000)),
    ])
    expect(result.stop).toBe('complete')
    expect(model.routes.filter((r) => r.firstUser.startsWith('L2-')).length).toBeGreaterThan(0)
  })

  test('a failure inside the child becomes an ERROR string, the slot is released', async () => {
    const { env } = await setupAgents(routerModel(() => ({ text: 'x' })))
    const failing = {
      definitions: () => env.definitions,
      agentFor: () => {
        throw new Error('boom')
      },
      broker: env.broker,
      permissions: env.permissions,
      describe: env.describe,
      maxConcurrent: 1,
    }
    const make = createAgentTool(failing as never, 0) as unknown as (ctx: unknown) => {
      execute: (input: unknown, opts: unknown) => AsyncGenerator<unknown>
    }
    const tool = make({ session: { id: 'main-x' }, turn: { id: 't', addUsage: () => {} } })
    for (const id of ['a', 'b']) {
      // twice with a cap of 1: a leaked slot would hang the second call
      let last: unknown
      for await (const o of tool.execute(
        { subagent_type: 'explore', description: 'd', prompt: 'p' },
        { toolCallId: id, abortSignal: undefined },
      )) {
        last = o
      }
      expect(last).toBe('ERROR: subagent failed: boom')
    }
  })

  test('explore runs its bash read-only even when the session is in bypassPermissions', async () => {
    const model = routerModel((r) => {
      if (!r.isChild) {
        return r.toolResults === 0
          ? { toolCalls: [spawn('explore', 'CHILD')] }
          : { text: 'main done' }
      }
      return r.toolResults === 0
        ? { toolCalls: [{ toolName: 'bash', input: { command: 'touch evil.txt' } }] }
        : { text: 'REPORT' }
    })
    const env = await makeAgentsEnv({
      files: { 'a.txt': 'x' },
      flags: { permissionMode: 'bypassPermissions' },
      model,
    })
    const session = env.agents.main.session('m') as never as HarnessSession<CoderMessage>
    const result = await driveTurn(session.send('go'), {
      session,
      broker: env.broker,
      permissions: env.permissions,
      describe: env.describe,
    })
    expect(result.stop).toBe('complete')
    expect(await exists(join(env.root, 'evil.txt'))).toBe(false)
  })
})
