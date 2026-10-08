import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tool } from 'ai'
import { defineHarnessAgent } from 'eharness'
import { memoryMessages, memoryState } from 'eharness/storage/memory'
import { type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { z } from 'zod/v4'
import {
  createHookRunner,
  type HooksConfig,
  hasHooks,
  hooksPlugin,
  runHookCommand,
} from '../src/app/hooks.ts'
import { tempDir } from './helpers.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

async function setup(
  hooks: HooksConfig,
  steps: ScriptedStepInput[],
  extra?: { timeoutMs?: number },
) {
  const root = await tempDir('coder-hooks-')
  const notices: string[] = []
  let executed = 0
  const echo = tool({
    description: 'echo',
    inputSchema: z.object({ text: z.string() }),
    execute: async ({ text }) => {
      executed++
      return `echo:${text}`
    },
  })
  const model = scriptedModel(steps)
  const agent = defineHarnessAgent({
    model,
    contextWindow: 100_000,
    storage: { messages: memoryMessages(), state: memoryState() },
    logger: silent,
    tools: { echo },
    plugins: [
      hooksPlugin({
        hooks,
        root,
        onNotify: (m) => notices.push(m),
        ...(extra?.timeoutMs ? { defaultTimeoutMs: extra.timeoutMs } : {}),
      }),
    ],
  })
  const call = (text = 'x'): ScriptedStepInput => ({
    toolCalls: [{ toolName: 'echo', input: { text } }],
  })
  const prompts = (): string => JSON.stringify(model.prompts)
  return { root, agent, model, notices, executed: () => executed, call, prompts }
}

describe('hook commands', () => {
  test('stdin is JSON, exit code and output are captured', async () => {
    const root = await tempDir()
    const r = await runHookCommand(
      'cat; echo err >&2; exit 2',
      { a: 1 },
      { cwd: root, timeoutMs: 5000 },
    )
    expect(r).toMatchObject({ exitCode: 2, stdout: '{"a":1}', stderr: 'err\n', timedOut: false })
  })

  test('timeout kills the command', async () => {
    const root = await tempDir()
    const started = Date.now()
    const r = await runHookCommand('sleep 30', {}, { cwd: root, timeoutMs: 100 })
    expect(r.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test('hasHooks, matchers and the Notification runner', async () => {
    expect(hasHooks(undefined)).toBe(false)
    expect(hasHooks({ Stop: [] })).toBe(false)
    expect(hasHooks({ Stop: [{ command: 'true' }] })).toBe(true)
    const root = await tempDir()
    const notices: string[] = []
    const runner = createHookRunner({
      root,
      onNotify: (m) => notices.push(m),
      hooks: {
        PreToolUse: [
          { matcher: 'edit_file|write_file', command: 'echo edit' },
          { matcher: 'bash', command: 'echo bash' },
          { matcher: '(', command: 'echo broken' },
          { command: 'echo all' },
        ],
        Notification: [{ command: `cat > ${join(root, 'note.json')}` }],
      },
    })
    expect(notices).toEqual(['Hook PreToolUse: invalid matcher "(" (hook skipped)'])
    const outputs = async (tool: string): Promise<string[]> =>
      (await runner.run('PreToolUse', {}, tool)).map((r) => r.stdout.trim()).sort()
    expect(await outputs('edit_file')).toEqual(['all', 'edit'])
    expect(await outputs('bash')).toEqual(['all', 'bash'])
    // whole-name match: `bash` does not match `bash_output`
    expect(await outputs('bash_output')).toEqual(['all'])
    await runner.notification('needs input', 's1')
    expect(JSON.parse(await readFile(join(root, 'note.json'), 'utf8'))).toMatchObject({
      event: 'Notification',
      message: 'needs input',
      session_id: 's1',
      cwd: root,
    })
  })
})

describe('hooks plugin', () => {
  test('PreToolUse exit 2 denies with stderr as the reason; the tool does not run', async () => {
    const h = await setup(
      { PreToolUse: [{ matcher: 'echo', command: 'echo "no echoing here" >&2; exit 2' }] },
      [{ toolCalls: [{ toolName: 'echo', input: { text: 'a' } }] }, { text: 'ok' }],
    )
    const result = await h.agent.session('s').send('go').result
    expect(result.stop).toBe('complete')
    expect(h.executed()).toBe(0)
    expect(h.prompts()).toContain('no echoing here')
  })

  test('PreToolUse gets the documented JSON on stdin', async () => {
    const h = await setup({ PreToolUse: [{ command: 'cat > seen.json' }] }, [
      { toolCalls: [{ toolName: 'echo', input: { text: 'a' } }] },
      { text: 'ok' },
    ])
    await h.agent.session('sess-9').send('go').result
    const seen = JSON.parse(await readFile(join(h.root, 'seen.json'), 'utf8'))
    expect(seen).toEqual({
      event: 'PreToolUse',
      tool_name: 'echo',
      tool_input: { text: 'a' },
      session_id: 'sess-9',
      cwd: h.root,
    })
    expect(h.executed()).toBe(1)
  })

  test('JSON decision "ask" asks the user; the hook ran once for the whole call (cached)', async () => {
    const h = await setup(
      {
        PreToolUse: [
          {
            command: `echo run >> count.txt; echo '{"decision":"ask","reason":"hook wants a look"}'`,
          },
        ],
      },
      [{ toolCalls: [{ toolName: 'echo', input: { text: 'a' } }] }, { text: 'done' }],
    )
    const session = h.agent.session('s')
    const pending = await session.send('go').result
    expect(pending.stop).toBe('tool-pending')
    const approval = pending.pending?.approvals[0]
    expect(approval?.toolName).toBe('echo')
    const done = await session.respond({
      approvals: [{ id: approval?.approvalId as string, approved: true }],
    }).result
    expect(done.stop).toBe('complete')
    expect(h.executed()).toBe(1)
    expect((await readFile(join(h.root, 'count.txt'), 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  test('JSON decision "deny" with a reason', async () => {
    const h = await setup(
      { PreToolUse: [{ command: `echo '{"decision":"deny","reason":"policy says no"}'` }] },
      [{ toolCalls: [{ toolName: 'echo', input: { text: 'a' } }] }, { text: 'ok' }],
    )
    await h.agent.session('s').send('go').result
    expect(h.executed()).toBe(0)
    expect(h.prompts()).toContain('policy says no')
  })

  test('failures are warnings: exit 1 and a timeout leave the call alone', async () => {
    const h = await setup(
      { PreToolUse: [{ command: 'exit 1' }, { command: 'sleep 30', timeoutMs: 100 }] },
      [{ toolCalls: [{ toolName: 'echo', input: { text: 'a' } }] }, { text: 'ok' }],
    )
    const result = await h.agent.session('s').send('go').result
    expect(result.stop).toBe('complete')
    expect(h.executed()).toBe(1)
    expect(h.notices.some((n) => n.includes('exited with code 1'))).toBe(true)
    expect(h.notices.some((n) => n.includes('timed out'))).toBe(true)
  })

  test('PostToolUse additionalContext is appended to the tool output', async () => {
    const h = await setup(
      {
        PostToolUse: [
          { matcher: 'echo', command: `echo '{"additionalContext":"lint: 2 warnings"}'` },
        ],
      },
      [{ toolCalls: [{ toolName: 'echo', input: { text: 'a' } }] }, { text: 'ok' }],
    )
    await h.agent.session('s').send('go').result
    const prompts = h.prompts()
    expect(prompts).toContain('echo:a')
    expect(prompts).toContain('lint: 2 warnings')
  })

  test('UserPromptSubmit: exit 2 blocks, stdout becomes context', async () => {
    const blocked = await setup(
      { UserPromptSubmit: [{ command: 'echo "secrets in prompt" >&2; exit 2' }] },
      [{ text: 'never' }],
    )
    const r = await blocked.agent.session('s').send('my password is hunter2').result
    expect(r.stop).not.toBe('complete')
    expect(blocked.model.prompts).toHaveLength(0)

    const ctx = await setup({ UserPromptSubmit: [{ command: 'echo "Today is Friday"' }] }, [
      { text: 'ok' },
    ])
    const ok = await ctx.agent.session('s').send('hello').result
    expect(ok.stop).toBe('complete')
    expect(ctx.prompts()).toContain('Today is Friday')
  })

  test('Stop: exit 2 keeps the model working once, with stderr as the reason', async () => {
    const h = await setup(
      {
        Stop: [
          {
            command: `if [ -f marker ]; then exit 0; fi; touch marker; echo "run the tests first" >&2; exit 2`,
          },
        ],
      },
      [{ text: 'first answer' }, { text: 'second answer after tests' }],
    )
    const result = await h.agent.session('s').send('go').result
    expect(result.stop).toBe('complete')
    expect(h.model.prompts).toHaveLength(2)
    expect(JSON.stringify(h.model.prompts[1])).toContain('run the tests first')
  })

  test('SessionStart runs once per session', async () => {
    const h = await setup(
      { SessionStart: [{ command: 'cat >> started.log; echo >> started.log' }] },
      [{ text: 'a' }, { text: 'b' }],
    )
    const session = h.agent.session('sess-start')
    await session.send('one').result
    await session.send('two').result
    const log = await readFile(join(h.root, 'started.log'), 'utf8')
    expect(log.match(/SessionStart/g)).toHaveLength(1)
    expect(log).toContain('sess-start')
  })
})
