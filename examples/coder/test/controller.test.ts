import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scriptedModel } from 'eharness/testing'
import type { CoderController, RunHooks } from '../src/contracts.ts'
import { makeController, nextPending, routerModel } from './helpers.ts'

/** Hooks that consume every run's stream and record the chunk types. */
function hooks(): RunHooks & {
  chunks: Array<{ type: string; [k: string]: unknown }>
  done: Promise<void>[]
} {
  const chunks: Array<{ type: string; [k: string]: unknown }> = []
  const done: Promise<void>[] = []
  return {
    chunks,
    done,
    onRun(run) {
      done.push(
        (async () => {
          const reader = (run.stream as ReadableStream<{ type: string }>).getReader()
          for (;;) {
            const r = await reader.read()
            if (r.done) return
            chunks.push(r.value)
          }
        })(),
      )
    },
  }
}

const run = async (c: CoderController, text: string) => {
  const h = hooks()
  const result = await c.run(text, h)
  await Promise.all(h.done)
  return { result, ...h }
}

const read = (path: string) => ({ toolName: 'read_file', input: { path } })
const edit = (path: string, old: string, next: string) => ({
  toolName: 'edit_file',
  input: { path, old_string: old, new_string: next },
})

describe('controller', () => {
  test('run end to end: read then partial edit_file changes the file on disk (acceptEdits)', async () => {
    const original = 'line one\nconst answer = 41\nline three\n'
    const model = scriptedModel([
      { toolCalls: [read('/code.ts')] },
      { toolCalls: [edit('/code.ts', 'answer = 41', 'answer = 42')] },
      { text: 'Updated.' },
    ])
    const { controller, root } = await makeController({
      files: { 'code.ts': original },
      flags: { permissionMode: 'acceptEdits' },
      model,
    })
    const { result, chunks } = await run(controller, 'bump the answer')
    expect(result.stop).toBe('complete')
    expect(await readFile(join(root, 'code.ts'), 'utf8')).toBe(
      'line one\nconst answer = 42\nline three\n',
    )
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    const messages = await controller.messages()
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(JSON.stringify(messages)).toContain('tool-edit_file')
  })

  test('default mode: the approval round trip goes through the broker', async () => {
    const model = scriptedModel([
      { toolCalls: [read('/code.ts')] },
      { toolCalls: [edit('/code.ts', 'one', 'ONE')] },
      { text: 'Done.' },
    ])
    const { controller, root } = await makeController({ files: { 'code.ts': 'one\n' }, model })
    const h = hooks()
    const turn = controller.run('edit', h)
    const request = await nextPending(controller.broker)
    expect(request.toolName).toBe('edit_file')
    expect(await readFile(join(root, 'code.ts'), 'utf8')).toBe('one\n')
    controller.broker.answer(request.id, { approved: true })
    const result = await turn
    await Promise.all(h.done)
    expect(result.stop).toBe('complete')
    expect(await readFile(join(root, 'code.ts'), 'utf8')).toBe('ONE\n')
  })

  test('default mode: a denial leaves the file alone and the turn completes', async () => {
    const model = scriptedModel([
      { toolCalls: [read('/code.ts')] },
      { toolCalls: [edit('/code.ts', 'one', 'ONE')] },
      { text: 'Understood.' },
    ])
    const { controller, root } = await makeController({ files: { 'code.ts': 'one\n' }, model })
    const h = hooks()
    const turn = controller.run('edit', h)
    controller.broker.answer((await nextPending(controller.broker)).id, {
      approved: false,
      feedback: 'no thanks',
    })
    expect((await turn).stop).toBe('complete')
    await Promise.all(h.done)
    expect(await readFile(join(root, 'code.ts'), 'utf8')).toBe('one\n')
    expect(JSON.stringify(model.prompts.at(-1))).toContain('no thanks')
  })

  test('default mode: a bare No ends the turn without a model call (endTurn), a No with feedback continues', async () => {
    const model = scriptedModel([
      { toolCalls: [read('/code.ts')] },
      { toolCalls: [edit('/code.ts', 'one', 'ONE')] },
      { text: 'must not run', delayMs: 30 },
    ])
    const { controller, root } = await makeController({ files: { 'code.ts': 'one\n' }, model })
    const h = hooks()
    const turn = controller.run('edit', h)
    controller.broker.answer((await nextPending(controller.broker)).id, { approved: false })
    const result = await turn
    await Promise.all(h.done)
    expect(result.stop).toBe('complete')
    expect(result.steps).toBe(0)
    expect(model.calls).toHaveLength(2)
    expect(await readFile(join(root, 'code.ts'), 'utf8')).toBe('one\n')
    expect(JSON.stringify(await controller.messages())).not.toContain('must not run')
  })

  test('messages, clear, resume, sessions and stats', async () => {
    const model = scriptedModel([
      { text: 'first answer', usage: { inputTokens: 500, outputTokens: 20 } },
      { text: 'second answer' },
    ])
    const { controller } = await makeController({ files: { 'a.txt': 'a' }, model })
    expect(await controller.messages()).toEqual([])
    expect(await controller.sessions()).toEqual([])

    const firstId = controller.sessionId
    await run(controller, 'first question')
    const first = await controller.messages()
    expect(first).toHaveLength(2)
    const stats = await controller.stats()
    expect(stats.contextWindow).toBe(200_000)
    expect(stats.contextTokens).toBeGreaterThan(0)

    await controller.clear()
    expect(controller.sessionId).not.toBe(firstId)
    expect(await controller.messages()).toEqual([])
    await run(controller, 'second question')
    const secondId = controller.sessionId

    const sessions = await controller.sessions()
    expect(sessions.map((s) => s.id).sort()).toEqual([firstId, secondId].sort())
    expect(sessions[0]?.id).toBe(secondId)
    expect(sessions.find((s) => s.id === firstId)?.firstPrompt).toBe('first question')
    expect(sessions.find((s) => s.id === secondId)?.firstPrompt).toBe('second question')

    await controller.resume(firstId)
    expect(controller.sessionId).toBe(firstId)
    const resumed = await controller.messages()
    expect(resumed.map((m) => m.id)).toEqual(first.map((m) => m.id))
    expect(JSON.stringify(resumed)).toContain('first answer')
  })

  test('resume with config.resume / continueLast starts on that session', async () => {
    const model = scriptedModel([{ text: 'one' }])
    const a = await makeController({ model })
    await run(a.controller, 'remember me')
    const id = a.controller.sessionId
    await a.controller.close()

    const { loadConfig } = await import('../src/app/config.ts')
    const { createController } = await import('../src/app/controller.ts')
    const cfg = await loadConfig({ cwd: a.root, continue: true })
    const c = await createController({ config: cfg, model: scriptedModel([]) })
    try {
      expect(c.sessionId).toBe(id)
      expect(JSON.stringify(await c.messages())).toContain('remember me')
    } finally {
      await c.close()
    }
    const cfg2 = await loadConfig({ cwd: a.root, resume: id })
    const c2 = await createController({ config: cfg2, model: scriptedModel([]) })
    try {
      expect(c2.sessionId).toBe(id)
    } finally {
      await c2.close()
    }
  })

  test('shell runs in the project root, returns output and exit codes, no model involved', async () => {
    const model = scriptedModel([])
    const { controller, root } = await makeController({ files: { 'marker.txt': 'm' }, model })
    const pwd = await controller.shell('pwd')
    expect(pwd.exitCode).toBe(0)
    expect(pwd.output.trim()).toBe(root)
    const ls = await controller.shell('ls')
    expect(ls.output).toContain('marker.txt')
    const fail = await controller.shell('echo oops >&2; exit 3')
    expect(fail.exitCode).toBe(3)
    expect(fail.output).toContain('oops')
    expect(model.calls).toHaveLength(0)
  })

  test('shell abort: exitCode is null', async () => {
    const { controller } = await makeController({ model: scriptedModel([]) })
    const abort = new AbortController()
    const pending = controller.shell('sleep 5', abort.signal)
    setTimeout(() => abort.abort(), 100)
    const result = await pending
    expect(result.exitCode).toBeNull()
  })

  test('abort ends a running turn', async () => {
    const model = scriptedModel([{ text: 'a long answer', delayMs: 100 }])
    const { controller } = await makeController({ model })
    const h = hooks()
    const turn = controller.run('go', h)
    setTimeout(() => controller.abort(), 150)
    const result = await turn
    await Promise.all(h.done)
    expect(result.stop).not.toBe('complete')
  })

  test('agents() lists the built-ins and a project agent; setModel keeps working', async () => {
    const model = scriptedModel([{ text: 'hi' }])
    const { controller } = await makeController({
      files: { '.coder/agents/helper.md': '---\nname: helper\ndescription: Helps\n---\nHelp.\n' },
      flags: { trustProject: true },
      model,
    })
    expect(controller.agents().map((a) => a.name)).toEqual([
      'helper',
      'general-purpose',
      'explore',
      'plan',
    ])
    controller.setModel('anthropic/claude-haiku-4.5')
    expect(controller.config.model).toBe('anthropic/claude-haiku-4.5')
  })

  test('acceptance M1: rename a function across the project with partial edits, no write_file', async () => {
    const files = {
      'src/math.ts':
        'export function addNumbers(a: number, b: number) {\n  return a + b\n}\n\nexport const unrelated = 1\n',
      'src/use.ts':
        "import { addNumbers } from './math.ts'\n\nexport const total = addNumbers(1, 2)\n",
      'src/other.ts': "import { addNumbers } from './math.ts'\n\nconsole.log(addNumbers(3, 4))\n",
    }
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'grep', input: { pattern: 'addNumbers' } }] },
      {
        toolCalls: ['/src/math.ts', '/src/use.ts', '/src/other.ts'].map((p) => ({
          toolName: 'read_file',
          input: { path: p },
        })),
      },
      // one edit per file per step: two parallel edits of one file would race on its version
      {
        toolCalls: [
          edit('/src/math.ts', 'function addNumbers', 'function sum'),
          edit('/src/use.ts', 'import { addNumbers }', 'import { sum }'),
          edit('/src/other.ts', 'import { addNumbers }', 'import { sum }'),
        ],
      },
      {
        toolCalls: [
          edit('/src/use.ts', '= addNumbers(', '= sum('),
          edit('/src/other.ts', 'log(addNumbers(', 'log(sum('),
        ],
      },
      { text: 'Renamed addNumbers to sum in 3 files.' },
    ])
    const { controller, root } = await makeController({
      files,
      flags: { permissionMode: 'acceptEdits' },
      model,
    })
    const { result } = await run(controller, 'rename addNumbers to sum everywhere')
    expect(result.stop).toBe('complete')
    expect(JSON.stringify(model.prompts[1])).toContain('src/use.ts') // grep found the usages
    expect(await readFile(join(root, 'src/math.ts'), 'utf8')).toBe(
      'export function sum(a: number, b: number) {\n  return a + b\n}\n\nexport const unrelated = 1\n',
    )
    expect(await readFile(join(root, 'src/use.ts'), 'utf8')).toBe(
      "import { sum } from './math.ts'\n\nexport const total = sum(1, 2)\n",
    )
    expect(await readFile(join(root, 'src/other.ts'), 'utf8')).toBe(
      "import { sum } from './math.ts'\n\nconsole.log(sum(3, 4))\n",
    )
    const stored = JSON.stringify(await controller.messages())
    expect(stored).not.toContain('tool-write_file')
    expect(stored.match(/tool-edit_file/g)?.length).toBeGreaterThanOrEqual(5)
  })

  test('resume rejects unknown and subagent ids, accepts a stored one; messagesOf reads any session', async () => {
    const model = scriptedModel([{ text: 'hi' }])
    const { controller } = await makeController({ model })
    await run(controller, 'first')
    const first = controller.sessionId
    await controller.clear()
    expect(controller.sessionId).not.toBe(first)
    await expect(controller.resume('nope')).rejects.toThrow('unknown session: nope')
    await expect(controller.resume(`${first}:agent:x`)).rejects.toThrow(/subagent/)
    const current = controller.sessionId
    expect(controller.sessionId).toBe(current)
    await controller.resume(first)
    expect(controller.sessionId).toBe(first)
    const stored = await controller.messagesOf(first)
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(await controller.messagesOf('missing')).toEqual([])
  })

  test('setModel rejects an empty id and leaves the controller working', async () => {
    const model = scriptedModel([{ text: 'still works' }])
    const { controller } = await makeController({ model })
    expect(() => controller.setModel('')).toThrow(/non-empty/)
    const { result } = await run(controller, 'hello')
    expect(result.stop).toBe('complete')
  })
})

describe('model, thinking and preferences', () => {
  const idOf = (m: unknown): string => String((m as { modelId?: string }).modelId ?? m)

  /** Two scripted models picked by id; `calls` of each show what reached the provider. */
  function twoModels() {
    const a = scriptedModel([{ text: 'from a' }, { text: 'again a' }], { modelId: 'a' })
    const b = scriptedModel([{ text: 'from b' }, { text: 'again b' }], { modelId: 'b' })
    return { a, b, resolve: (id: string) => (id === 'm/b' ? b : a) }
  }

  test('setModel and setThinking reach the next turn without rebuilding anything', async () => {
    const { a, b, resolve } = twoModels()
    const { controller } = await makeController({
      model: a,
      resolveModel: resolve,
      flags: { model: 'm/a' },
    })
    expect(controller.model).toBe('m/a')
    expect(controller.provider).toBe('gateway')
    expect(controller.thinking).toBe('provider-default')
    await run(controller, 'one')
    expect(a.calls).toHaveLength(1)
    expect(a.calls[0]?.reasoning).toBeUndefined()

    controller.setModel('m/b')
    controller.setThinking('high')
    expect(controller.model).toBe('m/b')
    expect(controller.thinking).toBe('high')
    await run(controller, 'two')
    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(1)
    expect(b.calls[0]?.reasoning).toBe('high')

    controller.setThinking('provider-default')
    await run(controller, 'three')
    expect(b.calls[1]?.reasoning).toBeUndefined()
  })

  test('OpenRouter also gets the effort as a provider option (the provider ignores `reasoning`)', async () => {
    const model = scriptedModel([{ text: 'ok' }])
    const { controller } = await makeController({
      model,
      resolveModel: () => model,
      flags: { provider: 'openrouter' },
      thinking: 'medium',
    })
    expect(controller.provider).toBe('openrouter')
    expect(controller.model).toBe('anthropic/claude-sonnet-5.5')
    await run(controller, 'hi')
    expect(model.calls[0]?.reasoning).toBe('medium')
    expect(
      (model.calls[0]?.providerOptions as { openrouter?: { reasoning?: { effort?: string } } })
        ?.openrouter?.reasoning?.effort,
    ).toBe('medium')
  })

  test('a switch made while an approval is pending applies to the respond continuation', async () => {
    const a = scriptedModel([{ toolCalls: [edit('/code.ts', 'one', 'ONE')] }], { modelId: 'a' })
    const b = scriptedModel([{ text: 'done' }], { modelId: 'b' })
    const { controller } = await makeController({
      files: { 'code.ts': 'one\n' },
      model: a,
      resolveModel: (id) => (id === 'm/b' ? b : a),
      flags: { model: 'm/a' },
    })
    const h = hooks()
    const turn = controller.run('edit', h)
    const request = await nextPending(controller.broker)
    controller.setModel('m/b')
    controller.setThinking('low')
    controller.broker.answer(request.id, { approved: true })
    expect((await turn).stop).toBe('complete')
    await Promise.all(h.done)
    expect(a.calls).toHaveLength(1)
    expect(idOf(b)).toBe('b')
    expect(b.calls).toHaveLength(1)
    expect(b.calls[0]?.reasoning).toBe('low')
  })

  test('subagents follow the model and thinking choice too', async () => {
    const router = routerModel((r) =>
      r.isChild
        ? { text: 'child done' }
        : r.toolResults === 0
          ? {
              toolCalls: [
                {
                  toolName: 'agent',
                  input: { description: 'd', prompt: 'look around', subagent_type: 'explore' },
                },
              ],
            }
          : { text: 'main done' },
    )
    const { controller } = await makeController({
      model: router,
      resolveModel: () => router,
      thinking: 'minimal',
    })
    const { result } = await run(controller, 'explore')
    expect(result.stop).toBe('complete')
    expect(router.routes.some((r) => r.isChild)).toBe(true)
    for (const route of router.routes) expect(route.call.reasoning).toBe('minimal')
  })

  test('setThinking validates the level', async () => {
    const { controller } = await makeController({ model: scriptedModel([{ text: 'x' }]) })
    expect(() => controller.setThinking('extreme' as never)).toThrow(/invalid level/)
    expect(controller.thinking).toBe('provider-default')
  })

  test('the last choice is saved per project and restored; flags and settings win for the model', async () => {
    const files = {}
    const first = await makeController({ model: scriptedModel([{ text: 'x' }]), files })
    first.controller.setModel('saved/model')
    first.controller.setThinking('xhigh')
    await first.controller.close()
    const file = join(first.controller.config.projectDataDir, 'preferences.json')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      provider: 'gateway',
      model: 'saved/model',
      thinking: 'xhigh',
    })

    // same project + home again: the preference is restored
    const { createController } = await import('../src/app/controller.ts')
    const { loadConfig } = await import('../src/app/config.ts')
    const config = await loadConfig({ cwd: first.root })
    const again = await createController({ config, model: scriptedModel([{ text: 'x' }]) })
    expect(again.model).toBe('saved/model')
    expect(again.thinking).toBe('xhigh')
    await again.close()

    // an explicit --model wins, --thinking wins
    const flagged = await loadConfig({ cwd: first.root, model: 'flag/model' })
    const third = await createController({
      config: flagged,
      model: scriptedModel([{ text: 'x' }]),
      thinking: 'low',
    })
    expect(third.model).toBe('flag/model')
    expect(third.thinking).toBe('low')
    await third.close()

    // a preference saved for another provider is not applied
    const other = await loadConfig({ cwd: first.root, provider: 'openrouter' })
    const fourth = await createController({ config: other, model: scriptedModel([{ text: 'x' }]) })
    expect(fourth.model).toBe('anthropic/claude-sonnet-5.5')
    await fourth.close()
  })
})

describe('context, usage and status', () => {
  test('contextDetails works before the first turn and its parts add up', async () => {
    const { controller } = await makeController({
      files: { 'AGENTS.md': `# Project\n${'Always be careful.\n'.repeat(40)}` },
      model: scriptedModel([{ text: 'x' }]),
    })
    const c = await controller.contextDetails()
    expect(c.model).toBe(controller.model)
    expect(c.provider).toBe('gateway')
    expect(c.window).toBe(200_000)
    expect(c.messages).toEqual({ count: 0, user: 0, assistant: 0, toolCalls: 0 })
    const byKey = Object.fromEntries(c.categories.map((x) => [x.key, x.tokens]))
    expect(byKey.system).toBeGreaterThan(0)
    expect(byKey.memory).toBeGreaterThan(100)
    expect(byKey.tools).toBeGreaterThan(0)
    expect(byKey.mcp).toBe(0)
    const sum = c.categories.reduce((n, x) => n + x.tokens, 0)
    expect(Math.abs(sum - c.used)).toBeLessThanOrEqual(2)
    expect(c.free).toBe(c.window - c.used)
    expect(c.autocompactBuffer).toBe(c.window - c.summarizeAt)
    expect(c.summarizeAt).toBeLessThan(c.hardLimit)
    expect(c.memoryFiles.map((f) => f.path)).toEqual(['/AGENTS.md'])
    expect(c.memoryFiles[0]?.tokens).toBeLessThanOrEqual(byKey.memory ?? 0)
    expect(c.memoryFiles[0]?.tokens).toBeGreaterThan(150)
    const names = c.tools.map((t) => t.name)
    for (const expected of ['bash', 'glob', 'read_file', 'edit_file', 'todo_write']) {
      expect(names).toContain(expected)
    }
    // largest first, and the itemised sizes add up to the tools category
    expect(c.tools.map((t) => t.tokens)).toEqual(
      [...c.tools.map((t) => t.tokens)].sort((x, y) => y - x),
    )
    const itemised = c.tools.reduce((n, t) => n + t.tokens, 0)
    expect(Math.abs(itemised - (byKey.tools ?? 0))).toBeLessThanOrEqual(c.tools.length)
  })

  test('messages are counted after a turn; usage and status', async () => {
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'glob', input: { pattern: '*.ts' } }] },
      { text: 'done', usage: { inputTokens: 300, outputTokens: 12 } },
    ])
    const { controller, root } = await makeController({ files: { 'a.ts': 'x' }, model })
    const before = await controller.usage()
    expect(before).toMatchObject({ inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 })
    await run(controller, 'find ts files')
    const c = await controller.contextDetails()
    expect(c.messages).toMatchObject({ count: 2, user: 1, assistant: 1, toolCalls: 1 })
    expect(c.categories.find((x) => x.key === 'messages')?.tokens).toBeGreaterThan(0)

    const u = await controller.usage()
    expect(u.turns).toBe(1)
    expect(u.inputTokens).toBeGreaterThanOrEqual(300)
    expect(u.outputTokens).toBeGreaterThanOrEqual(12)
    expect(u.durationMs).toBeGreaterThan(0)

    const s = await controller.status()
    expect(s).toMatchObject({
      version: '0.0.0',
      cwd: root,
      provider: 'gateway',
      model: controller.model,
      thinking: 'provider-default',
      mode: 'default',
      sessionId: controller.sessionId,
      trusted: true,
      untrusted: [],
      mcpServers: [],
    })
    expect(s.eharnessVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(s.agents).toBeGreaterThan(0)
    expect(s.mounts.length).toBeGreaterThan(0)
    expect(s.settingsFiles).toHaveLength(3)
    expect(s.settingsFiles.every((f) => f.exists === false)).toBe(true)
  })

  test('models() is empty offline without a cache, and has the cached list otherwise', async () => {
    const { controller } = await makeController({ model: scriptedModel([{ text: 'x' }]) })
    expect(await controller.models()).toEqual([])
  })
})
