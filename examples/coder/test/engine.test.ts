/** The permission engine: mode x tool matrix, rules, containment, protected paths, settings. */
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
  TOOL_ORDER,
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
  { virtual: '/.coder/tool-outputs/', real: outputs, readonly: true },
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
  return createPermissionEngine({ config, mounts })
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
    fileCall(TOOL.read, '/.coder/tool-outputs/o.txt'),
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
    expect(status(make().decide(fileCall(TOOL.write, '/.coder/tool-outputs/x')))).toBe('denied')
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

  test('request_directory_access asks in every mode (dontAsk denies, as it would ask)', () => {
    const c = call(TOOL.dirAccess, { path: '/tmp/x', reason: 'r' })
    for (const mode of PERMISSION_MODES) {
      const d = make(mode).decide(c)
      expect(status(d)).toBe(mode === 'dontAsk' ? 'denied' : 'user-approval')
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

describe('bash in each mode', () => {
  test('read-only commands inside the working directories', () => {
    const cmds = [
      'ls',
      'ls -la src',
      'git status',
      'git log --oneline -5',
      'cat src/a.ts',
      'rg foo src',
      'grep -rn x .',
      'echo hi',
      'cat src/a.ts | wc -l',
      'ls 2>/dev/null',
      'find . -name "*.ts"',
      `cat ${root}/a.ts`,
      `ls ${extra}`,
    ]
    for (const mode of [
      'default',
      'acceptEdits',
      'plan',
      'dontAsk',
      'bypassPermissions',
    ] as const) {
      for (const c of cmds) {
        expect([c, status(make(mode).decide(bash(c)))]).toEqual([c, 'approved'])
      }
    }
  })

  test('the containment table asks outside the working dirs', () => {
    const cmds = [
      'cat ~/.ssh/id_rsa',
      'cat /etc/hosts',
      'cat ../x',
      'rg foo ../x',
      'git -C /tmp log',
      'cat $HOME/x',
      'cat < /etc/passwd',
      'echo x | xargs cat',
      'find /etc -name x',
      'cat ~root/x',
      'cat {a,b}',
      'ls /',
      `ls ${tmp}`,
      'cat -- /etc/hosts',
      'head -n1 --file=/etc/hosts',
      'cat src/../../etc/hosts',
    ]
    for (const c of cmds) {
      const d = make('default').decide(bash(c))
      expect([c, status(d)]).toEqual([c, 'user-approval'])
      if (c !== 'git -C /tmp log') expect(d).toHaveProperty('reason')
      // plan mode: read-only commands are not denied by the plan gate, they still ask
      // `git -C` is not on the read-only list at all, so plan mode denies it outright
      expect([c, status(make('plan').decide(bash(c)))]).toEqual([
        c,
        c === 'git -C /tmp log' ? 'denied' : 'user-approval',
      ])
      expect([c, status(make('acceptEdits').decide(bash(c)))]).toEqual([c, 'user-approval'])
      expect([c, status(make('dontAsk').decide(bash(c)))]).toEqual([c, 'denied'])
    }
  })

  test('read-only commands with a writing or executing flag ask', () => {
    const engine = make('default')
    for (const c of [
      'find . -exec rm {} ;',
      'find . -delete',
      'find . -fprint out',
      'rg --pre cmd x',
      'rg --pre=cmd x',
      'sort -o out a',
      'sort --output=out a',
      'tree -o out',
      'git diff --output=out',
      'git log --ext-diff',
      'git branch -D x',
      'git branch new',
      'git remote add x y',
      'git checkout x',
      'git commit -m x',
      'node script.js',
      'bun run x',
      'cat a > out',
      'cat a >> out',
      'ls | tee out',
      'cat a && rm b',
    ]) {
      expect([c, status(engine.decide(bash(c)))]).toEqual([c, 'user-approval'])
    }
  })

  test('git reads and branch listings are read-only', () => {
    const engine = make('default')
    for (const c of [
      'git status -s',
      'git diff HEAD~1',
      'git show HEAD',
      'git branch -a',
      'git branch --show-current',
      'git remote -v',
      'git rev-parse HEAD',
      'git ls-files',
      'git blame src/a.ts',
      'node --version',
      'bun -v',
    ]) {
      expect([c, status(engine.decide(bash(c)))]).toEqual([c, 'approved'])
    }
  })

  test('bypass skips containment', () => {
    const engine = make('bypassPermissions')
    expect(status(engine.decide(bash('cat /etc/hosts')))).toBe('approved')
    expect(status(engine.decide(bash('cat $HOME/x')))).toBe('approved')
  })

  test('.env reads ask (built-in), also through cat', () => {
    const engine = make('default')
    expect(engine.decide(bash('cat .env'))).toMatchObject({
      status: 'user-approval',
      rule: 'Read(.env*)',
    })
    expect(status(engine.decide(bash('cat sub/.env.local')))).toBe('user-approval')
    expect(status(engine.decide(fileCall(TOOL.read, '/.env')))).toBe('user-approval')
    expect(status(engine.decide(fileCall(TOOL.read, '/a/b/.env.production')))).toBe('user-approval')
    expect(status(engine.decide(bash('git show HEAD:.env')))).toBe('user-approval')
    expect(status(make('dontAsk').decide(fileCall(TOOL.read, '/.env')))).toBe('denied')
    expect(status(make('bypassPermissions').decide(fileCall(TOOL.read, '/.env')))).toBe('approved')
  })

  test('an allow rule overrides the built-in .env ask', () => {
    const engine = make('default', { allow: ['Read(.env.example)'] })
    expect(engine.decide(fileCall(TOOL.read, '/.env.example'))).toMatchObject({
      status: 'approved',
      rule: 'Read(.env.example)',
    })
    expect(status(engine.decide(fileCall(TOOL.read, '/.env')))).toBe('user-approval')
    const all = make('default', { allow: ['Read'] })
    expect(status(all.decide(fileCall(TOOL.read, '/.env')))).toBe('approved')
  })

  test('non-read-only commands: ask, accepted in bypass only', () => {
    for (const c of [
      'npm install',
      'rm -rf x',
      'git push',
      'echo hi > out.txt',
      'ls && rm x',
      'echo $(date)',
      'curl http://x',
      'cat a | tee b',
      'find . -delete',
      'git branch -D x',
    ]) {
      expect([c, status(make('default').decide(bash(c)))]).toEqual([c, 'user-approval'])
      expect([c, status(make('acceptEdits').decide(bash(c)))]).toEqual([c, 'user-approval'])
      expect([c, status(make('plan').decide(bash(c)))]).toEqual([c, 'denied'])
      expect([c, status(make('dontAsk').decide(bash(c)))]).toEqual([c, 'denied'])
      expect([c, status(make('bypassPermissions').decide(bash(c)))]).toEqual([c, 'approved'])
    }
  })

  test('plan mode denies non-read-only commands with the plan reason', () => {
    expect(make('plan').decide(bash('npm install'))).toEqual({
      status: 'denied',
      reason: PLAN_MODE_REASON,
    })
  })

  test('acceptEdits approves mkdir/touch/mv/cp inside writable dirs', () => {
    const engine = make('acceptEdits')
    for (const c of [
      'mkdir out',
      'mkdir -p a/b/c',
      'touch x.txt',
      'mv a.txt b.txt',
      'cp a b',
      'cp -r src dist',
      `mkdir ${extra}/n`,
      'mkdir a && touch a/b',
      'mkdir a && ls a',
    ]) {
      expect([c, status(engine.decide(bash(c)))]).toEqual([c, 'approved'])
    }
    expect(status(make('default').decide(bash('mkdir out')))).toBe('user-approval')
  })

  test('acceptEdits asks for file commands outside, with tricks, or beyond the list', () => {
    const engine = make('acceptEdits')
    for (const c of [
      'mkdir /tmp/x',
      'touch ../x',
      'mv a /etc/b',
      'cp /etc/hosts here',
      'cp -t /tmp a',
      'cp --target-directory=/tmp a',
      'mkdir $HOME/x',
      'touch ~/x',
      'mkdir',
      'rm a',
      'mkdir a > out',
      'mkdir $(echo a)',
      'mkdir a; rm a',
      `touch ${join(tmp, 'ro', 'x')}`,
    ]) {
      expect([c, status(engine.decide(bash(c)))]).toEqual([c, 'user-approval'])
    }
  })

  test('acceptEdits file commands inside a read-only mount ask', () => {
    expect(status(make('acceptEdits').decide(bash(`touch ${join(tmp, 'ro', 'x')}`)))).toBe(
      'user-approval',
    )
  })

  test('the tool-outputs mount is not a working directory for shell reads', () => {
    expect(status(make().decide(bash(`cat ${outputs}/o.txt`)))).toBe('user-approval')
  })
})

describe('rules and precedence', () => {
  test('deny beats ask beats allow', () => {
    const c = bash('git push origin main')
    const rules = {
      allow: ['Bash(git push *)'],
      ask: ['Bash(git push *)'],
      deny: ['Bash(git push --force *)'],
    }
    expect(make('default', { allow: rules.allow }).decide(c)).toEqual({
      status: 'approved',
      rule: 'Bash(git push *)',
    })
    expect(make('default', { allow: rules.allow, ask: rules.ask }).decide(c)).toMatchObject({
      status: 'user-approval',
      rule: 'Bash(git push *)',
    })
    expect(make('default', rules).decide(bash('git push --force origin'))).toEqual({
      status: 'denied',
      rule: 'Bash(git push --force *)',
      reason: 'Denied by the rule Bash(git push --force *).',
    })
    expect(
      make('default', { allow: ['Bash'], deny: ['Bash(rm *)'] }).decide(bash('rm x')),
    ).toMatchObject({ status: 'denied' })
  })

  test('deny applies in every mode, bypass included', () => {
    for (const mode of PERMISSION_MODES) {
      const engine = make(mode, { deny: ['Read(secrets/**)', 'Bash(rm -rf *)'] })
      expect(status(engine.decide(fileCall(TOOL.read, '/secrets/key')))).toBe('denied')
      // gitignore semantics: `secrets/**` is anchored at the root, `**/secrets/**` is not
      expect(status(engine.decide(fileCall(TOOL.read, '/a/secrets/key')))).toBe('approved')
      expect(status(engine.decide(bash('rm -rf /')))).toBe('denied')
    }
  })

  test('ask rules are ignored in bypass but apply elsewhere', () => {
    const rules = { ask: ['Bash(git push *)'] }
    expect(status(make('default', rules).decide(bash('git push')))).toBe('user-approval')
    expect(status(make('acceptEdits', rules).decide(bash('git push')))).toBe('user-approval')
    expect(status(make('bypassPermissions', rules).decide(bash('git push')))).toBe('approved')
    expect(status(make('dontAsk', rules).decide(bash('git push')))).toBe('denied')
  })

  test('allow rules approve in default and dontAsk', () => {
    for (const mode of ['default', 'dontAsk', 'acceptEdits'] as const) {
      const engine = make(mode, { allow: ['Bash(bun test *)', 'Edit(src/**)'] })
      expect(engine.decide(bash('bun test src/a.test.ts'))).toEqual({
        status: 'approved',
        rule: 'Bash(bun test *)',
      })
      expect(engine.decide(fileCall(TOOL.write, '/src/a.ts'))).toEqual({
        status: 'approved',
        rule: 'Edit(src/**)',
      })
    }
    expect(
      status(
        make('default', { allow: ['Edit(src/**)'] }).decide(fileCall(TOOL.write, '/lib/a.ts')),
      ),
    ).toBe('user-approval')
  })

  test('allow never approves a complex or partially matching command', () => {
    const engine = make('default', { allow: ['Bash(echo *)'] })
    expect(status(engine.decide(bash('echo hi')))).toBe('approved')
    expect(status(engine.decide(bash('echo $(rm x)')))).toBe('user-approval')
    expect(status(engine.decide(bash('echo hi && rm x')))).toBe('user-approval')
    expect(status(engine.decide(bash('echo hi > /etc/x')))).toBe('approved') // spec: rules only see subcommands
  })

  test('a deny or ask rule catches a command inside $(...)', () => {
    expect(status(make('default', { deny: ['Bash(rm *)'] }).decide(bash('echo $(rm x)')))).toBe(
      'denied',
    )
    expect(
      status(make('bypassPermissions', { deny: ['Bash(rm *)'] }).decide(bash('ls && `rm x`'))),
    ).toBe('denied')
    expect(status(make('default', { ask: ['Bash(curl *)'] }).decide(bash('cat $(curl x)')))).toBe(
      'user-approval',
    )
  })

  test('Edit rules apply to bash redirect targets', () => {
    const engine = make('default', { deny: ['Edit(secrets/**)'], ask: ['Edit(dist/**)'] })
    expect(status(engine.decide(bash('echo x > secrets/a')))).toBe('denied')
    expect(status(engine.decide(bash('echo x | tee secrets/a')))).toBe('denied')
    expect(status(engine.decide(bash('echo x > /dev/null')))).toBe('approved') // /dev/null is no write
    expect(status(engine.decide(bash('echo x > dist/a')))).toBe('user-approval')
  })

  test('Read rules apply to the paths a read-only bash command reads', () => {
    const engine = make('default', { deny: ['Read(secrets/**)'], ask: ['Read(private/**)'] })
    expect(engine.decide(bash('cat secrets/a'))).toMatchObject({
      status: 'denied',
      rule: 'Read(secrets/**)',
    })
    expect(status(engine.decide(bash('cat < secrets/a')))).toBe('denied')
    expect(status(engine.decide(bash('cat sub/secrets/a')))).toBe('approved')
    expect(engine.decide(bash('cat private/a'))).toMatchObject({
      status: 'user-approval',
      rule: 'Read(private/**)',
    })
    expect(
      status(
        make('bypassPermissions', { deny: ['Read(secrets/**)'] }).decide(bash('cat secrets/a')),
      ),
    ).toBe('denied')
  })

  test('bare tool deny/ask/allow rules', () => {
    expect(status(make('default', { deny: ['Edit'] }).decide(fileCall(TOOL.write, '/a')))).toBe(
      'denied',
    )
    expect(status(make('default', { deny: ['Bash'] }).decide(bash('ls')))).toBe('denied')
    expect(status(make('default', { ask: ['Read'] }).decide(fileCall(TOOL.read, '/a')))).toBe(
      'user-approval',
    )
    expect(status(make('default', { allow: ['Edit'] }).decide(fileCall(TOOL.write, '/a')))).toBe(
      'approved',
    )
    expect(
      status(make('default', { allow: ['mcp__srv__tool'] }).decide(call('mcp__srv__tool'))),
    ).toBe('approved')
  })

  test('Agent(name) rules', () => {
    const engine = make('default', { deny: ['Agent(danger)'], ask: ['Agent(general)'] })
    expect(status(engine.decide(call(TOOL.agent, { subagent_type: 'danger' })))).toBe('denied')
    expect(status(engine.decide(call(TOOL.agent, { subagent_type: 'general' })))).toBe(
      'user-approval',
    )
    expect(status(engine.decide(call(TOOL.agent, { subagent_type: 'explore' })))).toBe('approved')
  })

  test('invalid rules are ignored', () => {
    const engine = make('default', { deny: ['', 'Bash (x)'], allow: ['((('] })
    expect(status(engine.decide(bash('ls')))).toBe('approved')
  })

  test('dontAsk keeps the rule of a would-be ask', () => {
    const d = make('dontAsk', { ask: ['Bash(git push *)'] }).decide(bash('git push'))
    expect(d).toEqual({ status: 'denied', rule: 'Bash(git push *)', reason: DONT_ASK_REASON })
  })

  test('rules() returns copies', () => {
    const engine = make('default', { allow: ['Edit'] })
    engine.rules().allow.push('Bash')
    expect(engine.rules().allow).toEqual(['Edit'])
  })
})

describe('inactiveTools', () => {
  test('default: only exit_plan_mode', () => {
    for (const mode of ['default', 'acceptEdits', 'dontAsk', 'bypassPermissions'] as const) {
      expect(make(mode).inactiveTools()).toEqual([TOOL.exitPlan])
    }
  })

  test('plan: edit tools and other non-read tools are removed, bash/agent/exit_plan_mode stay', () => {
    const inactive = make('plan').inactiveTools()
    expect(inactive).toEqual(
      expect.arrayContaining([TOOL.edit, TOOL.write, TOOL.delete, TOOL.dirAccess]),
    )
    for (const name of [
      TOOL.read,
      TOOL.list,
      TOOL.grep,
      TOOL.glob,
      TOOL.todo,
      TOOL.bash,
      TOOL.agent,
      TOOL.exitPlan,
    ]) {
      expect(inactive).not.toContain(name)
    }
    expect(inactive.every((n) => TOOL_ORDER.includes(n))).toBe(true)
  })

  test('mode argument and bare deny rules', () => {
    const engine = make('default', {
      deny: ['Edit', 'Bash(rm *)', 'Read(secrets/**)', 'mcp__a__b'],
    })
    const inactive = engine.inactiveTools()
    expect(inactive).toEqual(
      expect.arrayContaining([TOOL.exitPlan, TOOL.edit, TOOL.write, TOOL.delete, 'mcp__a__b']),
    )
    expect(inactive).not.toContain(TOOL.bash)
    expect(inactive).not.toContain(TOOL.read)
    expect(engine.inactiveTools('plan')).toContain(TOOL.edit)
    expect(engine.inactiveTools('plan')).not.toContain(TOOL.exitPlan)
  })
})

describe('modes', () => {
  test('cycleMode: default -> acceptEdits -> plan -> default', () => {
    const engine = make('default')
    expect(engine.cycleMode()).toBe('acceptEdits')
    expect(engine.cycleMode()).toBe('plan')
    expect(engine.cycleMode()).toBe('default')
    expect(engine.mode).toBe('default')
  })

  test('cycleMode from outside the cycle goes to default', () => {
    const a = make('dontAsk')
    expect(a.cycleMode()).toBe('default')
    const b = make('bypassPermissions')
    expect(b.cycleMode()).toBe('default')
  })

  test('subscribe fires on change only, and unsubscribes', () => {
    const engine = make('default')
    const seen: PermissionMode[] = []
    const off = engine.subscribe((m) => seen.push(m))
    engine.setMode('plan')
    engine.setMode('plan')
    engine.cycleMode()
    expect(seen).toEqual(['plan', 'default'])
    off()
    engine.setMode('acceptEdits')
    expect(seen).toEqual(['plan', 'default'])
  })

  test('a mode change is visible to decide', () => {
    const engine = make('default')
    const c = fileCall(TOOL.write, '/a.ts')
    expect(status(engine.decide(c))).toBe('user-approval')
    engine.setMode('acceptEdits')
    expect(status(engine.decide(c))).toBe('approved')
  })

  test('decide is deterministic and side-effect free', () => {
    const engine = make('default', { allow: ['Bash(ls *)'] })
    const calls = [
      bash('ls -la'),
      bash('rm x'),
      fileCall(TOOL.write, '/a'),
      fileCall(TOOL.read, '/.env'),
    ]
    const first = calls.map((c) => engine.decide(c))
    for (let i = 0; i < 3; i++) expect(calls.map((c) => engine.decide(c))).toEqual(first)
    expect(engine.rules().allow).toEqual(['Bash(ls *)'])
    expect(engine.mode).toBe('default')
  })

  test('mounts are read at decision time', () => {
    let list = mounts()
    const config = {
      root,
      mode: 'default',
      rules: { allow: [], ask: [], deny: [] },
      settingsFiles: { local: join(tmp, 'x.json') },
    } as unknown as CoderConfig
    const engine = createPermissionEngine({ config, mounts: () => list })
    const c = fileCall(TOOL.write, '/@dirs/new/a.ts')
    expect(status(engine.decide(c, 'acceptEdits'))).toBe('approved')
    list = [...list, { virtual: '/@dirs/new/', real: join(tmp, 'new'), readonly: true }]
    expect(status(engine.decide(c, 'acceptEdits'))).toBe('denied')
  })
})

describe('suggestRule', () => {
  const engine = make('default')
  test('bash: first two words as a prefix rule, one word exact', () => {
    expect(engine.suggestRule(bash('bun test src/a.test.ts'))).toBe('Bash(bun test *)')
    expect(engine.suggestRule(bash('npm run build'))).toBe('Bash(npm run *)')
    expect(engine.suggestRule(bash('make'))).toBe('Bash(make)')
    expect(engine.suggestRule(bash('timeout 30 bun test'))).toBe('Bash(bun test *)')
  })

  test('bash: none for complex commands', () => {
    expect(engine.suggestRule(bash('echo $(date)'))).toBeUndefined()
    expect(engine.suggestRule(bash('cat <<EOF\nx\nEOF'))).toBeUndefined()
    expect(engine.suggestRule({ toolName: TOOL.bash, input: {} })).toBeUndefined()
  })

  test('edits suggest Edit, other tools their name', () => {
    expect(engine.suggestRule(fileCall(TOOL.write, '/a.ts'))).toBe('Edit')
    expect(engine.suggestRule(fileCall(TOOL.delete, '/a.ts'))).toBe('Edit')
    expect(engine.suggestRule(call('mcp__srv__tool'))).toBe('mcp__srv__tool')
    expect(engine.suggestRule(call(TOOL.agent, { subagent_type: 'x' }))).toBe('agent')
  })

  test('none for exit_plan_mode, directory access and protected paths', () => {
    expect(engine.suggestRule(call(TOOL.exitPlan, { plan: 'x' }))).toBeUndefined()
    expect(engine.suggestRule(call(TOOL.dirAccess, { path: '/x' }))).toBeUndefined()
    expect(engine.suggestRule(fileCall(TOOL.write, '/.git/config'))).toBeUndefined()
    expect(engine.suggestRule(bash('echo x > .coder/settings.json'))).toBeUndefined()
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

  test('duplicates and invalid rules are ignored', async () => {
    const engine = make('default')
    await engine.allow('Edit', 'session')
    await engine.allow('Edit', 'session')
    await engine.allow('  ', 'session')
    await engine.allow('Bash (x', 'session')
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
