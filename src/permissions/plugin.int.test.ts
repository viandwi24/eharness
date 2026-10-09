/** The permissions plugin end to end: scripted model, memory file system, real engine. */
import { describe, expect, test } from 'bun:test'
import { filesystem } from '../filesystem/index.ts'
import { memoryFs } from '../filesystem/memory.ts'
import { type ApprovalDecision, defineHarnessAgent } from '../index.ts'
import { memoryMessages, memoryState } from '../storage/memory.ts'
import { type ScriptedStep, scriptedModel } from '../testing/scripted-model.ts'
import { createPermissionEngine, type PermissionEngineOptions } from './engine.ts'
import { type PermissionsPluginOptions, permissionsPlugin } from './plugin.ts'
import type { PermissionMode, PermissionRules } from './types.ts'

const TOOL = {
  read: 'read_file',
  list: 'list_files',
  grep: 'grep',
  glob: 'glob',
  edit: 'edit_file',
  write: 'write_file',
  delete: 'delete_file',
  exitPlan: 'exit_plan_mode',
} as const
const silent = { debug() {}, info() {}, warn() {}, error() {} }

function setup(
  steps: ScriptedStep[],
  mode: PermissionMode,
  opts: {
    rules?: Partial<PermissionRules>
    plugin?: Partial<PermissionsPluginOptions>
    engine?: Partial<PermissionEngineOptions>
    seed?: Record<string, string>
  } = {},
) {
  const engine = createPermissionEngine({
    roots: () => [{ virtual: '/', real: '/' }],
    mode,
    rules: opts.rules ?? {},
    ...opts.engine,
  })
  const fs = memoryFs(opts.seed ?? { '/a.txt': 'hello\n' })
  const model = scriptedModel(steps)
  const agent = defineHarnessAgent({
    model,
    contextWindow: 100_000,
    storage: { messages: memoryMessages(), state: memoryState() },
    logger: silent,
    plugins: [filesystem({ fs }), permissionsPlugin({ engine, ...opts.plugin })],
  })
  return { agent, engine, fs, model }
}

const write = (path: string, content: string): ScriptedStep => ({
  toolCalls: [{ toolName: TOOL.write, input: { path, content } }],
})
const toolNamesOf = (call: { tools?: Array<{ name: string }> }): string[] =>
  (call.tools ?? []).map((t) => t.name)

describe('permissions plugin', () => {
  test('default mode: write_file stops tool-pending, respond approve runs it', async () => {
    const { agent, fs } = setup([write('/new.txt', 'hi'), { text: 'Done.' }], 'default')
    const session = agent.session('s')
    const pending = await session.send('write it').result
    expect(pending.stop).toBe('tool-pending')
    const approval = pending.pending?.approvals[0]
    expect(approval?.toolName).toBe(TOOL.write)
    expect(await fs.read('/new.txt')).toBeNull()
    const done = await session.respond({
      approvals: [{ id: approval?.approvalId as string, approved: true }],
    }).result
    expect(done.stop).toBe('complete')
    expect((await fs.read('/new.txt'))?.content).toBe('hi')
    await agent.close()
  })

  test('respond deny with a reason: the model sees it, nothing is written', async () => {
    const { agent, fs, model } = setup([write('/new.txt', 'hi'), { text: 'ok' }], 'default')
    const session = agent.session('s')
    const pending = await session.send('write it').result
    const id = pending.pending?.approvals[0]?.approvalId as string
    await session.respond({ approvals: [{ id, approved: false, reason: 'not now, please' }] })
      .result
    expect(await fs.read('/new.txt')).toBeNull()
    expect(JSON.stringify(model.prompts.at(-1))).toContain('not now, please')
    await agent.close()
  })

  test('acceptEdits and bypassPermissions run edits without a prompt', async () => {
    for (const mode of ['acceptEdits', 'bypassPermissions'] as const) {
      const { agent, fs } = setup([write('/new.txt', 'hi'), { text: 'Done.' }], mode)
      const result = await agent.session('s').send('write it').result
      expect(result.stop).toBe('complete')
      expect((await fs.read('/new.txt'))?.content).toBe('hi')
      await agent.close()
    }
  })

  test('read-only tools never prompt', async () => {
    const { agent } = setup(
      [{ toolCalls: [{ toolName: TOOL.read, input: { path: '/a.txt' } }] }, { text: 'Read.' }],
      'default',
    )
    expect((await agent.session('s').send('read').result).stop).toBe('complete')
    await agent.close()
  })

  test('protected paths prompt even in bypassPermissions', async () => {
    const { agent } = setup([write('/.git/config', 'x'), { text: 'x' }], 'bypassPermissions')
    const result = await agent.session('s').send('go').result
    expect(result.stop).toBe('tool-pending')
    await agent.close()
  })

  test('dontAsk: the model sees the denial reason', async () => {
    const { agent, fs, model } = setup([write('/new.txt', 'hi'), { text: 'Could not.' }], 'dontAsk')
    const result = await agent.session('s').send('write it').result
    expect(result.stop).toBe('complete')
    expect(await fs.read('/new.txt')).toBeNull()
    expect(JSON.stringify(model.prompts.at(-1))).toContain(
      'Not allowed without approval in dontAsk mode.',
    )
    await agent.close()
  })

  test('a deny rule shows its reason to the model', async () => {
    const { agent, model } = setup(
      [write('/secrets/k', 'x'), { text: 'no' }],
      'bypassPermissions',
      {
        rules: { deny: ['Edit(secrets/**)'] },
      },
    )
    await agent.session('s').send('go').result
    expect(JSON.stringify(model.prompts.at(-1))).toContain('Denied by the rule Edit(secrets/**).')
    await agent.close()
  })

  test('an allow rule approves without a prompt', async () => {
    const { agent, fs } = setup([write('/src/a.ts', 'x'), { text: 'ok' }], 'default', {
      rules: { allow: ['Edit(src/**)'] },
    })
    expect((await agent.session('s').send('go').result).stop).toBe('complete')
    expect((await fs.read('/src/a.ts'))?.content).toBe('x')
    await agent.close()
  })

  test('plan mode: edit tools are not offered, exit_plan_mode is; the plan reason blocks a forced call', async () => {
    const { agent, model } = setup([write('/new.txt', 'hi'), { text: 'ok' }], 'plan')
    await agent.session('s').send('go').result
    const offered = toolNamesOf(model.calls[0] as never)
    expect(offered).toContain(TOOL.read)
    expect(offered).toContain(TOOL.exitPlan)
    for (const name of [TOOL.write, TOOL.edit, TOOL.delete]) expect(offered).not.toContain(name)
    await agent.close()
  })

  test('outside plan mode exit_plan_mode is not offered', async () => {
    const { agent, model } = setup([{ text: 'hi' }], 'default')
    await agent.session('s').send('go').result
    const offered = toolNamesOf(model.calls[0] as never)
    expect(offered).not.toContain(TOOL.exitPlan)
    expect(offered).toContain(TOOL.write)
    await agent.close()
  })

  test('exit_plan_mode asks; approval switches the mode and the next step offers edit tools', async () => {
    const { agent, engine, model } = setup(
      [
        { toolCalls: [{ toolName: TOOL.exitPlan, input: { plan: '1. write a file' } }] },
        { text: 'Implementing.' },
      ],
      'plan',
    )
    const session = agent.session('s')
    const pending = await session.send('plan it').result
    expect(pending.stop).toBe('tool-pending')
    const approval = pending.pending?.approvals[0]
    expect(approval?.toolName).toBe(TOOL.exitPlan)
    expect(engine.mode).toBe('plan')
    const done = await session.respond({
      approvals: [{ id: approval?.approvalId as string, approved: true }],
    }).result
    expect(done.stop).toBe('complete')
    expect(engine.mode).toBe('default')
    const last = toolNamesOf(model.calls.at(-1) as never)
    expect(last).toContain(TOOL.write)
    expect(last).not.toContain(TOOL.exitPlan)
    expect(JSON.stringify(model.prompts.at(-1))).toContain('Plan mode is off')
    await agent.close()
  })

  test('exit_plan_mode rejected keeps plan mode and shows the feedback', async () => {
    const { agent, engine, model } = setup(
      [
        { toolCalls: [{ toolName: TOOL.exitPlan, input: { plan: 'bad plan' } }] },
        { text: 'Revising.' },
      ],
      'plan',
    )
    const session = agent.session('s')
    const pending = await session.send('plan it').result
    const id = pending.pending?.approvals[0]?.approvalId as string
    await session.respond({ approvals: [{ id, approved: false, reason: 'add tests' }] }).result
    expect(engine.mode).toBe('plan')
    expect(JSON.stringify(model.prompts.at(-1))).toContain('add tests')
    await agent.close()
  })

  test('a mode change takes effect at the next step', async () => {
    const { agent, engine, model } = setup(
      [{ toolCalls: [{ toolName: TOOL.read, input: { path: '/a.txt' } }] }, { text: 'ok' }],
      'default',
    )
    engine.subscribe(() => {})
    const run = agent.session('s').send('go')
    engine.setMode('plan')
    await run.result
    // the mode was already plan when step 0 was prepared or at the latest for step 1
    expect(toolNamesOf(model.calls.at(-1) as never)).not.toContain(TOOL.write)
    await agent.close()
  })

  test('bare deny rules hide the tool', async () => {
    const { agent, model } = setup([{ text: 'hi' }], 'default', { rules: { deny: ['Edit'] } })
    await agent.session('s').send('go').result
    const offered = toolNamesOf(model.calls[0] as never)
    for (const name of [TOOL.write, TOOL.edit, TOOL.delete]) expect(offered).not.toContain(name)
    expect(offered).toContain(TOOL.read)
    await agent.close()
  })

  test('allowedTools and disallowedTools filter with aliases', async () => {
    const only = setup([{ text: 'hi' }], 'default', { plugin: { allowedTools: ['Read'] } })
    await only.agent.session('s').send('go').result
    const offered = toolNamesOf(only.model.calls[0] as never)
    expect(offered).toContain(TOOL.read)
    expect(offered).toContain(TOOL.grep)
    expect(offered).not.toContain(TOOL.write)
    await only.agent.close()
    const without = setup([{ text: 'hi' }], 'default', {
      plugin: { disallowedTools: ['Write', 'grep'] },
    })
    await without.agent.session('s').send('go').result
    const names = toolNamesOf(without.model.calls[0] as never)
    expect(names).toContain(TOOL.read)
    for (const name of [TOOL.write, TOOL.edit, TOOL.delete, TOOL.grep])
      expect(names).not.toContain(name)
    await without.agent.close()
  })

  test('finding 3: grep, list_files and glob outputs hide Read-protected paths', async () => {
    const seed = {
      '/a.txt': 'SECRET plain\n',
      '/.env': 'SECRET=1\n',
      '/sub/.env.local': 'SECRET=2\n',
      '/private/k.txt': 'SECRET key\n',
    }
    const { agent, model } = setup(
      [
        { toolCalls: [{ toolName: TOOL.grep, input: { pattern: 'SECRET' } }] },
        { toolCalls: [{ toolName: TOOL.list, input: { prefix: '/' } }] },
        { text: 'done' },
      ],
      'default',
      { seed, rules: { deny: ['Read(private/**)'] } },
    )
    expect((await agent.session('s').send('go').result).stop).toBe('complete')
    const wire = JSON.stringify(model.prompts)
    expect(wire).toContain('/a.txt:1: SECRET plain')
    expect(wire).not.toContain('SECRET=1')
    expect(wire).not.toContain('SECRET=2')
    expect(wire).not.toContain('SECRET key')
    expect(wire).not.toContain('/sub/.env.local')
    expect(wire).toContain('(3 results hidden by permission rules)')
    await agent.close()
  })

  test('finding 3: read_file of a Read-ask path in a mount still asks', async () => {
    const { agent } = setup(
      [{ toolCalls: [{ toolName: TOOL.read, input: { path: '/.env' } }] }, { text: 'x' }],
      'default',
      { seed: { '/.env': 'A=1\n' } },
    )
    expect((await agent.session('s').send('go').result).stop).toBe('tool-pending')
    await agent.close()
  })

  test('finding 7: the mode option applies to decide and to the tool list', async () => {
    const { agent, engine, fs, model } = setup(
      [write('/new.txt', 'hi'), { text: 'ok' }],
      'bypassPermissions',
      { plugin: { mode: 'plan' } },
    )
    expect(engine.mode).toBe('bypassPermissions')
    const result = await agent.session('s').send('go').result
    expect(result.stop).toBe('complete')
    const offered = toolNamesOf(model.calls[0] as never)
    for (const name of [TOOL.write, TOOL.edit, TOOL.delete, TOOL.exitPlan]) {
      expect(offered).not.toContain(name)
    }
    expect(offered).toContain(TOOL.read)
    expect(JSON.stringify(model.prompts.at(-1))).toContain('unavailable tool')
    expect(await fs.read('/new.txt')).toBeNull()
    await agent.close()
    // without the option the same session writes
    const plain = setup([write('/new.txt', 'hi'), { text: 'ok' }], 'bypassPermissions')
    await plain.agent.session('s').send('go').result
    expect((await plain.fs.read('/new.txt'))?.content).toBe('hi')
    await plain.agent.close()
  })

  test('finding 8: approving the plan restores the mode that was active before plan mode', async () => {
    const { agent, engine } = setup(
      [
        { toolCalls: [{ toolName: TOOL.exitPlan, input: { plan: 'do it' } }] },
        { text: 'Implementing.' },
      ],
      'acceptEdits',
    )
    engine.setMode('plan')
    const session = agent.session('s')
    const pending = await session.send('plan it').result
    expect(pending.stop).toBe('tool-pending')
    const id = pending.pending?.approvals[0]?.approvalId as string
    await session.respond({ approvals: [{ id, approved: true }] }).result
    expect(engine.mode).toBe('acceptEdits')
    await agent.close()
  })

  test('onDecision reports every automatic decision and every answer', async () => {
    const decisions: ApprovalDecision[] = []
    const { agent } = setup(
      [write('/one.txt', '1'), write('/two.txt', '2'), { text: 'done' }],
      'default',
      {
        plugin: { onDecision: (d) => void decisions.push(d) },
        rules: { allow: ['Edit(one.txt)'] },
      },
    )
    const session = agent.session('s')
    let result = await session.send('go').result
    while (result.stop === 'tool-pending') {
      result = await session.respond({
        approvals: (result.pending?.approvals ?? []).map((a) => ({
          id: a.approvalId,
          approved: false,
          reason: 'no',
        })),
      }).result
    }
    expect(decisions.map((d) => [d.toolName, d.approved, d.by])).toEqual([
      [TOOL.write, true, 'plugin:permissions'],
      [TOOL.write, false, 'user'],
    ])
    await agent.close()
  })

  test('a throwing onDecision never breaks the turn', async () => {
    const { agent } = setup([write('/x.txt', 'x'), { text: 'ok' }], 'acceptEdits', {
      plugin: {
        onDecision: () => {
          throw new Error('audit down')
        },
      },
    })
    expect((await agent.session('s').send('go').result).stop).toBe('complete')
    await agent.close()
  })
})

describe('profile (a): autonomous, nobody to ask', () => {
  test('dontAsk with an allow-list: allowed runs, everything else is a denial the model reads', async () => {
    const { agent, fs, model } = setup(
      [write('/src/a.ts', 'ok'), write('/other.txt', 'no'), { text: 'done' }],
      'dontAsk',
      { rules: { allow: ['Edit(src/**)'] } },
    )
    const result = await agent.session('s').send('go').result
    expect(result.stop).toBe('complete')
    expect((await fs.read('/src/a.ts'))?.content).toBe('ok')
    expect(await fs.read('/other.txt')).toBeNull()
    expect(JSON.stringify(model.prompts.at(-1))).toContain('dontAsk')
    await agent.close()
  })

  test('bypassPermissions: deny rules and protected paths still apply', async () => {
    const { agent, fs } = setup(
      [write('/secrets/k', 'x'), write('/free.txt', 'y'), { text: 'done' }],
      'bypassPermissions',
      { rules: { deny: ['Edit(secrets/**)'] } },
    )
    expect((await agent.session('s').send('go').result).stop).toBe('complete')
    expect(await fs.read('/secrets/k')).toBeNull()
    expect((await fs.read('/free.txt'))?.content).toBe('y')
    await agent.close()
  })
})

describe('profile (c): the mode lives outside the process', () => {
  test('a mode function decides per session', async () => {
    const modes: Record<string, PermissionMode> = { reader: 'plan', editor: 'acceptEdits' }
    const { agent, fs, model } = setup(
      [write('/new.txt', 'hi'), { text: 'ok' }, write('/new2.txt', 'hi'), { text: 'ok' }],
      'default',
      { plugin: { mode: (ctx) => modes[ctx.session.id] } },
    )
    await agent.session('reader').send('go').result
    expect(await fs.read('/new.txt')).toBeNull()
    expect(toolNamesOf(model.calls[0] as never)).not.toContain(TOOL.write)
    await agent.session('editor').send('go').result
    expect((await fs.read('/new2.txt'))?.content).toBe('hi')
    await agent.close()
  })

  test('onPlanExit receives the mode to continue in', async () => {
    const exits: Array<[string, string]> = []
    const { agent } = setup(
      [{ toolCalls: [{ toolName: TOOL.exitPlan, input: { plan: 'p' } }] }, { text: 'go' }],
      'default',
      {
        plugin: {
          mode: () => 'plan',
          onPlanExit: (target, ctx) => void exits.push([target, ctx.session.id]),
        },
      },
    )
    const session = agent.session('web-1')
    const pending = await session.send('plan').result
    expect(pending.stop).toBe('tool-pending')
    const id = pending.pending?.approvals[0]?.approvalId as string
    await session.respond({ approvals: [{ id, approved: true }] }).result
    expect(exits).toEqual([['default', 'web-1']])
    await agent.close()
  })

  test('a pending approval survives a restart: a new engine decides the same way', async () => {
    const options = { roots: () => [{ virtual: '/', real: '/' }] }
    const a = createPermissionEngine({ ...options, rules: { allow: ['Edit(src/**)'] } })
    const b = createPermissionEngine({ ...options, rules: { allow: ['Edit(src/**)'] } })
    const call = { toolName: TOOL.write, input: { path: '/lib/a.ts' } }
    expect(b.decide(call)).toEqual(a.decide(call))
  })
})

describe('plugin options', () => {
  test('planExitTool: false registers no plan-exit tool', async () => {
    const { agent, model } = setup([{ text: 'hi' }], 'plan', { plugin: { planExitTool: false } })
    await agent.session('s').send('go').result
    expect(toolNamesOf(model.calls[0] as never)).not.toContain(TOOL.exitPlan)
    await agent.close()
  })

  test('filterOutputs: false leaves listing outputs alone', async () => {
    const { agent, model } = setup(
      [{ toolCalls: [{ toolName: TOOL.grep, input: { pattern: 'SECRET' } }] }, { text: 'done' }],
      'default',
      { seed: { '/.env': 'SECRET=1\n' }, plugin: { filterOutputs: false } },
    )
    await agent.session('s').send('go').result
    expect(JSON.stringify(model.prompts)).toContain('SECRET=1')
    await agent.close()
  })

  test('a custom tool name and kind: its path rules and plan-mode hiding apply', async () => {
    const engine = createPermissionEngine({
      roots: () => [{ virtual: '/', real: '/' }],
      mode: 'plan',
      toolKinds: { scratch_write: { kind: 'write', pathField: 'file' } },
      rules: { deny: ['Edit(secrets/**)'] },
    })
    expect(
      engine.decide({ toolName: 'scratch_write', input: { file: '/secrets/a' } }),
    ).toMatchObject({
      status: 'denied',
      rule: 'Edit(secrets/**)',
    })
    expect(engine.inactiveTools()).toContain('scratch_write')
    expect(engine.inactiveTools('plan', ['mcp__x__y'])).toContain('mcp__x__y')
  })
})
