import { describe, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inMemoryFs } from '../filesystem/memory.ts'
import { filesystem } from '../filesystem/plugin.ts'
import { defineHarnessAgent, definePlugin, isHarnessError } from '../index.ts'
import { localSandbox } from '../shell/sandbox-local.ts'
import { type ScriptedStep, scriptedModel } from '../testing/index.ts'
import { code } from './index.ts'
import type { CodeOptions, CodeSandboxService } from './plugin.ts'
import { type FakeSandbox, fakeSandbox, text, wrapRun } from './test-kit.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const enc = new TextEncoder()

type Call = { toolName: string; input: unknown }
const call = (toolName: string, input: unknown): { toolCalls: Call[] } => ({
  toolCalls: [{ toolName, input }],
})
const run = (input: Record<string, unknown>) => call('run_python', input)

async function outputs(
  session: { messages(): Promise<unknown[]> },
  name: string,
): Promise<string[]> {
  const out: string[] = []
  for (const m of (await session.messages()) as Array<{ parts: Array<Record<string, unknown>> }>) {
    for (const p of m.parts) {
      if (p.type === `tool-${name}` && p.state === 'output-available') out.push(p.output as string)
    }
  }
  return out
}

interface Setup {
  fs: ReturnType<typeof inMemoryFs>
  sandbox: FakeSandbox
  installer: FakeSandbox
}

function make(
  steps: ScriptedStep[],
  opts: Partial<CodeOptions> = {},
  seed: Record<string, string | Uint8Array> = {},
  fsOptions: Record<string, unknown> = {},
) {
  const fs = inMemoryFs({ seed })
  const sandbox = (opts.sandbox as FakeSandbox | undefined) ?? fakeSandbox()
  const installer = fakeSandbox()
  installer.onCommand = (c) => {
    if (c.startsWith('command -v uv')) return { exitCode: 1, stdout: '', stderr: '' }
    if (c.includes('sys.version_info')) return { exitCode: 0, stdout: '3.12.1\n', stderr: '' }
    return undefined
  }
  const model = scriptedModel(steps)
  const agent = defineHarnessAgent({
    model,
    contextWindow: 100_000,
    logger: silent,
    plugins: [filesystem({ fs, ...fsOptions }), code({ sandbox, installer, ...opts })],
  })
  return { agent, model, fs, sandbox, installer } satisfies Setup & Record<string, unknown>
}

async function exec(
  steps: ScriptedStep[],
  opts: Partial<CodeOptions> = {},
  seed: Record<string, string | Uint8Array> = {},
  fsOptions: Record<string, unknown> = {},
) {
  const h = make([...steps, { text: 'done' }], opts, seed, fsOptions)
  const session = h.agent.session('s')
  await session.send('go').result
  const out = await outputs(session, 'run_python')
  await session.close()
  return { ...h, out }
}

describe('run_python', () => {
  test('files in, script runs in the root with the env, files out; the footer lists them', async () => {
    const sandbox = fakeSandbox()
    sandbox.onScript = (c, files) => {
      expect(c.script).toBe('work/analyze.py')
      expect(c.args).toEqual(['--n', "it's"])
      expect(c.env).toMatchObject({
        MPLBACKEND: 'Agg',
        PYTHONDONTWRITEBYTECODE: '1',
      })
      const csv = new TextDecoder().decode(files.get('work/a.csv'))
      files.set('work/out.txt', enc.encode(`rows=${csv.trim().split('\n').length}`))
      return { exitCode: 0, output: 'hello\n' }
    }
    const r = await exec(
      [run({ file: '/work/analyze.py', args: ['--n', "it's"] })],
      { sandbox },
      { '/work/a.csv': 'x\n1\n2\n', '/work/analyze.py': 'print(1)' },
    )
    expect(r.out[0]).toMatch(/^hello\nExit code 0 · \d+\.\ds\nSaved: \/work\/out\.txt$/)
    expect((await r.fs.read('/work/out.txt'))?.content).toBe('rows=3')
  })

  test('a second run over unchanged data uploads nothing', async () => {
    const sandbox = fakeSandbox()
    const r = await exec(
      [run({ file: '/work/a.py' }), run({ file: '/work/a.py' })],
      { sandbox },
      { '/work/a.py': 'pass', '/work/d.csv': '1' },
    )
    expect(r.out).toHaveLength(2)
    expect(sandbox.uploads).toEqual(['work/a.py', 'work/d.csv'])
    expect(
      sandbox.commands.filter((c) => c.includes(`'python3' -E -s -B -u './work/a.py'`)),
    ).toHaveLength(2)
  })

  test('input errors', async () => {
    const r = await exec(
      [
        run({}),
        run({ file: '/work/a.py', code: 'x' }),
        run({ file: '/etc/x.py' }),
        run({ file: '/work/missing.py' }),
        run({ file: '/../x.py' }),
      ],
      {},
      { '/work/a.py': 'pass' },
    )
    expect(r.out).toEqual([
      'ERROR: give either file or code.',
      'ERROR: give either file or code.',
      'ERROR: /etc/x.py is not under a synced folder (/work/).',
      'ERROR: /work/missing.py does not exist.',
      'ERROR: the path escapes the root.',
    ])
  })

  test('inline code is written to .eh-code/inline.py and never saved', async () => {
    const sandbox = fakeSandbox()
    sandbox.onScript = (c) => ({ exitCode: 0, output: c.script })
    const r = await exec([run({ code: 'print(1)' })], { sandbox })
    expect(r.out[0]).toStartWith('.eh-code/inline.py\nExit code 0')
    expect(text(sandbox, '.eh-code/inline.py')).toBe('print(1)')
    expect(r.out[0]).not.toContain('Saved')
  })

  test('a failed run saves nothing and says so; writeBack always saves', async () => {
    const make1 = () => {
      const sandbox = fakeSandbox()
      sandbox.onScript = (_c, files) => {
        files.set('work/partial.txt', enc.encode('p'))
        return { exitCode: 2, output: 'Traceback…\n' }
      }
      return sandbox
    }
    const failed = await exec([run({ code: 'x' })], { sandbox: make1() })
    expect(failed.out[0]).toMatch(
      /^Traceback…\nExit code 2 · \d+\.\ds\nNot saved \(the run failed\): 1 changed files\.$/,
    )
    expect(await failed.fs.read('/work/partial.txt')).toBeNull()
    const always = await exec([run({ code: 'x' })], { sandbox: make1(), writeBack: 'always' })
    expect(always.out[0]).toContain('Saved: /work/partial.txt')
    expect((await always.fs.read('/work/partial.txt'))?.content).toBe('p')
  })

  test('timeout kills the run and reports it; nothing is saved', async () => {
    const sandbox = fakeSandbox()
    sandbox.onScript = (_c, files) => {
      files.set('work/x', enc.encode('x'))
      return new Promise(() => {})
    }
    const r = await exec([run({ code: 'while True: pass', timeoutSeconds: 1 })], { sandbox })
    expect(r.out[0]).toBe('(timed out after 1s)\nNot saved (the run failed): 1 changed files.')
  })

  test('timeoutSeconds is capped by maxTimeoutMs', async () => {
    const sandbox = fakeSandbox()
    sandbox.onScript = () => new Promise(() => {})
    const r = await exec([run({ code: 'x', timeoutSeconds: 3600 })], {
      sandbox,
      limits: { maxTimeoutMs: 1000 },
    })
    expect(r.out[0]).toStartWith('(timed out after 1s)')
  })

  test('a sandbox that dies mid-run: nothing saved, the next run starts from a full sync-in', async () => {
    const sandbox = fakeSandbox()
    let n = 0
    sandbox.onScript = async (_c, files) => {
      n++
      if (n === 1) {
        files.set('work/half.txt', enc.encode('h'))
        throw new Error('container exited')
      }
      return { exitCode: 0, output: 'ok' }
    }
    const r = await exec(
      [run({ code: 'a' }), run({ code: 'b' })],
      { sandbox },
      { '/work/a.txt': 'a' },
    )
    expect(r.out[0]).toBe(
      'ERROR: the sandbox stopped during the run; nothing was saved. (container exited)',
    )
    expect(await r.fs.read('/work/half.txt')).toBeNull()
    expect(r.out[1]).toMatch(/^ok\nExit code 0/)
    expect(r.out[1]).not.toContain('half.txt')
  })

  test('a sandbox that cannot start the command', async () => {
    const sandbox = fakeSandbox()
    sandbox.failSpawn = new Error('no such container')
    const r = await exec([run({ code: 'x' })], { sandbox })
    expect(r.out[0]).toBe(
      'ERROR: the sandbox stopped during the run; nothing was saved. (no such container)',
    )
  })

  test('a wiped sandbox between two runs: full sync-in, same result', async () => {
    const sandbox = fakeSandbox()
    sandbox.onScript = (c, files) => ({
      exitCode: files.has('work/a.txt') ? 0 : 1,
      output: c.script,
    })
    const h = make(
      [run({ code: 'x' }), { text: 'one' }, run({ code: 'x' }), { text: 'two' }],
      { sandbox },
      { '/work/a.txt': 'a' },
    )
    const session = h.agent.session('s')
    await session.send('1').result
    sandbox.wipe()
    sandbox.uploads.length = 0
    await session.send('2').result
    const out = await outputs(session, 'run_python')
    expect(out[1]).toContain('Exit code 0')
    expect(sandbox.uploads).toEqual(['work/a.txt'])
    await session.close()
  })

  test('conflict is reported as Not saved and the file system keeps its version', async () => {
    const sandbox = fakeSandbox()
    const fs = inMemoryFs({ seed: { '/work/a.txt': 'a' } })
    sandbox.onScript = async (_c, files) => {
      files.set('work/a.txt', enc.encode('sandbox'))
      await fs.write('/work/a.txt', 'someone else')
      return { exitCode: 0, output: '' }
    }
    const model = scriptedModel([run({ code: 'x' }), { text: 'done' }])
    const agent = defineHarnessAgent({
      model,
      contextWindow: 100_000,
      logger: silent,
      plugins: [filesystem({ fs }), code({ sandbox })],
    })
    const session = agent.session('s')
    await session.send('go').result
    const [out] = await outputs(session, 'run_python')
    expect(out).toContain('Not saved: /work/a.txt (changed in the file system while the code ran)')
    expect((await fs.read('/work/a.txt'))?.content).toBe('someone else')
    await session.close()
  })

  test('hidden files are never copied in; read-only prefixes are not written back', async () => {
    const sandbox = fakeSandbox()
    sandbox.onScript = (_c, files) => {
      files.set('work/ro/x.txt', enc.encode('changed'))
      files.set('work/new.txt', enc.encode('new'))
      return { exitCode: 0, output: '' }
    }
    const r = await exec(
      [run({ code: 'x' })],
      { sandbox },
      { '/work/secret/k.txt': 'k', '/work/ro/x.txt': 'orig' },
      { hiddenPrefixes: ['/work/secret'], readonlyPrefixes: ['/work/ro'] },
    )
    expect(sandbox.uploads).not.toContain('work/secret/k.txt')
    expect(r.out[0]).toContain('Saved: /work/new.txt')
    expect(r.out[0]).toContain('Not saved: /work/ro/x.txt (read-only)')
    expect((await r.fs.read('/work/ro/x.txt'))?.content).toBe('orig')
  })

  test('the access hook decides per path', async () => {
    const sandbox = fakeSandbox()
    sandbox.onScript = (_c, files) => {
      files.set('work/a.txt', enc.encode('A'))
      files.set('work/b.txt', enc.encode('B'))
      return { exitCode: 0, output: '' }
    }
    const seen: string[] = []
    const r = await exec([run({ code: 'x' })], {
      sandbox,
      access: (p, op) => {
        seen.push(`${op}:${p}`)
        return p !== '/work/b.txt' || op === 'read'
      },
    })
    expect(r.out[0]).toContain('Saved: /work/a.txt')
    expect(r.out[0]).toContain('Not saved: /work/b.txt (not allowed)')
    expect(seen).toContain('write:/work/b.txt')
  })

  test('long output is capped head + tail', async () => {
    const sandbox = fakeSandbox()
    sandbox.onScript = () => ({ exitCode: 0, output: `${'a'.repeat(20000)}END` })
    const r = await exec([run({ code: 'x' })], { sandbox, limits: { maxOutputChars: 3000 } })
    expect(r.out[0]).toContain('characters omitted')
    expect(r.out[0]).toContain('END\nExit code 0')
  })

  test('dispose is called at session close', async () => {
    const sandbox = fakeSandbox()
    const r = await exec([run({ code: 'x' })], { sandbox })
    expect(r.sandbox.disposed).toBe(true)
  })

  test('sync: false runs on the files directly: no copies, no write-back', async () => {
    const sandbox = fakeSandbox()
    sandbox.files.set('work/a.py', enc.encode('pass'))
    sandbox.onScript = (_c, files) => {
      files.set('work/n.txt', enc.encode('n'))
      return { exitCode: 0, output: 'ok' }
    }
    const r = await exec([run({ file: '/work/a.py' }), run({ file: '/work/zz.py' })], {
      sandbox,
      sync: false,
    })
    expect(r.out[0]).toMatch(/^ok\nExit code 0 · \d+\.\ds$/)
    expect(r.out[1]).toBe('ERROR: /work/zz.py does not exist.')
    expect(sandbox.files.has('.eh-code/marker')).toBe(false)
    expect(await r.fs.read('/work/n.txt')).toBeNull()
  })
})

describe('hints', () => {
  const failing = (output: string) => {
    const sandbox = fakeSandbox()
    sandbox.onScript = () => ({ exitCode: 1, output })
    return sandbox
  }
  const probeOutput = JSON.stringify({
    version: '3.12.1',
    packages: [
      ['pandas', '2.2.1'],
      ['numpy', '1.26.4'],
    ],
  })

  test('ModuleNotFoundError: install off lists the installed packages', async () => {
    const sandbox = failing("Traceback\nModuleNotFoundError: No module named 'scipy.stats'\n")
    sandbox.onCommand = (c) =>
      c.includes('importlib') ? { exitCode: 0, stdout: probeOutput, stderr: '' } : undefined
    const r = await exec([run({ code: 'import scipy.stats' })], { sandbox })
    expect(r.out[0]).toContain(
      '(scipy is not installed. Installed packages: numpy 1.26, pandas 2.2. Use the standard library or one of them.)\nExit code 1',
    )
  })

  test('ModuleNotFoundError: install on points at install_packages', async () => {
    const sandbox = failing("ModuleNotFoundError: No module named 'scipy'")
    const r = await exec([run({ code: 'x' })], {
      sandbox,
      python: { envRoot: '/envs' },
      packages: { install: 'any' },
    })
    expect(r.out[0]).toContain('(scipy is not installed. Use install_packages to add it.)')
  })

  test('FileNotFoundError for an absolute path under a mount', async () => {
    const sandbox = failing("FileNotFoundError: [Errno 2] No such file or directory: '/work/a.csv'")
    const r = await exec([run({ code: 'x' })], { sandbox })
    expect(r.out[0]).toContain('(Paths are relative to the sandbox root: use work/a.csv.)')
    const other = await exec([run({ code: 'x' })], {
      sandbox: failing("FileNotFoundError: [Errno 2] No such file or directory: '/etc/nope'"),
    })
    expect(other.out[0]).not.toContain('Paths are relative')
  })

  test('OS sandbox denial gets the bash hint, only with state().enabled', async () => {
    const sandbox = failing('PermissionError: [Errno 1] Operation not permitted: x')
    ;(sandbox as unknown as { state: () => unknown }).state = () => ({
      enabled: true,
      network: false,
    })
    const on = await exec([run({ code: 'x' })], { sandbox })
    expect(on.out[0]).toContain(
      '(The command ran in the OS sandbox: writes outside the project and network access are blocked.)',
    )
    const off = await exec([run({ code: 'x' })], { sandbox: failing('Operation not permitted') })
    expect(off.out[0]).not.toContain('OS sandbox')
  })
})

describe('isolation', () => {
  test('requireIsolation refuses a sandbox that does not declare isolation', async () => {
    const r = await exec([run({ code: 'x' })], { requireIsolation: true })
    expect(r.out[0]).toBe(
      'ERROR: running code needs an isolated sandbox, and this one is not (the driver does not declare isolation).',
    )
  })

  test('isolation field, and state() with enabled and no network, count as isolated', async () => {
    const a = fakeSandbox({ isolation: { isolated: true, label: 'container' } })
    expect(
      (await exec([run({ code: 'x' })], { sandbox: a, requireIsolation: true })).out[0],
    ).toMatch(/^Exit code 0/)
    const b = fakeSandbox()
    ;(b as unknown as { state: () => unknown }).state = () => ({ enabled: true, network: false })
    expect(
      (await exec([run({ code: 'x' })], { sandbox: b, requireIsolation: true })).out[0],
    ).toMatch(/^Exit code 0/)
    const c = fakeSandbox()
    ;(c as unknown as { state: () => unknown }).state = () => ({ enabled: true, network: true })
    expect(
      (await exec([run({ code: 'x' })], { sandbox: c, requireIsolation: true })).out[0],
    ).toStartWith('ERROR: running code needs an isolated sandbox')
  })
})

describe('tool description', () => {
  const probe = JSON.stringify({ version: '3.12.1', packages: [['pandas', '2.2.1']] })

  test('mounts, timeouts and the environment line; stable across sessions', async () => {
    const sandbox = fakeSandbox()
    sandbox.onCommand = (c) =>
      c.includes('importlib') ? { exitCode: 0, stdout: probe, stderr: '' } : undefined
    const h = make([{ text: 'x' }], {
      sandbox,
      mounts: [{ virtual: '/work/' }, { virtual: '/data/', readonly: true }],
    })
    const d1 = (await h.agent.session('a').tools()).find(
      (t) => t.name === 'run_python',
    )?.description
    const d2 = (await h.agent.session('b').tools()).find(
      (t) => t.name === 'run_python',
    )?.description
    expect(d1).toBe(d2)
    expect(d1).toContain('/work/ (read/write), /data/ (read-only)')
    expect(d1).toContain('Default timeout 60 s, at most 300 s')
    expect(d1).toContain('write_file')
    expect(d1).toEndWith('Python 3.12.1. Installed packages: pandas 2.2.')
  })

  test('a failed probe: the command and "packages unknown"', async () => {
    const h = make([{ text: 'x' }], {
      python: { command: 'python3.11' },
      sandbox: (() => {
        const s = fakeSandbox()
        s.onCommand = () => ({ exitCode: 1, stdout: '', stderr: 'x' })
        return s
      })(),
    })
    const d = (await h.agent.session('a').tools()).find((t) => t.name === 'run_python')?.description
    expect(d).toEndWith('Python environment: python3.11 (packages unknown).')
  })

  test('tool order: run_python, then install_packages only when install is on; risk metadata', async () => {
    const off = make([{ text: 'x' }])
    const names = (await off.agent.session('a').tools()).map((t) => t.name)
    expect(names).toContain('run_python')
    expect(names).not.toContain('install_packages')
    const on = make([{ text: 'x' }], { python: { envRoot: '/envs' }, packages: { install: 'any' } })
    const onNames = (await on.agent.session('a').tools()).map((t) => t.name)
    expect(onNames.indexOf('install_packages')).toBe(onNames.indexOf('run_python') + 1)
  })
})

describe('install_packages and the lazy rebuild', () => {
  const lines = '/work/.eharness/requirements.txt'
  const probe = (version: string) =>
    JSON.stringify({ version: '3.12.1', packages: [['pandas-ta', version]] })

  test('allowlist: validates, rejects, builds the workspace environment, stores the list', async () => {
    const sandbox = fakeSandbox()
    sandbox.onCommand = (c) =>
      c.includes('importlib') ? { exitCode: 0, stdout: probe('0.3.14'), stderr: '' } : undefined
    const h = make(
      [
        call('install_packages', { packages: ['not a name!'] }),
        call('install_packages', { packages: ['evil'] }),
        call('install_packages', { packages: ['Pandas_TA>=0.3'] }),
        { text: 'done' },
      ],
      {
        sandbox,
        python: { envRoot: '/envs' },
        packages: { install: 'allowlist', allow: ['pandas-ta'] },
      },
    )
    const session = h.agent.session('s')
    await session.send('go').result
    const out = await outputs(session, 'install_packages')
    expect(out[0]).toBe('ERROR: "not a name!" is not a package name with an optional version.')
    expect(out[1]).toBe('REJECTED: evil is not on the list of allowed packages.')
    expect(out[2]).toMatch(
      /^Installed: pandas-ta 0\.3 \(\d+s\)\. They can be imported in the next run_python call\.$/,
    )
    expect((await h.fs.read(lines))?.content).toBe('pandas-ta>=0.3\n')
    expect(h.installer.commands.join('\n')).toContain("--only-binary=:all: 'pandas-ta>=0.3'")
    await session.close()
  })

  test('a failing install keeps the stored list and returns the installer tail', async () => {
    const h = make(
      [call('install_packages', { packages: ['x'] }), { text: 'done' }],
      { python: { envRoot: '/envs' }, packages: { install: 'any' } },
      { [lines]: 'old\n' },
    )
    const orig = h.installer.onCommand
    h.installer.onCommand = (c) =>
      c.includes('pip install')
        ? { exitCode: 1, stdout: '', stderr: 'No matching distribution' }
        : orig?.(c)
    const session = h.agent.session('s')
    await session.send('go').result
    const [out] = await outputs(session, 'install_packages')
    expect(out).toBe('ERROR: installing failed: No matching distribution')
    expect((await h.fs.read(lines))?.content).toBe('old\n')
    await session.close()
  })

  test('a missing workspace environment is rebuilt from the stored list before the run and reported', async () => {
    const h = make(
      [run({ code: 'x' }), run({ code: 'y' }), { text: 'done' }],
      { python: { envRoot: '/envs' }, packages: { install: 'any' } },
      { [lines]: 'pandas-ta>=0.3\nscipy\n' },
    )
    const session = h.agent.session('s')
    await session.send('go').result
    const [first, second] = await outputs(session, 'run_python')
    expect(first).toMatch(/^Rebuilt the package environment \(2 packages, \d+s\)\.\nExit code 0/)
    expect(second).not.toContain('Rebuilt')
    expect(h.installer.commands.filter((c) => c.includes('pip install'))).toHaveLength(1)
    await session.close()
  })

  test('a stored line the allowlist refuses runs nothing', async () => {
    const h = make(
      [run({ code: 'x' }), { text: 'done' }],
      { python: { envRoot: '/envs' }, packages: { install: 'allowlist', allow: ['scipy'] } },
      { [lines]: 'evil\n' },
    )
    const session = h.agent.session('s')
    await session.send('go').result
    const [out] = await outputs(session, 'run_python')
    expect(out).toBe(
      'ERROR: rebuilding the package environment failed: evil is not on the list of allowed packages.',
    )
    expect(h.sandbox.commands.some((c) => c.includes('-E -s -B -u'))).toBe(false)
    await session.close()
  })

  test('the script cannot rewrite the stored list (it is never written back)', async () => {
    const sandbox = fakeSandbox()
    sandbox.onScript = (_c, files) => {
      files.set('work/.eharness/requirements.txt', enc.encode('evil\n'))
      return { exitCode: 0, output: '' }
    }
    const r = await exec(
      [run({ code: 'x' })],
      { sandbox, python: { envRoot: '/envs' }, packages: { install: 'any' } },
      { [lines]: 'scipy\n' },
    )
    expect(r.out[0]).toContain(`Not saved: ${lines} (not allowed)`)
    expect((await r.fs.read(lines))?.content).toBe('scipy\n')
  })

  test('python.requirements: the base environment is built with the installer and used for runs', async () => {
    const sandbox = fakeSandbox()
    const pythons: string[] = []
    sandbox.onScript = (c) => {
      pythons.push(c.python)
      return { exitCode: 0, output: '' }
    }
    const r = await exec([run({ code: 'x' })], {
      sandbox,
      python: { requirements: ['pandas==2.2.1'], envRoot: '/envs' },
    })
    expect(r.out[0]).toMatch(/^Rebuilt the package environment \(1 packages, \d+s\)\.\nExit code 0/)
    expect(pythons[0]).toMatch(/^\/envs\/base-[0-9a-f]{16}\/bin\/python$/)
  })
})

describe('service and configuration', () => {
  test('codeSandbox status and reset', async () => {
    let service: CodeSandboxService | undefined
    const spy = definePlugin({
      name: 'spy',
      requires: ['codeSandbox'],
      session: (ctx) => {
        service = ctx.services.codeSandbox
        return {}
      },
    })
    const sandbox = fakeSandbox({ isolation: { isolated: true, label: 'docker' } })
    sandbox.onCommand = (c) =>
      c.includes('importlib')
        ? { exitCode: 0, stdout: JSON.stringify({ version: '3.12.1', packages: [] }), stderr: '' }
        : undefined
    const agent = defineHarnessAgent({
      model: scriptedModel([run({ code: 'x' }), { text: 'done' }]),
      contextWindow: 100_000,
      logger: silent,
      plugins: [
        filesystem({ fs: inMemoryFs({ seed: { '/work/a.txt': 'a' } }) }),
        code({ sandbox }),
        spy,
      ],
    })
    const session = agent.session('s')
    await session.send('go').result
    expect(await service?.status()).toEqual({
      python: '3.12.1',
      driver: 'docker',
      isolated: true,
      install: 'off',
      extras: [],
    })
    expect(() => service?.reset()).not.toThrow()
    await session.close()
  })

  test.each<[string, Partial<CodeOptions>]>([
    ['mount without trailing slash', { mounts: [{ virtual: '/work' }] }],
    ['mount without leading slash', { mounts: [{ virtual: 'work/' }] }],
    ['overlapping mounts', { mounts: [{ virtual: '/work/' }, { virtual: '/work/sub/' }] }],
    ['the reserved directory', { mounts: [{ virtual: '/.eh-code/' }] }],
    ['install without installer', { packages: { install: 'any' }, python: { envRoot: '/e' } }],
    ['requirements without envRoot', { python: { requirements: ['a'] } }],
    ['requirements without installer', { python: { requirements: ['a'], envRoot: '/e' } }],
    [
      'allowlist without allow',
      { packages: { install: 'allowlist' }, installer: fakeSandbox(), python: { envRoot: '/e' } },
    ],
    ['non-positive limit', { limits: { timeoutMs: 0 } }],
  ])('EH_CONFIG_INVALID: %s', (_name, opts) => {
    try {
      code({ sandbox: fakeSandbox(), ...opts })
      throw new Error('did not throw')
    } catch (error) {
      expect(isHarnessError(error) && error.code === 'EH_CONFIG_INVALID').toBe(true)
    }
  })
})

const python = Bun.spawnSync(['python3', '--version']).exitCode === 0
describe.skipIf(!python)('real localSandbox', () => {
  test('a script reads a synced CSV and its output lands in the file system', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'eh-code-')))
    try {
      const fs = inMemoryFs({
        seed: {
          '/work/a.csv': 'x,y\n1,2\n3,4\n',
          '/work/analyze.py':
            "import csv\nrows = list(csv.DictReader(open('work/a.csv')))\nopen('work/out.txt', 'w').write(str(sum(int(r['y']) for r in rows)))\nopen('work/p.bin', 'wb').write(bytes([0, 255, 1]))\nprint('summed')\n",
        },
      })
      const model = scriptedModel([
        run({ file: '/work/analyze.py' }),
        run({ file: '/work/analyze.py' }),
        { text: 'done' },
      ])
      const agent = defineHarnessAgent({
        model,
        contextWindow: 100_000,
        logger: silent,
        plugins: [filesystem({ fs }), code({ sandbox: () => localSandbox({ root }) })],
      })
      const session = agent.session('s')
      await session.send('go').result
      const out = await outputs(session, 'run_python')
      expect(out[0]).toMatch(
        /^summed\nExit code 0 · \d+\.\ds\nSaved: \/work\/out\.txt, \/work\/p\.bin$/,
      )
      expect((await fs.read('/work/out.txt'))?.content).toBe('6')
      expect((await fs.readBytes?.('/work/p.bin'))?.bytes).toEqual(new Uint8Array([0, 255, 1]))
      expect(out[1]).toMatch(/^summed\nExit code 0/)
      expect(out[1]).not.toContain('Saved')
      await session.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('hardening (review findings)', () => {
  test('the script is passed as ./path, so a leading dash is never an option; HOME is absolute', async () => {
    const sandbox = fakeSandbox()
    const r = await exec(
      [run({ file: '/work/-x.py' }), run({ code: 'print(1)' })],
      { sandbox },
      { '/work/-x.py': 'pass' },
    )
    expect(r.out).toHaveLength(2)
    const runs = sandbox.commands.filter((c) => c.includes('-E -s -B -u'))
    expect(runs[0]).toContain(`-E -s -B -u './work/-x.py'`)
    expect(runs[1]).toContain(`-E -s -B -u './.eh-code/inline.py'`)
    expect(runs[0]).toContain(`HOME="$PWD/.eh-code/home"`)
  })

  test('a listing failure after the run reports that nothing was saved, with the cause', async () => {
    const sandbox = fakeSandbox()
    let started = false
    sandbox.onScript = () => {
      started = true
      return { exitCode: 0, output: '' }
    }
    wrapRun(sandbox, async (o, orig) =>
      started && o.command.includes('list.py')
        ? { exitCode: 1, stdout: '', stderr: 'no python' }
        : orig(o as never),
    )
    const r = await exec([run({ code: 'pass' })], { sandbox })
    expect(r.out[0]).toBe('ERROR: listing the sandbox files failed; nothing was saved. (no python)')
  })
})
