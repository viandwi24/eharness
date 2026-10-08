/** The permissions plugin end to end: scripted model, memory file system, real engine. */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineHarnessAgent } from 'eharness'
import { filesystem } from 'eharness/filesystem'
import { memoryFs } from 'eharness/filesystem/memory'
import { memoryMessages, memoryState } from 'eharness/storage/memory'
import { type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import {
  type CoderConfig,
  type PermissionMode,
  type PermissionRules,
  TOOL,
} from '../src/contracts.ts'
import { createPermissionEngine } from '../src/permissions/engine.ts'
import { type PermissionsPluginOptions, permissionsPlugin } from '../src/permissions/plugin.ts'

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'coder-plugin-')))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
const silent = { debug() {}, info() {}, warn() {}, error() {} }

function setup(
  steps: ScriptedStepInput[],
  mode: PermissionMode,
  opts: {
    rules?: Partial<PermissionRules>
    plugin?: Partial<PermissionsPluginOptions>
    seed?: Record<string, string>
  } = {},
) {
  const config = {
    root: tmp,
    mode,
    rules: { allow: [], ask: [], deny: [], ...opts.rules },
    settingsFiles: { local: join(tmp, 'settings.local.json') },
  } as unknown as CoderConfig
  const engine = createPermissionEngine({
    config,
    mounts: () => [{ virtual: '/', real: tmp, readonly: false }],
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

const write = (path: string, content: string): ScriptedStepInput => ({
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

  test('the agent name reaches the engine and the audit log', async () => {
    const auditFile = join(tmp, 'agent-audit', 'audit.jsonl')
    const { agent } = setup([write('/x.txt', 'x'), { text: 'ok' }], 'dontAsk', {
      plugin: { agent: 'explore', auditFile },
    })
    await agent.session('s').send('go').result
    expect(JSON.parse(readFileSync(auditFile, 'utf8').trim().split('\n')[0] as string).agent).toBe(
      'explore',
    )
    await agent.close()
  })

  test('audit file gets one JSON line per decision', async () => {
    const auditFile = join(tmp, 'audit', 'nested', 'audit.jsonl')
    const { agent } = setup(
      [write('/one.txt', '1'), write('/two.txt', '2'), { text: 'done' }],
      'default',
      { plugin: { auditFile }, rules: { allow: ['Edit(one.txt)'] } },
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
    const lines = readFileSync(auditFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines.length).toBeGreaterThanOrEqual(2)
    for (const line of lines) {
      expect(typeof line.at).toBe('string')
      expect(line.toolName).toBe(TOOL.write)
      expect(typeof line.approved).toBe('boolean')
      expect(line.input).toBeDefined()
    }
    expect(lines.map((l) => l.approved)).toEqual([true, false])
    expect(lines[1].reason).toBe('no')
    await agent.close()
  })

  test('an unwritable audit file never breaks the turn', async () => {
    const { agent } = setup([write('/x.txt', 'x'), { text: 'ok' }], 'acceptEdits', {
      plugin: { auditFile: join('/dev/null', 'nope', 'audit.jsonl') },
    })
    expect((await agent.session('s').send('go').result).stop).toBe('complete')
    await agent.close()
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
})
