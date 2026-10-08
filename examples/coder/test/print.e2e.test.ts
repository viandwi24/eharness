/** Spawns the real CLI (`bun src/main.tsx`) with a scripted model: offline, no network. */
import { describe, expect, test } from 'bun:test'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ScriptedStep } from 'eharness/testing'
import { isolateHome, tempDir, writeFiles } from './helpers.ts'

const MAIN = join(import.meta.dir, '..', 'src', 'main.tsx')

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  )

interface Ran {
  code: number
  stdout: string
  stderr: string
  root: string
  home: string
}

async function coder(
  args: string[],
  opts: {
    steps?: ScriptedStep[]
    files?: Record<string, string>
    env?: Record<string, string>
  } = {},
): Promise<Ran> {
  const home = await isolateHome()
  const root = await tempDir('coder-e2e-')
  await writeFiles(root, opts.files ?? {})
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CODER_HOME: home,
    CODER_OFFLINE: '1',
  }
  delete env.CODER_MODEL
  for (const key of ['OPENROUTER_API_KEY', 'AI_GATEWAY_API_KEY', 'OPENROUTER_BASE_URL']) {
    delete env[key]
  }
  if (opts.steps !== undefined) {
    const script = join(await tempDir('coder-script-'), 'script.json')
    await writeFile(script, JSON.stringify(opts.steps))
    env.CODER_SCRIPTED_MODEL = script
  } else {
    delete env.CODER_SCRIPTED_MODEL
  }
  Object.assign(env, opts.env)
  const proc = Bun.spawn([process.execPath, MAIN, ...args, '--cwd', root], {
    cwd: root,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr, root, home }
}

describe('print mode e2e', () => {
  test('text output and exit code 0', async () => {
    const r = await coder(['-p', 'say hi'], { steps: [{ text: 'Hello from the scripted model.' }] })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('Hello from the scripted model.\n')
  })

  test('tool calls are noted on stderr, the answer on stdout', async () => {
    const r = await coder(['-p', 'read it'], {
      files: { 'a.txt': 'hello file' },
      steps: [
        { toolCalls: [{ toolName: 'read_file', input: { path: '/a.txt' } }] },
        { text: 'It says hello.' },
      ],
    })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('It says hello.\n')
    expect(r.stderr).toContain('[tool] read_file')
  })

  test('--output-format json has the documented shape', async () => {
    const r = await coder(['-p', 'json please', '--output-format', 'json'], {
      steps: [{ text: 'answer', usage: { inputTokens: 100, outputTokens: 7 } }],
    })
    expect(r.code).toBe(0)
    const out = JSON.parse(r.stdout) as Record<string, unknown>
    expect(Object.keys(out).sort()).toEqual(['costUsd', 'sessionId', 'stop', 'text', 'usage'])
    expect(out.stop).toBe('complete')
    expect(out.text).toBe('answer')
    expect(out.costUsd === null || typeof out.costUsd === 'number').toBe(true)
    expect(typeof out.sessionId).toBe('string')
    expect(out.usage).toMatchObject({ inputTokens: 100, outputTokens: 7, totalTokens: 107 })
  })

  test('--output-format stream-json prints one JSON chunk per line', async () => {
    const r = await coder(['-p', 'go', '--output-format', 'stream-json'], {
      steps: [{ text: 'streamed' }],
    })
    expect(r.code).toBe(0)
    const lines = r.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string })
    expect(lines.some((c) => c.type === 'text-delta')).toBe(true)
  })

  test('a write in default mode is denied in print mode; the file is not created', async () => {
    const r = await coder(['-p', 'create it', '--output-format', 'json'], {
      steps: [
        { toolCalls: [{ toolName: 'write_file', input: { path: '/new.txt', content: 'nope' } }] },
        { text: 'I could not write the file.' },
      ],
    })
    expect(await exists(join(r.root, 'new.txt'))).toBe(false)
    const out = JSON.parse(r.stdout) as { stop: string; text: string }
    expect(out.stop).toBe('complete')
    expect(out.text).toBe('I could not write the file.')
    expect(r.code).toBe(0)
  })

  test('the model sees the non-interactive denial reason (session transcript)', async () => {
    const r = await coder(['-p', 'create it', '--output-format', 'json'], {
      steps: [
        { toolCalls: [{ toolName: 'write_file', input: { path: '/new.txt', content: 'nope' } }] },
        { text: 'denied' },
      ],
    })
    const { sessionId } = JSON.parse(r.stdout) as { sessionId: string }
    const { readdir } = await import('node:fs/promises')
    const projects = join(r.home, 'projects')
    const [hash] = await readdir(projects)
    const stored = await readFile(
      join(projects, hash as string, 'sessions', `${sessionId}.messages.json`),
      'utf8',
    )
    expect(stored).toContain('Approval is not available in non-interactive mode.')
  })

  test('--permission-mode acceptEdits lets the write through in print mode', async () => {
    const r = await coder(['-p', 'create it', '--permission-mode', 'acceptEdits'], {
      steps: [
        {
          toolCalls: [{ toolName: 'write_file', input: { path: '/new.txt', content: 'created' } }],
        },
        { text: 'created it' },
      ],
    })
    expect(r.code).toBe(0)
    expect(await readFile(join(r.root, 'new.txt'), 'utf8')).toBe('created')
  })

  test('the exit code is 1 when the turn does not complete', async () => {
    // the script ends after the tool call: the next model call fails
    const r = await coder(['-p', 'go', '--output-format', 'json'], {
      files: { 'a.txt': 'x' },
      steps: [{ toolCalls: [{ toolName: 'read_file', input: { path: '/a.txt' } }] }],
    })
    expect(r.code).toBe(1)
    const out = JSON.parse(r.stdout) as { stop: string }
    expect(out.stop).not.toBe('complete')
    expect(r.stderr).toContain('coder:')
  })

  test('--version prints the version', async () => {
    const r = await coder(['--version'])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/^coder 0\.0\.0 \(eharness \S+\)\n$/)
  })

  test('an invalid --permission-mode exits 2 with a message', async () => {
    const r = await coder(['-p', 'x', '--permission-mode', 'yolo'], { steps: [{ text: 'never' }] })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('Invalid permission mode "yolo"')
    expect(r.stdout).toBe('')
  })

  test('an invalid settings file exits 2 and names the file', async () => {
    const r = await coder(['-p', 'x'], {
      files: { '.coder/settings.json': '{ broken' },
      steps: [{ text: 'never' }],
    })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('settings.json')
  })

  test('an unreadable CODER_SCRIPTED_MODEL exits 2', async () => {
    const r = await coder(['-p', 'x'], { env: { CODER_SCRIPTED_MODEL: '/does/not/exist.json' } })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('CODER_SCRIPTED_MODEL')
  })

  test('--agents defines a subagent that print mode can spawn', async () => {
    const agents = JSON.stringify({
      scout: { description: 'Scouts', prompt: 'Scout.', tools: ['Read'] },
    })
    const r = await coder(['-p', 'delegate', '--agents', agents], {
      steps: [
        {
          toolCalls: [
            {
              toolName: 'agent',
              input: { subagent_type: 'scout', description: 'scout', prompt: 'look' },
            },
          ],
        },
        { text: 'scout report' },
        { text: 'main done' },
      ],
    })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('main done\n')
  })

  test('a missing add-dir only warns', async () => {
    const r = await coder(['-p', 'x', '--add-dir', '/no/such/dir'], { steps: [{ text: 'fine' }] })
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('warning: Ignoring missing directory /no/such/dir')
  })

  test('unknown flags and invalid values exit 2', async () => {
    expect((await coder(['--bogus'])).code).toBe(2)
    expect((await coder(['--max-steps', 'abc', '-p', 'x'])).code).toBe(2)
    expect((await coder(['--help'])).code).toBe(0)
  })

  test('print mode warns about untrusted project settings; --trust-project applies them', async () => {
    const files = {
      '.coder/settings.json': JSON.stringify({ permissions: { allow: ['Write'] } }),
    }
    const steps: ScriptedStep[] = [
      { toolCalls: [{ toolName: 'write_file', input: { path: '/new.txt', content: 'ok' } }] },
      { text: 'done' },
    ]
    const untrusted = await coder(['-p', 'go'], { files, steps })
    expect(untrusted.stderr).toContain('untrusted project settings (allow)')
    expect(await exists(join(untrusted.root, 'new.txt'))).toBe(false)
    const trusted = await coder(['-p', 'go', '--trust-project'], { files, steps })
    expect(trusted.stderr).not.toContain('untrusted')
    expect(await readFile(join(trusted.root, 'new.txt'), 'utf8')).toBe('ok')
  })

  test('no API key and no scripted model: a clear startup error, exit 2', async () => {
    const r = await coder(['-p', 'hi'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('OPENROUTER_API_KEY')
    expect(r.stderr).toContain('AI_GATEWAY_API_KEY')
    expect(r.stdout).toBe('')
  })

  test('a provider without its key fails even when the other key is set; the key is never printed', async () => {
    const r = await coder(['-p', 'hi', '--provider', 'openrouter'], {
      env: { AI_GATEWAY_API_KEY: 'gw-secret-123' },
    })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--provider gateway')
    expect(r.stderr + r.stdout).not.toContain('gw-secret-123')
  })

  test('invalid --provider and --thinking are usage errors', async () => {
    expect((await coder(['-p', 'hi', '--provider', 'nope'], { steps: [{ text: 'x' }] })).code).toBe(
      2,
    )
    expect((await coder(['-p', 'hi', '--thinking', 'nope'], { steps: [{ text: 'x' }] })).code).toBe(
      2,
    )
  })

  test('--provider and --thinking work with the scripted model; --help documents them', async () => {
    const r = await coder(['-p', 'hi', '--provider', 'openrouter', '--thinking', 'high'], {
      steps: [{ text: 'fine' }],
    })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('fine\n')
    const help = await coder(['--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('--provider <name>')
    expect(help.stdout).toContain('--thinking <level>')
    expect(help.stdout).toContain('provider-default')
  })
})
