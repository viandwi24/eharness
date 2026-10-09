/**
 * The coder's permission engine = the library's engine + app policy (`src/permissions/engine.ts`):
 * the app's tool kinds, `.coder` protected paths, `request_directory_access` always asking, rule
 * scopes written to `.coder/settings.local.json`. The rule matching, shell analysis and modes
 * themselves are tested in the library (`src/permissions/*.test.ts`).
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CoderConfig,
  type Mount,
  PERMISSION_MODES,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRules,
  TOOL,
  type ToolCallInfo,
} from '../src/contracts.ts'
import {
  createPermissionEngine,
  DONT_ASK_REASON,
  PLAN_MODE_REASON,
} from '../src/permissions/engine.ts'

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'coder-engine-')))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const root = join(tmp, 'proj')
const extra = join(tmp, 'shared-lib')
const outputs = join(tmp, 'tool-outputs')
for (const dir of [root, extra, outputs]) mkdirSync(dir, { recursive: true })

const mounts = (): Mount[] => [
  { virtual: '/', real: root, readonly: false },
  { virtual: '/@dirs/shared-lib/', real: extra, readonly: false },
  { virtual: '/@dirs/ro/', real: join(tmp, 'ro'), readonly: true },
  { virtual: '/.eharness/tool-outputs/', real: outputs, readonly: true },
]

function make(
  mode: PermissionMode = 'default',
  rules: Partial<PermissionRules> = {},
  localSettings = join(
    tmp,
    `settings-${Math.random().toString(36).slice(2)}`,
    'settings.local.json',
  ),
) {
  const config = {
    root,
    mode,
    rules: { allow: [], ask: [], deny: [], ...rules },
    settingsFiles: {
      user: join(tmp, 'u.json'),
      project: join(tmp, 'p.json'),
      local: localSettings,
    },
  } as unknown as CoderConfig
  return createPermissionEngine({
    config,
    mounts,
    classifierModel: () => {
      throw new Error('the classifier model is not used here')
    },
  })
}

const bash = (command: string): ToolCallInfo => ({ toolName: TOOL.bash, input: { command } })
const call = (toolName: string, input: unknown = {}): ToolCallInfo => ({ toolName, input })
const fileCall = (toolName: string, path: string): ToolCallInfo => call(toolName, { path })
const status = (d: PermissionDecision): string => d.status

describe('mode x tool matrix', () => {
  // [mode, call, expected status]
  const reads = [
    fileCall(TOOL.read, '/src/a.ts'),
    fileCall(TOOL.list, '/src'),
    call(TOOL.grep, { pattern: 'x' }),
    call(TOOL.glob, { pattern: '**/*.ts' }),
    fileCall(TOOL.read, '/@dirs/shared-lib/a.ts'),
    fileCall(TOOL.read, '/.eharness/tool-outputs/o.txt'),
    call(TOOL.todo, { todos: [] }),
    call('load_skill', { name: 'x' }),
  ]
  for (const mode of PERMISSION_MODES) {
    test(`reads are approved in ${mode}`, () => {
      const engine = make(mode)
      for (const c of reads) expect(engine.decide(c)).toEqual({ status: 'approved' })
    })
  }

  const edits = [
    fileCall(TOOL.edit, '/src/a.ts'),
    fileCall(TOOL.write, '/src/new.ts'),
    fileCall(TOOL.delete, '/src/a.ts'),
    fileCall(TOOL.write, '/@dirs/shared-lib/a.ts'),
  ]
  const editExpect: Record<PermissionMode, string> = {
    default: 'user-approval',
    acceptEdits: 'approved',
    plan: 'denied',
    dontAsk: 'denied',
    bypassPermissions: 'approved',
    auto: 'approved',
  }
  for (const mode of PERMISSION_MODES) {
    test(`edits are ${editExpect[mode]} in ${mode}`, () => {
      const engine = make(mode)
      for (const c of edits) expect(status(engine.decide(c))).toBe(editExpect[mode])
    })
  }

  test('plan mode denies edits with the plan reason, dontAsk with its reason', () => {
    expect(make('plan').decide(fileCall(TOOL.write, '/a.ts'))).toEqual({
      status: 'denied',
      reason: PLAN_MODE_REASON,
    })
    expect(make('dontAsk').decide(fileCall(TOOL.write, '/a.ts'))).toEqual({
      status: 'denied',
      reason: DONT_ASK_REASON,
    })
  })

  test('edits to a read-only mount are denied in every mode', () => {
    for (const mode of ['default', 'acceptEdits', 'bypassPermissions'] as const) {
      const d = make(mode).decide(fileCall(TOOL.write, '/@dirs/ro/a.ts'))
      expect(d).toMatchObject({ status: 'denied', reason: 'That directory is read-only.' })
    }
    expect(status(make().decide(fileCall(TOOL.write, '/.eharness/tool-outputs/x')))).toBe('denied')
  })

  test('paths outside every mount or invalid are denied', () => {
    const engine = make('default')
    // without the root mount nothing but the extra directories is reachable
    const only = createPermissionEngine({
      config: {
        root,
        mode: 'default',
        rules: { allow: [], ask: [], deny: [] },
        settingsFiles: {},
      } as unknown as CoderConfig,
      mounts: () => [{ virtual: '/@dirs/lib/', real: extra, readonly: false }],
    })
    expect(only.decide(fileCall(TOOL.read, '/src/a.ts'))).toMatchObject({
      status: 'denied',
      reason: 'The path is outside the working directories.',
    })
    expect(only.decide(fileCall(TOOL.write, '/src/a.ts'))).toMatchObject({ status: 'denied' })
    expect(engine.decide(call(TOOL.read, {}))).toMatchObject({
      status: 'denied',
      reason: 'Invalid path.',
    })
    expect(engine.decide(call(TOOL.write, {}))).toMatchObject({
      status: 'denied',
      reason: 'Invalid path.',
    })
  })

  test('agent is approved in every mode', () => {
    for (const mode of PERMISSION_MODES) {
      expect(make(mode).decide(call(TOOL.agent, { subagent_type: 'x' }))).toEqual({
        status: 'approved',
      })
    }
  })

  test('request_directory_access asks in every mode (dontAsk and plan deny: it would ask)', () => {
    const c = call(TOOL.dirAccess, { path: '/tmp/x', reason: 'r' })
    for (const mode of PERMISSION_MODES) {
      const d = make(mode).decide(c)
      // plan mode hides the tool (and the library denies unknown tools there)
      expect(status(d)).toBe(mode === 'dontAsk' || mode === 'plan' ? 'denied' : 'user-approval')
    }
  })

  test('request_directory_access still asks with a bare allow rule', () => {
    const engine = make('default', { allow: [TOOL.dirAccess, 'Bash'] })
    expect(status(engine.decide(call(TOOL.dirAccess, { path: '/x' })))).toBe('user-approval')
  })

  test('exit_plan_mode asks in plan, is denied elsewhere', () => {
    const c = call(TOOL.exitPlan, { plan: 'p' })
    expect(status(make('plan').decide(c))).toBe('user-approval')
    for (const mode of ['default', 'acceptEdits', 'dontAsk', 'bypassPermissions'] as const) {
      expect(make(mode).decide(c)).toMatchObject({ status: 'denied' })
    }
  })

  test('unknown tools (MCP) ask, except in bypass', () => {
    const c = call('mcp__srv__tool', {})
    expect(status(make('default').decide(c))).toBe('user-approval')
    expect(status(make('acceptEdits').decide(c))).toBe('user-approval')
    expect(status(make('plan').decide(c))).toBe('denied')
    expect(status(make('dontAsk').decide(c))).toBe('denied')
    expect(status(make('bypassPermissions').decide(c))).toBe('approved')
  })

  test('decide(call, mode) overrides the current mode', () => {
    const engine = make('default')
    expect(status(engine.decide(fileCall(TOOL.write, '/a'), 'acceptEdits'))).toBe('approved')
    expect(engine.mode).toBe('default')
  })
})

describe('protected paths', () => {
  const protectedCalls = [
    fileCall(TOOL.write, '/.git/config'),
    fileCall(TOOL.edit, '/.git/hooks/pre-commit'),
    fileCall(TOOL.write, '/.coder/settings.json'),
    fileCall(TOOL.write, '/.coder/settings.local.json'),
    fileCall(TOOL.write, '/.coder/agents/x.md'),
    fileCall(TOOL.delete, '/.git'),
    fileCall(TOOL.write, '/@dirs/shared-lib/.git/config'),
  ]
  for (const mode of ['default', 'acceptEdits', 'bypassPermissions'] as const) {
    test(`ask in ${mode}`, () => {
      const engine = make(mode)
      for (const c of protectedCalls) {
        expect(engine.decide(c)).toMatchObject({ status: 'user-approval' })
      }
    })
  }

  test('plan denies them, dontAsk denies them', () => {
    for (const c of protectedCalls) {
      expect(status(make('plan').decide(c))).toBe('denied')
      expect(status(make('dontAsk').decide(c))).toBe('denied')
    }
  })

  test('an allow rule does not unprotect', () => {
    const engine = make('bypassPermissions', { allow: ['Edit', 'Write(.git/**)'] })
    expect(status(engine.decide(fileCall(TOOL.write, '/.git/config')))).toBe('user-approval')
  })

  test('similar paths are not protected', () => {
    const engine = make('acceptEdits')
    for (const path of [
      '/.gitignore',
      '/.github/ci.yml',
      '/.coder/skills/a.md',
      '/.coder/notes.md',
      '/src/.git-x',
    ]) {
      expect(engine.decide(fileCall(TOOL.write, path))).toEqual({ status: 'approved' })
    }
  })

  test('deny rules still win over a protected ask', () => {
    const engine = make('default', { deny: ['Edit(.git/**)'] })
    expect(status(engine.decide(fileCall(TOOL.write, '/.git/config')))).toBe('denied')
  })

  test('bash redirects to protected paths ask in every mode', () => {
    for (const mode of ['default', 'acceptEdits', 'bypassPermissions'] as const) {
      const d = make(mode).decide(bash('echo x > .git/config'))
      expect(status(d)).toBe('user-approval')
    }
    expect(status(make('bypassPermissions').decide(bash('echo x >> .coder/settings.json')))).toBe(
      'user-approval',
    )
  })

  test('bash writes to protected paths are not auto-approved by acceptEdits', () => {
    expect(status(make('acceptEdits').decide(bash('touch .git/x')))).toBe('user-approval')
    expect(status(make('acceptEdits').decide(bash('mkdir .coder/agents/new')))).toBe(
      'user-approval',
    )
  })
})

describe('allow()', () => {
  test('session scope changes decide and writes nothing', async () => {
    const local = join(tmp, 'sess', 'settings.local.json')
    const engine = make('default', {}, local)
    const c = bash('bun test a')
    expect(status(engine.decide(c))).toBe('user-approval')
    await engine.allow('Bash(bun test *)', 'session')
    expect(engine.decide(c)).toEqual({ status: 'approved', rule: 'Bash(bun test *)' })
    expect(engine.rules().allow).toEqual(['Bash(bun test *)'])
    expect(() => readFileSync(local)).toThrow()
  })

  test('duplicates are ignored and an invalid rule is refused', async () => {
    const engine = make('default')
    await engine.allow('Edit', 'session')
    await engine.allow('Edit', 'session')
    await expect(engine.allow('  ', 'session')).rejects.toThrow('invalid permission rule')
    await expect(engine.allow('Bash (x', 'session')).rejects.toThrow('invalid permission rule')
    expect(engine.rules().allow).toEqual(['Edit'])
  })

  test('project scope creates settings.local.json (and its directory)', async () => {
    const local = join(tmp, 'proj-new', '.coder', 'settings.local.json')
    const engine = make('default', {}, local)
    await engine.allow('Bash(bun test *)', 'project')
    expect(JSON.parse(readFileSync(local, 'utf8'))).toEqual({
      permissions: { allow: ['Bash(bun test *)'] },
    })
    expect(status(engine.decide(bash('bun test')))).toBe('approved')
  })

  test('project scope keeps existing keys and rules, no duplicates', async () => {
    const dir = join(tmp, 'proj-existing')
    mkdirSync(dir, { recursive: true })
    const local = join(dir, 'settings.local.json')
    writeFileSync(
      local,
      JSON.stringify({
        model: 'm',
        permissions: { deny: ['Bash(rm *)'], allow: ['Edit'], defaultMode: 'plan' },
        mcpServers: { a: {} },
      }),
    )
    const engine = make('default', {}, local)
    await engine.allow('Bash(ls *)', 'project')
    await engine.allow('Bash(ls *)', 'project')
    await engine.allow('Edit', 'project')
    expect(JSON.parse(readFileSync(local, 'utf8'))).toEqual({
      model: 'm',
      permissions: { deny: ['Bash(rm *)'], allow: ['Edit', 'Bash(ls *)'], defaultMode: 'plan' },
      mcpServers: { a: {} },
    })
    expect(readFileSync(local, 'utf8').endsWith('\n')).toBe(true)
  })

  test('project scope recovers from a corrupt or non-object file', async () => {
    for (const content of ['{not json', '[1,2]', 'null', '"x"']) {
      const dir = mkdtempSync(join(tmp, 'corrupt-'))
      const local = join(dir, 'settings.local.json')
      writeFileSync(local, content)
      const engine = make('default', {}, local)
      await engine.allow('Read', 'project')
      expect(JSON.parse(readFileSync(local, 'utf8'))).toEqual({ permissions: { allow: ['Read'] } })
    }
  })
})

describe('finding 6: protected paths and shell writes', () => {
  test('a non-read-only bash command that mentions a protected path asks in every mode', () => {
    for (const c of [
      'cp evil .coder/settings.local.json',
      'sed -i s/a/b/ .git/config',
      'rm -rf .git',
      `python3 -c "open('.coder/settings.json','w')"`,
      'echo x > ./.coder/agents/a.md',
      'cd .coder && cp x y',
      'rm -rf sub/.git/hooks',
    ]) {
      for (const mode of ['default', 'acceptEdits', 'bypassPermissions'] as const) {
        expect([c, mode, make(mode).decide(bash(c))]).toEqual([
          c,
          mode,
          { status: 'user-approval', reason: expect.any(String) },
        ])
      }
      expect(make('bypassPermissions').decide(bash(c))).toMatchObject({ status: 'user-approval' })
      expect(status(make('dontAsk').decide(bash(c)))).toBe('denied')
    }
    expect(make('bypassPermissions').decide(bash('rm -rf .git'))).toEqual({
      status: 'user-approval',
      reason: 'touches a protected path',
    })
  })

  test('a protected path is not unprotected by an allow rule', () => {
    expect(status(make('default', { allow: ['Bash(rm *)'] }).decide(bash('rm -rf .git')))).toBe(
      'user-approval',
    )
  })

  test('look-alikes and read-only reads of .git are fine', () => {
    for (const c of [
      'git add .gitignore',
      'rm -rf .github',
      'rm foo.git',
      'cat .git/config',
      'git status',
    ]) {
      const d = make('bypassPermissions').decide(bash(c))
      expect([c, d.status]).toEqual([c, 'approved'])
    }
  })

  test('an allow rule does not approve a redirect or tee outside the working directories', () => {
    const engine = make('default', { allow: ['Bash(echo *)', 'Bash(cat *)'] })
    for (const c of [
      'echo hi > /etc/x',
      'echo hi >> ~/.bashrc',
      'echo hi > $HOME/x',
      'echo a > ../x',
    ]) {
      expect([c, status(engine.decide(bash(c)))]).toEqual([c, 'user-approval'])
    }
    expect(status(engine.decide(bash('echo hi > out.txt')))).toBe('approved')
    expect(status(engine.decide(bash('echo hi > /dev/null')))).toBe('approved')
    expect(status(engine.decide(bash(`echo hi > ${extra}/a`)))).toBe('approved')
    const tee = make('default', { allow: ['Bash(cat *)', 'Bash(tee *)'] })
    expect(status(tee.decide(bash('tee /etc/x')))).toBe('user-approval')
    expect(status(tee.decide(bash('tee out.txt')))).toBe('approved')
  })
})

describe('finding 9: addRule / removeRule', () => {
  test('addRule: any kind, validated, session scope writes nothing', async () => {
    const file = join(tmp, 'ar1', 'settings.local.json')
    const engine = make('default', {}, file)
    await engine.addRule('deny', 'Bash(rm *)', 'session')
    await engine.addRule('ask', 'Read(x)', 'session')
    expect(engine.rules()).toEqual({ allow: [], ask: ['Read(x)'], deny: ['Bash(rm *)'] })
    expect(() => readFileSync(file, 'utf8')).toThrow()
    await expect(engine.addRule('deny', 'not a rule(', 'session')).rejects.toThrow(
      /invalid permission rule/i,
    )
    expect(status(engine.decide(bash('rm x')))).toBe('denied')
  })

  test('addRule project: read-modify-write keeps other keys, no duplicates', async () => {
    const file = join(tmp, 'ar2', 'settings.local.json')
    mkdirSync(join(tmp, 'ar2'), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({ model: 'm', permissions: { allow: ['A'], defaultMode: 'plan' } }),
    )
    const engine = make('default', {}, file)
    await engine.addRule('deny', 'Edit(secrets/**)', 'project')
    await engine.addRule('deny', 'Edit(secrets/**)', 'project')
    await engine.addRule('allow', 'Bash(ls)', 'project')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      model: 'm',
      permissions: { allow: ['A', 'Bash(ls)'], defaultMode: 'plan', deny: ['Edit(secrets/**)'] },
    })
  })

  test('removeRule: memory and file, returns whether it existed', async () => {
    const file = join(tmp, 'ar3', 'settings.local.json')
    mkdirSync(join(tmp, 'ar3'), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({ model: 'm', permissions: { deny: ['Edit(x)', 'Edit(y)'] } }),
    )
    const engine = make('default', { deny: ['Edit(x)'] }, file)
    expect(await engine.removeRule('deny', 'Edit(x)')).toBe(true)
    expect(engine.rules().deny).toEqual([])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      model: 'm',
      permissions: { deny: ['Edit(y)'] },
    })
    expect(await engine.removeRule('deny', 'Edit(x)')).toBe(false)
    // only in the file (not a rule of the engine): nothing to remove
    expect(await engine.removeRule('deny', 'Edit(y)')).toBe(false)
    // only in memory, no file at all
    const lone = make('default', { ask: ['Read(z)'] })
    expect(await lone.removeRule('ask', 'Read(z)')).toBe(true)
    expect(await lone.removeRule('ask', 'Read(z)')).toBe(false)
  })
})

describe('app policy on top of the library engine', () => {
  test('the tool-outputs mount is not a working directory for shell reads', () => {
    expect(status(make().decide(bash(`cat ${outputs}/o.txt`)))).toBe('user-approval')
  })

  test('invalid rules are ignored', () => {
    const engine = make('default', { deny: ['', 'Bash (x)'], allow: ['((('] })
    expect(status(engine.decide(bash('ls')))).toBe('approved')
  })
})

describe('auto mode and the mode cycle', () => {
  const withConfig = (extra: Partial<CoderConfig>, classifier = true) =>
    createPermissionEngine({
      config: {
        root,
        mode: 'default',
        rules: { allow: [], ask: [], deny: [] },
        settingsFiles: {
          user: join(tmp, 'u.json'),
          project: join(tmp, 'p.json'),
          local: join(tmp, 'l.json'),
        },
        ...extra,
      } as unknown as CoderConfig,
      mounts,
      ...(classifier ? { classifierModel: () => ({}) as never } : {}),
    })
  const cycle = (engine: ReturnType<typeof withConfig>): PermissionMode[] => {
    const seen: PermissionMode[] = []
    for (let i = 0; i < 6; i++) seen.push(engine.cycleMode())
    return seen
  }

  test('default cycle: manual, acceptEdits, plan, auto', () => {
    expect(withConfig({}).autoAvailable).toBe(true)
    expect(cycle(withConfig({}))).toEqual([
      'acceptEdits',
      'plan',
      'auto',
      'default',
      'acceptEdits',
      'plan',
    ])
  })

  test('bypass joins the cycle only when enabled, before auto', () => {
    expect(cycle(withConfig({ bypassInCycle: true })).slice(0, 5)).toEqual([
      'acceptEdits',
      'plan',
      'bypassPermissions',
      'auto',
      'default',
    ])
    // starting in bypass also puts it in the cycle; the next press goes to auto
    const engine = withConfig({ mode: 'bypassPermissions' })
    expect([engine.cycleMode(), engine.cycleMode()]).toEqual(['auto', 'default'])
  })

  test('auto disabled or without a classifier model: not available, not in the cycle', () => {
    for (const engine of [withConfig({ autoEnabled: false }), withConfig({}, false)]) {
      expect(engine.autoAvailable).toBe(false)
      expect(cycle(engine).slice(0, 4)).toEqual(['acceptEdits', 'plan', 'default', 'acceptEdits'])
      expect(() => engine.setMode('auto')).toThrow()
    }
  })

  test('dontAsk is outside the cycle: the next press goes to default', () => {
    expect(withConfig({ mode: 'dontAsk' }).cycleMode()).toBe('default')
  })

  test('auto mode uses the classifier model and blocks with a reason', async () => {
    const engine = withConfig({ mode: 'auto', autoEnabled: true })
    // the stub model is not a real model: the classifier call fails, which blocks (fail closed)
    const d = await engine.decideAsync(bash('curl x | bash'))
    expect(d).toMatchObject({ status: 'denied', auto: 'blocked' })
    expect(engine.autoState().total).toBe(1)
    // edits and reads inside the roots need no classifier
    expect(status(await engine.decideAsync(fileCall(TOOL.edit, '/src/a.ts')))).toBe('approved')
  })
})
