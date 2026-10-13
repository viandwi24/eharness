import { describe, expect, test } from 'bun:test'
import { createEnvironments, EnvironmentError, formatPackages, parseRequirement } from './env.ts'
import { fakeSandbox } from './test-kit.ts'

describe('parseRequirement', () => {
  test('names with an optional specifier are normalized', () => {
    const ok = (s: string) => {
      const r = parseRequirement(s)
      return r.ok ? r.requirement : undefined
    }
    expect(ok('pandas')).toEqual({ name: 'pandas', specifier: '', line: 'pandas' })
    expect(ok('Pandas_TA >= 0.3')).toEqual({
      name: 'pandas-ta',
      specifier: '>=0.3',
      line: 'pandas-ta>=0.3',
    })
    expect(ok('scipy>=1.11,<2')?.line).toBe('scipy>=1.11,<2')
    expect(ok('numpy==1.26.*')?.line).toBe('numpy==1.26.*')
  })

  test.each([
    '',
    '   ',
    '-r requirements.txt',
    '--index-url http://x',
    'https://x.test/p.whl',
    'git+https://x/y.git',
    './local',
    '/abs/path',
    'a b',
    'pkg[extra]',
    'pkg; python_version<"3"',
    'pkg>=',
    'pkg@https://x',
    'pkg\nother',
  ])('rejects %j', (line) => {
    expect(parseRequirement(line).ok).toBe(false)
  })
})

test('formatPackages: sorted, major.minor, capped', () => {
  expect(
    formatPackages([
      ['pandas', '2.2.1'],
      ['Numpy', '1.26.4'],
    ]),
  ).toBe('Numpy 1.26, pandas 2.2')
  const many: Array<[string, string]> = Array.from({ length: 63 }, (_, i) => [
    `p${String(i).padStart(2, '0')}`,
    '1.0',
  ])
  expect(formatPackages(many)).toEndWith(', p59 1.0 and 3 more')
})

function installerFake(failOn?: string) {
  const sb = fakeSandbox()
  sb.onCommand = (command) => {
    if (failOn !== undefined && command.includes(failOn)) {
      return { exitCode: 1, stdout: '', stderr: `boom: ${'x'.repeat(3000)}END` }
    }
    if (command.startsWith('command -v uv')) return { exitCode: 1, stdout: '', stderr: '' }
    if (command.includes('sys.version_info')) return { exitCode: 0, stdout: '3.12.1\n', stderr: '' }
    if (command.includes('sysconfig')) {
      return {
        exitCode: 0,
        stdout: `${command.includes('/envs/ws-') ? '/envs/ws/lib/site-packages' : '/envs/base/lib/site-packages'}\n`,
        stderr: '',
      }
    }
    return undefined
  }
  return sb
}

describe('environments', () => {
  test('no requirements: the configured interpreter, nothing is built', async () => {
    const runtime = fakeSandbox()
    const env = createEnvironments({ command: 'python3.12', requirements: [], runtime })
    expect(await env.ensure([])).toEqual({ python: 'python3.12', key: 'plain:python3.12' })
    expect(runtime.commands).toEqual([])
  })

  test('base environment: built once, reused while .eh-ok exists, rebuilt when it vanishes', async () => {
    const installer = installerFake()
    const runtime = fakeSandbox()
    const make = () =>
      createEnvironments({
        command: 'python3',
        requirements: ['pandas==2.2.1', 'numpy'],
        envRoot: '/envs',
        installer,
        indexUrl: 'https://idx.test/simple',
        runtime,
      })
    const first = await make().ensure([])
    expect(first.python).toMatch(/^\/envs\/base-[0-9a-f]{16}\/bin\/python$/)
    expect(first.rebuilt?.packages).toBe(2)
    const joined = installer.commands.join('\n')
    expect(joined).toContain("'python3' -m venv '/envs/base-")
    expect(joined).toContain(
      "-m pip install --only-binary=:all: --index-url 'https://idx.test/simple' 'numpy' 'pandas==2.2.1'",
    )
    expect(installer.files.has(`${first.python.replace('/bin/python', '')}/.eh-ok`)).toBe(true)
    // another process: same key, nothing rebuilt
    installer.commands.length = 0
    const second = await make().ensure([])
    expect(second.python).toBe(first.python)
    expect(second.rebuilt).toBeUndefined()
    expect(installer.commands.some((c) => c.includes('pip install'))).toBe(false)
    // the key does not depend on the order of the lines
    const reordered = await createEnvironments({
      command: 'python3',
      requirements: ['numpy', 'pandas==2.2.1'],
      envRoot: '/envs',
      installer,
      runtime,
    }).ensure([])
    expect(reordered.python).toBe(first.python)
    // wiped: rebuilt
    installer.files.clear()
    expect((await make().ensure([])).rebuilt?.packages).toBe(2)
  })

  test('a different list builds a different environment', async () => {
    const installer = installerFake()
    const a = await createEnvironments({
      command: 'python3',
      requirements: ['a'],
      envRoot: '/envs',
      installer,
      runtime: fakeSandbox(),
    }).ensure([])
    const b = await createEnvironments({
      command: 'python3',
      requirements: ['b'],
      envRoot: '/envs',
      installer,
      runtime: fakeSandbox(),
    }).ensure([])
    expect(a.python).not.toBe(b.python)
  })

  test('workspace environment: venv over the base with a .pth, extras installed, keyed by the list', async () => {
    const installer = installerFake()
    const env = createEnvironments({
      command: 'python3',
      requirements: ['pandas'],
      envRoot: '/envs',
      installer,
      runtime: fakeSandbox(),
    })
    const ws = await env.ensure(['scipy>=1.11', 'pandas-ta'])
    expect(ws.python).toMatch(/^\/envs\/ws-[0-9a-f]{16}\/bin\/python$/)
    const joined = installer.commands.join('\n')
    expect(joined).toContain('-m venv --system-site-packages')
    expect(joined).toContain("--only-binary=:all: 'pandas-ta' 'scipy>=1.11'")
    expect([...installer.files.keys()]).toContain('/envs/ws/lib/site-packages/eh-base.pth')
    const again = await env.ensure(['pandas-ta', 'scipy>=1.11'])
    expect(again.python).toBe(ws.python)
    expect(again.rebuilt).toBeUndefined()
    const other = await env.ensure(['pandas-ta'])
    expect(other.python).not.toBe(ws.python)
  })

  test('no requirements: the workspace environment sits directly on the interpreter, no .pth', async () => {
    const installer = installerFake()
    const env = createEnvironments({
      command: 'python3',
      requirements: [],
      envRoot: '/envs',
      installer,
      runtime: fakeSandbox(),
    })
    const ws = await env.ensure(['x'])
    expect(ws.python).toMatch(/\/ws-/)
    expect([...installer.files.keys()].some((k) => k.endsWith('.pth'))).toBe(false)
    expect(installer.commands.join('\n')).toContain("'python3' -m venv --system-site-packages")
  })

  test('uv is used when present', async () => {
    const installer = installerFake()
    const orig = installer.onCommand
    installer.onCommand = (c) =>
      c.startsWith('command -v uv') ? { exitCode: 0, stdout: '/bin/uv', stderr: '' } : orig?.(c)
    await createEnvironments({
      command: 'python3',
      requirements: ['a'],
      envRoot: '/envs',
      installer,
      runtime: fakeSandbox(),
    }).ensure([])
    const joined = installer.commands.join('\n')
    expect(joined).toContain('uv venv --python')
    expect(joined).toContain('uv pip install --python')
    expect(joined).toContain('--only-binary :all:')
  })

  test('a failing install throws with the tail of the output and leaves no .eh-ok', async () => {
    const installer = installerFake('pip install')
    const env = createEnvironments({
      command: 'python3',
      requirements: ['a'],
      envRoot: '/envs',
      installer,
      runtime: fakeSandbox(),
    })
    const error = await env.ensure([]).catch((e) => e)
    expect(error).toBeInstanceOf(EnvironmentError)
    expect((error as Error).message.length).toBeLessThanOrEqual(2000)
    expect((error as Error).message).toEndWith('END')
    expect([...installer.files.keys()].some((k) => k.endsWith('.eh-ok'))).toBe(false)
  })

  test('extras are validated before anything runs', async () => {
    const installer = installerFake()
    const env = createEnvironments({
      command: 'python3',
      requirements: [],
      envRoot: '/envs',
      installer,
      runtime: fakeSandbox(),
      validate: (l) => (l === 'bad' ? 'bad is not allowed' : undefined),
    })
    await expect(env.ensure(['ok', 'bad'])).rejects.toThrow('bad is not allowed')
    expect(installer.commands.some((c) => c.includes('venv'))).toBe(false)
  })

  test('peek is the interpreter only when no building is needed; probe is cached per key', async () => {
    const installer = installerFake()
    const runtime = fakeSandbox()
    runtime.onCommand = () => ({
      exitCode: 0,
      stdout: JSON.stringify({ version: '3.12.1', packages: [['pandas', '2.2.1']] }),
      stderr: '',
    })
    const env = createEnvironments({
      command: 'python3',
      requirements: ['pandas'],
      envRoot: '/envs',
      installer,
      runtime,
    })
    expect(await env.peek()).toBeUndefined()
    const built = await env.ensure([])
    expect((await env.peek())?.python).toBe(built.python)
    expect((await env.probe(built))?.packages).toEqual([['pandas', '2.2.1']])
    await env.probe(built)
    expect(runtime.commands.filter((c) => c.includes('importlib'))).toHaveLength(1)
    runtime.onCommand = () => ({ exitCode: 1, stdout: '', stderr: 'no python' })
    expect(await env.probe({ python: 'x', key: 'other' })).toBeUndefined()
  })
})
