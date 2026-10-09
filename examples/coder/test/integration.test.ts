/**
 * Integration of the new backend modules through the real controller: checkpoints and rewind,
 * session tools, tasks (background bash and agents, woken turns), hooks, settings, output
 * styles, question timeout, doctor, status line, memory, LSP, sandbox and image input. Scripted
 * models, temp dirs, no network.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { detectOsSandbox } from 'eharness/shell'
import { scriptedModel } from 'eharness/testing'
import { QUESTION_TIMEOUT_NOTE } from '../src/app/ask-timeout.ts'
import type { CoderController, RunHooks } from '../src/contracts.ts'
import { makeController, onCleanup, routerModel, tempDir } from './helpers.ts'

const FAKE_LSP = join(import.meta.dir, 'fixtures', 'fake-lsp.ts')

type Chunk = { type: string; [k: string]: unknown }

/** Hooks that consume every run's stream and record the chunks. */
function hooks(): RunHooks & { chunks: Chunk[]; done: Promise<void>[] } {
  const chunks: Chunk[] = []
  const done: Promise<void>[] = []
  return {
    chunks,
    done,
    onRun(run) {
      done.push(
        (async () => {
          const reader = (run.stream as ReadableStream<Chunk>).getReader()
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

async function turn(
  c: CoderController,
  text: string,
  opts?: Parameters<CoderController['run']>[2],
) {
  const h = hooks()
  const result = await c.run(text, h, opts)
  await Promise.all(h.done)
  return { result, ...h }
}

async function until(check: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for a condition')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Approve every approval the broker shows; returns what was asked. */
function approveAll(c: CoderController): Array<{ toolName: string; input: unknown }> {
  const asked: Array<{ toolName: string; input: unknown }> = []
  const answered = new Set<string>()
  const off = c.broker.subscribe((pending) => {
    for (const request of pending) {
      if (answered.has(request.id)) continue
      answered.add(request.id)
      asked.push({ toolName: request.toolName, input: request.input })
      queueMicrotask(() => c.broker.answer(request.id, { approved: true }))
    }
  })
  onCleanup(async () => off())
  return asked
}

const read = (path: string) => ({ toolName: 'read_file', input: { path } })
const edit = (path: string, old: string, next: string) => ({
  toolName: 'edit_file',
  input: { path, old_string: old, new_string: next },
})
const bash = (input: Record<string, unknown>) => ({ toolName: 'bash', input })

describe('checkpoints and rewind', () => {
  async function twoTurns() {
    const model = scriptedModel([
      { toolCalls: [read('/a.txt')] },
      { toolCalls: [edit('/a.txt', 'one', 'two')] },
      { text: 'first done' },
      { text: 'second done' },
    ])
    const made = await makeController({
      files: { 'a.txt': 'one\n' },
      flags: { permissionMode: 'acceptEdits' },
      model,
    })
    await turn(made.controller, 'change it')
    await turn(made.controller, 'and then?')
    return made
  }

  test('rewind code restores the file and keeps the session; conversation and both switch session', async () => {
    const { controller, root } = await twoTurns()
    const file = join(root, 'a.txt')
    expect(await readFile(file, 'utf8')).toBe('two\n')

    const points = await controller.rewindPoints()
    expect(points.map((p) => p.text)).toEqual(['and then?', 'change it'])
    expect(points[1]?.files).toEqual(['a.txt'])
    expect(points[0]?.files).toEqual([])

    const before = controller.sessionId
    const code = await controller.rewind(points[1]?.messageId as string, 'code')
    expect(code.restoredFiles).toEqual(['a.txt'])
    expect(code.sessionId).toBeUndefined()
    expect(controller.sessionId).toBe(before)
    expect(await readFile(file, 'utf8')).toBe('one\n')

    const both = await controller.rewind(points[0]?.messageId as string, 'conversation')
    expect(both.prompt).toBe('and then?')
    expect(both.sessionId).toBeDefined()
    expect(controller.sessionId).toBe(both.sessionId as string)
    expect(controller.sessionId).not.toBe(before)
    // the new session holds the conversation before the point; the old one is untouched
    expect((await controller.messages()).map((m) => m.role)).toEqual(['user', 'assistant'])
    expect((await controller.messagesOf(before)).length).toBe(4)
  })

  test('rewind both: new session without the turn and the file restored', async () => {
    const { controller, root } = await twoTurns()
    const [, first] = await controller.rewindPoints()
    const before = controller.sessionId
    const result = await controller.rewind(first?.messageId as string, 'both')
    expect(result.restoredFiles).toEqual(['a.txt'])
    expect(controller.sessionId).not.toBe(before)
    expect(await controller.messages()).toEqual([])
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one\n')
  })
})

describe('session tools', () => {
  test('rename, branch, names in sessions(), export and assistantText', async () => {
    const model = scriptedModel([{ text: 'Hello there' }, { text: 'Second answer' }])
    const { controller } = await makeController({ model })
    await turn(controller, 'first question')
    await turn(controller, 'second question')

    expect(controller.sessionName).toBeUndefined()
    await controller.rename('  My   work ')
    expect(controller.sessionName).toBe('My work')

    const exported = await controller.exportText()
    expect(exported).toContain('first question')
    expect(exported).toContain('Hello there')
    expect(await controller.assistantText()).toBe('Second answer')
    expect(await controller.assistantText(2)).toBe('Hello there')
    expect(await controller.assistantText(3)).toBeUndefined()

    const original = controller.sessionId
    const branched = await controller.branch()
    expect(branched).not.toBe(original)
    expect(controller.sessionId).toBe(branched)
    expect(controller.sessionName).toBe('My work (branch)')
    expect((await controller.messages()).length).toBe(4)
    const named = await controller.branch('experiment')
    expect(controller.sessionName).toBe('experiment')

    const sessions = await controller.sessions()
    const names = Object.fromEntries(sessions.map((s) => [s.id, s.name]))
    expect(names[original]).toBe('My work')
    expect(names[branched]).toBe('My work (branch)')
    expect(names[named]).toBe('experiment')
  })

  test('compact with focus reaches the summarizer prompt', async () => {
    const texts = Array.from({ length: 8 }, (_, i) => ({ text: `answer ${i}` }))
    const model = scriptedModel([...texts, { text: 'THE SUMMARY' }])
    const { controller } = await makeController({ model })
    for (let i = 0; i < 8; i++) await turn(controller, `request number ${i}`)
    await controller.compact('keep the open TODOs about the lexer')
    const summarizer = JSON.stringify(model.prompts.at(-1))
    expect(summarizer).toContain('keep the open TODOs about the lexer')
    expect(summarizer).toContain('request number 0')
  })
})

describe('background tasks', () => {
  test('background bash: started, read with bash_output, exit injected, woken turn driven through the broker', async () => {
    const model = scriptedModel([
      {
        toolCalls: [
          bash({ command: 'echo started; sleep 0.5; echo finished', run_in_background: true }),
        ],
      },
      { text: 'started it' },
      // the woken turn: asks for approval (touch), reads the output, answers
      { toolCalls: [bash({ command: 'touch woke.txt' })] },
      { toolCalls: [{ toolName: 'bash_output', input: { id: 'bash-1' } }] },
      { text: 'woken answer' },
    ])
    const { controller, root } = await makeController({ model })
    const asked = approveAll(controller)
    const h = hooks()
    const result = await controller.run('serve it', h)
    expect(result.stop).toBe('complete')
    expect(controller.tasks().map((t) => [t.id, t.kind])).toEqual([['bash-1', 'shell']])

    await until(() => existsSync(join(root, 'woke.txt')))
    await until(() => h.chunks.some((c) => c.type === 'text-delta' && c.delta === 'woken answer'))
    await Promise.all(h.done)
    expect(controller.tasks()[0]).toMatchObject({ status: 'completed', exitCode: 0 })
    expect(await controller.taskOutput('bash-1')).toContain('finished')
    // the wake turn saw the event, and only the touch was asked: bash_output never prompts
    expect(JSON.stringify(model.prompts[2])).toContain('exited with code 0')
    expect(asked.map((a) => a.toolName)).toEqual(['bash', 'bash'])
    expect(JSON.stringify(model.prompts[4])).toContain('finished')
    const texts = (await controller.messages()).map((m) =>
      m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''),
    )
    expect(texts.join('\n')).toContain('woken answer')
  })

  test('bash_output, kill_shell and lsp never prompt, in plan mode too', async () => {
    const { controller } = await makeController({ model: scriptedModel([]) })
    for (const mode of ['default', 'plan'] as const) {
      for (const toolName of ['bash_output', 'kill_shell', 'lsp']) {
        expect(
          controller.permissions.decide({ toolName, input: { id: 'bash-1' } }, mode).status,
        ).toBe('approved')
      }
    }
  })

  test('close stops running background shells', async () => {
    const model = scriptedModel([
      { toolCalls: [bash({ command: 'sleep 30', run_in_background: true })] },
      { text: 'ok' },
    ])
    const { controller } = await makeController({
      model,
      flags: { permissionMode: 'bypassPermissions' },
    })
    await turn(controller, 'start a server')
    expect(controller.tasks()[0]?.status).toBe('running')
    const seen: string[] = []
    const off = controller.onTasks((tasks) => seen.push(...tasks.map((t) => t.status)))
    await controller.stopTask('bash-1')
    expect(controller.tasks()[0]?.status).toBe('stopped')
    expect(seen).toContain('stopped')
    off()
  })

  test('background agent: completion is injected and the woken turn sees the report', async () => {
    const model = routerModel((route) => {
      if (route.isChild) return { text: 'CHILD REPORT 42', delayMs: 300 }
      if (route.conversation.includes('Background subagent')) return { text: 'noted the report' }
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
    const h = hooks()
    await controller.run('explore in the background', h)
    expect(controller.tasks()[0]).toMatchObject({ id: 'agent-1', kind: 'agent', status: 'running' })
    await until(() => controller.tasks()[0]?.status === 'completed')
    await until(() =>
      h.chunks.some((c) => c.type === 'text-delta' && c.delta === 'noted the report'),
    )
    await Promise.all(h.done)
    expect(model.routes.some((r) => !r.isChild && r.conversation.includes('CHILD REPORT 42'))).toBe(
      true,
    )
  })
})

describe('subagent runs', () => {
  test('the run part is stored, so /agents can open the transcript after a resume', async () => {
    const model = routerModel((route) => {
      if (route.isChild) return { text: 'CHILD ANSWER' }
      return route.toolResults === 0
        ? {
            toolCalls: [
              {
                toolName: 'agent',
                input: {
                  subagent_type: 'explore',
                  description: 'look around',
                  prompt: 'look',
                  run_in_background: false,
                },
              },
            ],
          }
        : { text: 'done' }
    })
    const { controller } = await makeController({
      model,
      flags: { permissionMode: 'bypassPermissions' },
    })
    await turn(controller, 'explore')
    const id = controller.sessionId
    await controller.clear()
    await controller.resume(id)
    const part = (await controller.messages())
      .flatMap((m) => m.parts)
      .find((p) => (p.type as string) === 'data-subagent.run') as unknown as {
      data: { sessionId: string; agent: string; status: string }
    }
    expect(part.data).toMatchObject({ agent: 'explore', status: 'done' })
    expect(part.data.sessionId).toBe(`${id}:agent:call-0-0`)
    const child = await controller.messagesOf(part.data.sessionId)
    expect(JSON.stringify(child)).toContain('CHILD ANSWER')
  })
})

describe('hooks', () => {
  test('PreToolUse deny and PostToolUse context through a real turn', async () => {
    const model = scriptedModel([
      { toolCalls: [read('/a.txt')] },
      { toolCalls: [bash({ command: 'ls' })] },
      { text: 'done' },
    ])
    const { controller } = await makeController({
      files: { 'a.txt': 'hello\n' },
      flags: { permissionMode: 'acceptEdits' },
      model,
      homeFiles: {
        'settings.json': JSON.stringify({
          hooks: {
            PreToolUse: [{ matcher: 'bash', command: 'echo "blocked by policy" >&2; exit 2' }],
            PostToolUse: [
              {
                matcher: 'read_file',
                command: `echo '{"additionalContext":"HOOK-CONTEXT-XYZ"}'`,
              },
            ],
          },
        }),
      },
    })
    const { result } = await turn(controller, 'look')
    expect(result.stop).toBe('complete')
    const prompts = JSON.stringify(model.prompts)
    expect(prompts).toContain('HOOK-CONTEXT-XYZ')
    expect(prompts).toContain('blocked by policy')
    expect(controller.broker.pending()).toEqual([])
  })

  test('Notification hooks run when an approval is shown', async () => {
    const model = scriptedModel([
      { toolCalls: [read('/a.txt')] },
      { toolCalls: [edit('/a.txt', 'one', 'two')] },
      { text: 'ok' },
    ])
    const { controller, root } = await makeController({
      files: { 'a.txt': 'one\n' },
      model,
      homeFiles: {
        'settings.json': JSON.stringify({
          hooks: { Notification: [{ command: 'cat > notification.json' }] },
        }),
      },
    })
    const h = hooks()
    const running = controller.run('edit', h)
    const request = await (async () => {
      await until(() => controller.broker.pending().length > 0)
      return controller.broker.pending()[0]
    })()
    controller.broker.answer(request?.id as string, { approved: true })
    await running
    await Promise.all(h.done)
    await until(() => existsSync(join(root, 'notification.json')))
    expect(JSON.parse(await readFile(join(root, 'notification.json'), 'utf8')).message).toContain(
      'Permission needed',
    )
  })
})

describe('settings, output styles, status line', () => {
  test('updateSetting applies live and is readable through setting()', async () => {
    const { controller } = await makeController({ model: scriptedModel([]) })
    expect(controller.setting('theme')).toBeUndefined()
    await controller.updateSetting('theme', 'light', 'user')
    expect(controller.setting('theme')).toBe('light')
    await controller.updateSetting('permissions.defaultMode', 'plan', 'local')
    expect(controller.permissions.mode).toBe('plan')
    expect((await controller.status()).mode).toBe('plan')
    await controller.updateSetting('thinking', 'high', 'local')
    expect(controller.thinking).toBe('high')
    const views = await controller.settings()
    expect(views.find((v) => v.key === 'theme')).toMatchObject({ value: 'light', source: 'user' })
    await expect(controller.updateSetting('theme', 'purple', 'user')).rejects.toThrow()
  })

  test('an output style switch reaches the next turn, not the previous one', async () => {
    const model = routerModel(() => ({ text: 'ok' }))
    const { controller } = await makeController({
      model,
      homeFiles: {
        'output-styles/pirate.md':
          '---\ndescription: Talk like a pirate\n---\nAlways answer like a PIRATEBODY.',
      },
    })
    expect((await controller.outputStyles()).map((s) => s.name)).toEqual(
      expect.arrayContaining(['default', 'concise', 'pirate']),
    )
    await turn(controller, 'one')
    expect(model.routes.at(-1)?.system).not.toContain('PIRATEBODY')
    await controller.updateSetting('outputStyle', 'pirate', 'user')
    await turn(controller, 'two')
    expect(model.routes.at(-1)?.system).toContain('Output style: pirate')
    expect(model.routes.at(-1)?.system).toContain('PIRATEBODY')
    await controller.updateSetting('outputStyle', 'concise', 'user')
    await turn(controller, 'three')
    expect(model.routes.at(-1)?.system).toContain('Output style: concise')
    expect(model.routes.at(-1)?.system).not.toContain('PIRATEBODY')
  })

  test('status line text comes from the command', async () => {
    const { controller } = await makeController({ model: scriptedModel([]) })
    expect(await controller.statusLineText()).toBeUndefined()
    await controller.updateSetting(
      'statusLine.command',
      'echo "line for $(cat | head -c 0)ok"',
      'user',
    )
    expect(await controller.statusLineText()).toBe('line for ok')
  })

  test('doctor returns the checks including sandbox state', async () => {
    const { controller } = await makeController({ model: scriptedModel([]) })
    const checks = await controller.doctor()
    const names = checks.map((c) => c.name)
    expect(names).toEqual(
      expect.arrayContaining(['Runtime', 'Sandbox', 'Sandbox state', 'Terminal']),
    )
    for (const check of checks) expect(['ok', 'warn', 'error']).toContain(check.status)
  })
})

describe('questions', () => {
  test('an unanswered question times out and the model is told', async () => {
    const question = {
      questions: [
        {
          question: 'Which one?',
          header: 'Pick',
          options: [{ label: 'A' }, { label: 'B' }],
          multiSelect: false,
        },
      ],
    }
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'ask_user_question', input: question }] },
      { text: 'going with A' },
    ])
    const { controller } = await makeController({
      model,
      homeFiles: { 'settings.json': JSON.stringify({ askUserQuestionTimeout: 0.2 }) },
    })
    const { result } = await turn(controller, 'decide')
    expect(result.stop).toBe('complete')
    expect(JSON.stringify(model.prompts.at(-1))).toContain(QUESTION_TIMEOUT_NOTE.slice(0, 40))
    expect(controller.broker.pendingQuestions()).toEqual([])
  })
})

describe('memory and directories', () => {
  test('memory files list user and project files; the user memory reaches the prompt', async () => {
    const model = routerModel(() => ({ text: 'ok' }))
    const { controller } = await makeController({
      model,
      files: { 'AGENTS.md': 'PROJECT-MEM-TEXT' },
      homeFiles: { 'AGENTS.md': 'USER-MEM-TEXT' },
    })
    const files = await controller.memoryFiles()
    expect(files.map((f) => [f.scope, f.path, f.exists])).toEqual([
      ['user', '~/.coder/AGENTS.md', true],
      ['project', 'AGENTS.md', true],
    ])
    await turn(controller, 'hi')
    const text = model.routes.at(-1)?.system ?? ''
    expect(text).toContain('PROJECT-MEM-TEXT')
    expect(text).toContain('USER-MEM-TEXT')
    expect(text.indexOf('PROJECT-MEM-TEXT')).toBeLessThan(text.indexOf('USER-MEM-TEXT'))
    expect((await controller.contextDetails()).memoryFiles.map((f) => f.path)).toEqual(
      expect.arrayContaining(['/AGENTS.md', '~/.coder/AGENTS.md']),
    )
  })

  test('CLAUDE.md wins over AGENTS.md; nested files are listed in the prompt', async () => {
    const model = routerModel(() => ({ text: 'ok' }))
    const { controller } = await makeController({
      model,
      files: {
        'CLAUDE.md': 'CLAUDE-MEM-TEXT',
        'AGENTS.md': 'AGENTS-MEM-TEXT',
        'pkg/AGENTS.md': 'nested',
      },
    })
    const files = await controller.memoryFiles()
    expect(files[1]).toMatchObject({ path: 'CLAUDE.md', ignored: ['AGENTS.md'] })
    await turn(controller, 'hi')
    const text = model.routes.at(-1)?.system ?? ''
    expect(text).toContain('CLAUDE-MEM-TEXT')
    expect(text).not.toContain('AGENTS-MEM-TEXT')
    expect(text).toContain('/pkg/AGENTS.md')
  })

  test('addDirectory mounts the directory', async () => {
    const { controller } = await makeController({ model: scriptedModel([]) })
    const other = await tempDir('coder-extra-')
    const virtual = await controller.addDirectory(other)
    expect(virtual.startsWith('/@dirs/')).toBe(true)
    expect((await controller.status()).mounts.map((m) => m.real)).toContain(other)
    await expect(controller.addDirectory('/definitely/not/here')).rejects.toThrow(
      /No such directory/,
    )
  })
})

describe('lsp', () => {
  const settings = JSON.stringify({
    lsp: { fake: { command: ['bun', FAKE_LSP], extensions: ['.ts'] } },
  })

  test('the lsp tool exists only with a configured server and works', async () => {
    const withServer = routerModel((route) =>
      route.toolResults === 0
        ? { toolCalls: [{ toolName: 'lsp', input: { operation: 'diagnostics', path: '/a.ts' } }] }
        : { text: 'checked' },
    )
    const { controller } = await makeController({
      model: withServer,
      files: { 'a.ts': 'const BAD = 1\n' },
      homeFiles: { 'settings.json': settings },
    })
    const { result } = await turn(controller, 'check types')
    expect(result.stop).toBe('complete')
    expect(withServer.routes[0]?.tools).toContain('lsp')
    expect(withServer.routes[1]?.conversation).toContain('a.ts')
    expect(controller.broker.pending()).toEqual([])
    expect((await controller.doctor()).find((c) => c.name === 'Language servers')).toBeDefined()
    await controller.close()

    if (Bun.which('typescript-language-server') === null) {
      const without = routerModel(() => ({ text: 'ok' }))
      const other = await makeController({ model: without })
      await turn(other.controller, 'hi')
      expect(without.routes[0]?.tools).not.toContain('lsp')
    }
  })
})

describe('sandbox', () => {
  test('status reports the sandbox and the setting toggles it live', async () => {
    const model = routerModel(() => ({ text: 'ok' }))
    const { controller } = await makeController({ model })
    const off = (await controller.status()).sandbox
    expect(off).toMatchObject({ enabled: false, network: false })
    const kind = detectOsSandbox().kind
    expect(off.kind).toBe(kind)

    // the bash description states the sandbox (library); the turn reminder no longer does
    const bash = (route: (typeof model.routes)[number]): string =>
      JSON.stringify(
        ((route.call.tools ?? []) as Array<{ name: string; description?: string }>).find(
          (t) => t.name === 'bash',
        ),
      )
    await turn(controller, 'one')
    expect(bash(model.routes.at(-1) as never)).toContain('without an OS sandbox')
    const last = model.routes.at(-1)
    expect(`${last?.system}${last?.conversation}`).not.toContain('Sandbox:')

    await controller.updateSetting('sandbox.enabled', true, 'local')
    const on = (await controller.status()).sandbox
    if (kind === 'seatbelt') expect(on.enabled).toBe(true)
    await turn(controller, 'two')
    if (on.enabled) {
      expect(bash(model.routes.at(-1) as never)).toContain('in an OS sandbox')
    }
    await controller.updateSetting('sandbox.enabled', false, 'local')
    expect((await controller.status()).sandbox.enabled).toBe(false)
  })
})

describe('image input', () => {
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

  test('files become file parts of the user message', async () => {
    const model = scriptedModel([{ text: 'nice image' }])
    const { controller } = await makeController({ model })
    const { result } = await turn(controller, 'what is this?', {
      files: [{ type: 'file', mediaType: 'image/png', url: png }],
    })
    expect(result.stop).toBe('complete')
    const first = (await controller.messages())[0]
    expect(first?.parts.map((p) => p.type)).toEqual(['text', 'file'])
    expect(JSON.stringify(model.prompts[0])).toContain('image/png')
  })

  test('read_file shows an image file to the model; the stored output is a small reference', async () => {
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'read_file', input: { path: '/shot.png' } }] },
      { text: 'a pixel' },
    ])
    const { controller, root } = await makeController({ model })
    await writeFile(join(root, 'shot.png'), Buffer.from(png.split(',')[1] as string, 'base64'))
    const { result } = await turn(controller, 'look at shot.png')
    expect(result.stop).toBe('complete')
    const wire = JSON.stringify(model.prompts[1])
    expect(wire).toContain('Image /shot.png (1x1, 70 bytes, image/png)')
    expect(wire).toContain('image/png')
    const part = (await controller.messages())
      .flatMap((m) => m.parts)
      .find((p) => p.type === 'tool-read_file') as { output?: { type?: string; text?: string } }
    expect(part.output?.type).toBe('media-ref')
    expect(part.output?.text).toStartWith('Image /shot.png (1x1')
  })

  test('a data URL over 5 MB is a run error, not a throw', async () => {
    const model = scriptedModel([{ text: 'never' }])
    const { controller } = await makeController({ model })
    const big = `data:image/png;base64,${'A'.repeat(7_000_000)}`
    const { result } = await turn(controller, 'huge', {
      files: [{ type: 'file', mediaType: 'image/png', url: big }],
    })
    expect(result.stop).not.toBe('complete')
  })
})
