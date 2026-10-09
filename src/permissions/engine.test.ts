/** The permission engine: mode x tool matrix, rules, containment, protected paths, persistence. */
import { describe, expect, test } from 'bun:test'
import {
  createPermissionEngine,
  DONT_ASK_REASON,
  type PermissionEngineOptions,
  PLAN_MODE_REASON,
} from './engine.ts'
import { join } from './paths.ts'
import { isReadOnlyCommand } from './readonly.ts'
import {
  type AutoAction,
  type AutoClassifier,
  type AutoEvent,
  modeCycleFor,
  PERMISSION_MODES,
  type PermissionCall,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRoot,
  type PermissionRules,
} from './types.ts'

type ToolCallInfo = PermissionCall
const TOOL = {
  read: 'read_file',
  list: 'list_files',
  grep: 'grep',
  glob: 'glob',
  edit: 'edit_file',
  write: 'write_file',
  delete: 'delete_file',
  bash: 'bash',
  todo: 'todo_write',
  agent: 'agent',
  exitPlan: 'exit_plan_mode',
  ask: 'ask_user_question',
} as const

const tmp = '/work'
const root = join(tmp, 'proj')
const extra = join(tmp, 'shared-lib')
const outputs = join(tmp, 'tool-outputs')

const mounts = (): PermissionRoot[] => [
  { virtual: '/', real: root },
  { virtual: '/@dirs/shared-lib/', real: extra },
  { virtual: '/@dirs/ro/', real: join(tmp, 'ro'), readonly: true },
  { virtual: '/.coder/tool-outputs/', real: outputs, readonly: true, workingDir: false },
]

const PROTECTED = ['.git', '.coder/settings*.json', '.coder/agents']

function make(
  mode: PermissionMode = 'default',
  rules: Partial<PermissionRules> = {},
  extraOptions: Partial<PermissionEngineOptions> = {},
) {
  return createPermissionEngine({
    roots: mounts,
    home: '/home/u',
    mode,
    rules,
    protectedPaths: PROTECTED,
    ...(mode === 'auto' ? { classifier: () => ({ decision: 'allow' as const }) } : {}),
    ...extraOptions,
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
    fileCall(TOOL.read, '/.coder/tool-outputs/o.txt'),
    call(TOOL.todo, { todos: [] }),
    call('bash_output', { id: 'x' }),
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
    expect(status(make().decide(fileCall(TOOL.write, '/.coder/tool-outputs/x')))).toBe('denied')
  })

  test('paths outside every mount or invalid are denied', () => {
    const engine = make('default')
    // without the root mount nothing but the extra directories is reachable
    const only = createPermissionEngine({
      roots: () => [{ virtual: '/@dirs/lib/', real: extra }],
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
      'sort src/a.ts',
      'grep -n x src/a.ts',
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
    // an allow rule never approves a write outside the working directories
    expect(status(engine.decide(bash('echo hi > /etc/x')))).toBe('user-approval')
    expect(status(engine.decide(bash('echo hi > out.txt')))).toBe('approved')
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

  test('invalid rules throw EH_CONFIG_INVALID (an inert deny rule would be a hole)', () => {
    expect(() => make('default', { deny: ['', 'Bash (x)'] })).toThrow('invalid permission rule')
    expect(() => make('default', { allow: ['((('] })).toThrow('invalid permission rule')
    expect(() =>
      createPermissionEngine({ roots: mounts, rules: { deny: ['Read(~/.ssh/**)'] } }),
    ).toThrow('home')
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

describe('ask_user_question', () => {
  const ask = call(TOOL.ask, { questions: [] })
  for (const mode of PERMISSION_MODES) {
    test(`approved in ${mode}, even with a catch-all ask rule`, () => {
      expect(status(make(mode).decide(ask))).toBe('approved')
      expect(status(make(mode, { ask: [TOOL.ask] }).decide(ask))).toBe('approved')
    })
  }
  test('stays active in plan mode and in every other mode', () => {
    for (const mode of PERMISSION_MODES) {
      expect(make(mode).inactiveTools()).not.toContain(TOOL.ask)
    }
    expect(make('default').inactiveTools('plan')).not.toContain(TOOL.ask)
  })
  test('no rule suggestion', () => {
    expect(make().suggestRule(ask)).toBeUndefined()
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
    expect(inactive).toEqual(expect.arrayContaining([TOOL.edit, TOOL.write, TOOL.delete]))
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

  test('roots are read at decision time', () => {
    let list = mounts()
    const engine = createPermissionEngine({ roots: () => list })
    const c = fileCall(TOOL.write, '/@dirs/new/a.ts')
    list = [...list, { virtual: '/@dirs/new/', real: join(tmp, 'new') }]
    expect(status(engine.decide(c, 'acceptEdits'))).toBe('approved')
    list = [
      { virtual: '/', real: root },
      { virtual: '/@dirs/new/', real: join(tmp, 'new'), readonly: true },
    ]
    expect(status(engine.decide(c, 'acceptEdits'))).toBe('denied')
  })
})

describe('suggestRule', () => {
  const engine = make('default')
  test('bash: first two words as a prefix rule, one word exact', () => {
    expect(engine.suggestRule(bash('cargo test src/a.test.ts'))).toBe('Bash(cargo test *)')
    expect(engine.suggestRule(bash('bun test src/a.test.ts'))).toBe('Bash(bun test src/a.test.ts)')
    expect(engine.suggestRule(bash('npm run build'))).toBe('Bash(npm run *)')
    expect(engine.suggestRule(bash('make'))).toBe('Bash(make)')
    expect(engine.suggestRule(bash('timeout 30 cargo test'))).toBe('Bash(cargo test *)')
  })

  test('finding 5: interpreters, wrappers and flags get the exact command, never a wildcard', () => {
    for (const c of [
      'bash -c "echo hi"',
      'sh -c ls',
      'python3 -c print',
      'python script.py',
      'node -e 1',
      'bun x foo',
      'git -c core.pager=x log',
      'git -C /tmp log',
      'git config alias.x y',
      'env FOO=1 make',
      'sudo rm file',
      'xargs rm',
      'ssh host ls',
      'find . -name x',
      'rm -rf build',
      'ls -la',
    ]) {
      const rule = engine.suggestRule(bash(c))
      expect([c, rule === undefined || !rule.includes('*')]).toEqual([c, true])
    }
    expect(engine.suggestRule(bash('bash -c ls'))).toBe('Bash(bash -c ls)')
    expect(engine.suggestRule(bash('ls -la'))).toBe('Bash(ls -la)')
    expect(engine.suggestRule(bash('git push origin main'))).toBe('Bash(git push *)')
    // compound commands and commands with a wildcard get no rule
    expect(engine.suggestRule(bash('bun test && rm x'))).toBeUndefined()
    expect(engine.suggestRule(bash('ls *.ts'))).toBeUndefined()
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

  test('none for exit_plan_mode and protected paths', () => {
    expect(engine.suggestRule(call(TOOL.exitPlan, { plan: 'x' }))).toBeUndefined()
    expect(engine.suggestRule(fileCall(TOOL.write, '/.git/config'))).toBeUndefined()
    expect(engine.suggestRule(bash('echo x > .coder/settings.json'))).toBeUndefined()
  })
})

describe('allow() and persist', () => {
  test('allow changes decide and calls persist with a copy', async () => {
    const saved: PermissionRules[] = []
    const engine = make('default', {}, { persist: (rules) => void saved.push(rules) })
    const c = bash('bun test a')
    expect(status(engine.decide(c))).toBe('user-approval')
    await engine.allow('Bash(bun test *)')
    expect(engine.decide(c)).toEqual({ status: 'approved', rule: 'Bash(bun test *)' })
    expect(engine.rules().allow).toEqual(['Bash(bun test *)'])
    expect(saved).toEqual([{ allow: ['Bash(bun test *)'], ask: [], deny: [] }])
    saved[0]?.allow.push('x')
    expect(engine.rules().allow).toEqual(['Bash(bun test *)'])
  })

  test('without persist nothing is stored and duplicates are not added', async () => {
    const engine = make('default')
    await engine.allow('Edit')
    await engine.allow('Edit')
    expect(engine.rules().allow).toEqual(['Edit'])
  })

  test('an invalid rule throws and changes nothing', () => {
    const engine = make('default')
    expect(() => engine.allow('Bash (x')).toThrow('invalid permission rule')
    expect(() => engine.allow('  ')).toThrow('invalid permission rule')
    expect(engine.rules().allow).toEqual([])
  })

  test('a failing persist rejects, the rule stays in memory', async () => {
    const engine = make('default', {}, { persist: () => Promise.reject(new Error('disk full')) })
    await expect(engine.allow('Edit')).rejects.toThrow('disk full')
    expect(engine.rules().allow).toEqual(['Edit'])
  })
})

describe('persist change and scope', () => {
  test('persist receives the change; session rules are not stored', async () => {
    const calls: { rules: PermissionRules; change: unknown }[] = []
    const engine = make(
      'default',
      {},
      { persist: (rules, change) => void calls.push({ rules, change }) },
    )
    await engine.allow('Edit', 'session')
    expect(calls).toEqual([])
    expect(engine.rules().allow).toEqual(['Edit'])
    await engine.allow('Bash(bun test *)')
    expect(calls).toEqual([
      {
        rules: { allow: ['Bash(bun test *)'], ask: [], deny: [] },
        change: { op: 'add', kind: 'allow', rule: 'Bash(bun test *)', scope: 'project' },
      },
    ])
    expect(await engine.removeRule('allow', 'Edit')).toBe(true)
    expect(calls).toHaveLength(1)
    expect(await engine.removeRule('allow', 'Bash(bun test *)')).toBe(true)
    expect(calls[1]?.change).toEqual({
      op: 'remove',
      kind: 'allow',
      rule: 'Bash(bun test *)',
      scope: 'project',
    })
  })

  test('adding a session rule at project scope promotes it', async () => {
    const calls: PermissionRules[] = []
    const engine = make('default', {}, { persist: (rules) => void calls.push(rules) })
    await engine.allow('Edit', 'session')
    await engine.allow('Edit')
    expect(calls).toEqual([{ allow: ['Edit'], ask: [], deny: [] }])
  })
})

describe('alwaysAsk tools', () => {
  const kinds = { pay: { kind: 'other' as const, alwaysAsk: true } }
  const pay: PermissionCall = { toolName: 'pay', input: {} }
  test('asks in every mode, despite allow rules; dontAsk denies; deny wins', () => {
    for (const mode of ['default', 'acceptEdits', 'bypassPermissions'] as const) {
      const engine = make(mode, { allow: ['pay'] }, { toolKinds: kinds })
      expect(status(engine.decide(pay))).toBe('user-approval')
    }
    const dont = make('dontAsk', { allow: ['pay'] }, { toolKinds: kinds })
    expect(dont.decide(pay)).toEqual({ status: 'denied', reason: DONT_ASK_REASON })
    const deny = make('bypassPermissions', { deny: ['pay'] }, { toolKinds: kinds })
    expect(status(deny.decide(pay))).toBe('denied')
    expect(make('default', {}, { toolKinds: kinds }).suggestRule(pay)).toBeUndefined()
  })
})

describe('finding 1: read-only commands are argument grammars (allow-lists)', () => {
  const writers = [
    'uniq a.txt victim.txt',
    'sort -oREADME.md a',
    'sort -o README.md a',
    'sort --ou=README.md a',
    'sort --output=README.md a',
    'sort --output README.md a',
    'sort --compress-program=sh a',
    'sort -T /tmp a',
    'tree -ofoo',
    'tree',
    'find . -fprint0 x',
    'find . -fprint x',
    'find . -fls x',
    'find . -fprintf x %p',
    'find . -exec rm {} ;',
    'find . -execdir rm {} ;',
    'find . -ok rm {} ;',
    'find . -okdir rm {} ;',
    'find . -delete',
    'find . -files0-from list',
    'rg --pre sh x',
    'rg --pre=sh x',
    'rg --pre-glob=x y',
    'rg --hostname-bin=sh x',
    'rg -z x',
    'rg -f patterns x',
    'grep -f patterns x',
    'grep --exclude-from=x y',
    'git blame --contents /etc/passwd src/a.ts',
    'git diff --output=x',
    'git log --output=x',
    'git diff --ext-diff',
    'git show --textconv HEAD',
    'git -c core.pager=sh log',
    'git -C /tmp log',
    'tail -f log',
    'tail --follow log',
    'file -C',
    'wc --files0-from=x',
    'cat --unknown',
  ]
  for (const c of writers) {
    test(`not read-only, plan mode denies: ${c}`, () => {
      expect(isReadOnlyCommand(c)).toBe(false)
      expect(make('plan').decide(bash(c))).toMatchObject({
        status: 'denied',
        reason: PLAN_MODE_REASON,
      })
    })
  }

  test('legitimate read-only uses are still accepted', () => {
    for (const c of [
      'uniq a.txt',
      'uniq -c a.txt',
      'sort -n -k2 -t, a b',
      'sort -r a',
      'find . -name "*.ts" -type f -print',
      'find src -maxdepth 2 \\( -name a -o -name b \\) -print0',
      'rg -n -i --glob *.ts foo src',
      'rg --files',
      'grep -rn -e foo -A 3 src',
      'head -n 5 a',
      'head -5 a',
      'tail -n +3 a',
      'cut -d, -f1 a',
      'git log --oneline -5 -- src',
      'git diff --stat --cached',
      'git blame -L 1,5 src/a.ts',
      'git status --porcelain',
      'git ls-files -o --exclude-standard',
      'wc -l a',
    ]) {
      expect([c, isReadOnlyCommand(c)]).toEqual([c, true])
    }
  })
})

describe('finding 2: Read rules cover directories, globs and mounts', () => {
  const rules = { deny: ['Read(secrets/**)'] }

  test('shell reads of a directory or glob that a rule could match ask', () => {
    const engine = make('default', rules)
    for (const c of [
      'grep -r KEY .',
      'grep -rn KEY',
      'rg KEY',
      'rg KEY .',
      'cat .e*',
      'cat .en?',
      'cat .e[n]v',
      'cat sec*/a',
      'cat < .e*',
      `grep -r KEY ${extra}`,
    ]) {
      const d = engine.decide(bash(c))
      expect([c, d.status]).toEqual([c, 'user-approval'])
      expect(d).toMatchObject({ reason: expect.stringContaining('may read files matched by') })
    }
    // dontAsk turns the ask into a denial
    expect(status(make('dontAsk', rules).decide(bash('cat .e*')))).toBe('denied')
  })

  test('a deny rule that could match still asks in bypassPermissions', () => {
    const d = make('bypassPermissions', rules).decide(bash('grep -r KEY .'))
    expect(d).toMatchObject({ status: 'user-approval', rule: 'Read(secrets/**)' })
    // the built-in .env ask is ignored in bypass
    expect(status(make('bypassPermissions').decide(bash('grep -r KEY .')))).toBe('approved')
  })

  test('harmless globs and files are not covered', () => {
    const engine = make('default', rules)
    for (const c of [
      'cat src/*.ts',
      'cat a.txt b.txt',
      'grep KEY src/a.ts',
      'ls -R',
      'wc -l *.md',
    ]) {
      expect([c, status(engine.decide(bash(c)))]).toEqual([c, 'approved'])
    }
  })

  test('an exact match still denies', () => {
    expect(status(make('default', rules).decide(bash('cat secrets/*')))).toBe('denied')
    expect(
      status(make('default', { deny: ['Read(secrets/a)'] }).decide(bash('cat secrets/a'))),
    ).toBe('denied')
  })

  test('the built-in .env ask applies in every mount', () => {
    const engine = make('default')
    for (const path of [
      '/@dirs/shared-lib/.env',
      '/@dirs/shared-lib/sub/.env.local',
      '/sub/.env',
    ]) {
      expect([path, status(engine.decide(fileCall(TOOL.read, path)))]).toEqual([
        path,
        'user-approval',
      ])
    }
    expect(status(engine.decide(bash(`cat ${extra}/.env`)))).toBe('user-approval')
    expect(status(engine.decide(fileCall(TOOL.read, '/@dirs/shared-lib/a.ts')))).toBe('approved')
  })

  test('a root-relative rule applies to the root, a bare rule also inside mounts', () => {
    const engine = make('default', { deny: ['Read(./private/**)', 'Read(*.pem)'] })
    expect(status(engine.decide(fileCall(TOOL.read, '/private/a')))).toBe('denied')
    expect(status(engine.decide(fileCall(TOOL.read, '/@dirs/shared-lib/private/a')))).toBe(
      'approved',
    )
    expect(status(engine.decide(fileCall(TOOL.read, '/@dirs/shared-lib/k.pem')))).toBe('denied')
  })

  test('file tools on a directory are approved (the plugin filters the output)', () => {
    const engine = make('default', rules)
    expect(status(engine.decide(call(TOOL.grep, { pattern: 'x' })))).toBe('approved')
    expect(status(engine.decide(fileCall(TOOL.list, '/')))).toBe('approved')
    expect(status(engine.decide(call(TOOL.glob, { pattern: '**' })))).toBe('approved')
  })

  test('readBlocked: deny, ask and built-in rules; an allow rule lifts the built-in ask', () => {
    const engine = make('default', { deny: ['Read(secrets/**)'], ask: ['Read(*.key)'] })
    for (const path of [
      '/secrets/a',
      '/x/y.key',
      '/.env',
      '/sub/.env.local',
      '/@dirs/shared-lib/.env',
    ]) {
      expect([path, engine.readBlocked(path)]).toEqual([path, true])
    }
    for (const path of ['/src/a.ts', '/@dirs/shared-lib/a.ts', '/nowhere/../src/a']) {
      expect([path, engine.readBlocked(path)]).toEqual([path, false])
    }
    expect(make('default', { allow: ['Read(.env.example)'] }).readBlocked('/.env.example')).toBe(
      false,
    )
  })
})

describe('finding 4: expansions in any argument of a read-only command', () => {
  test('echo, printf-like and path-less commands with $ or backticks are not auto-approved', () => {
    for (const c of [
      'echo $SECRET',
      'echo $' + '{HOME}',
      'echo "$X"',
      'echo $1',
      'echo `id`',
      'basename $P',
      'which $X',
    ]) {
      const d = make('default').decide(bash(c))
      expect([c, d.status]).toEqual([c, 'user-approval'])
    }
    expect(status(make('default').decide(bash('printf "$X"')))).toBe('user-approval')
    expect(status(make('default').decide(bash('echo hi')))).toBe('approved')
    // a regex anchor is not an expansion
    expect(status(make('default').decide(bash("grep -E 'a$|b' src/a.ts")))).toBe('approved')
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

describe('finding 7: mode override', () => {
  test('decide(call, plan) keeps bash read-only whatever the global mode', () => {
    for (const global of ['bypassPermissions', 'acceptEdits', 'default'] as const) {
      const engine = make(global)
      expect(engine.decide(bash('rm -rf x'), 'plan')).toEqual({
        status: 'denied',
        reason: PLAN_MODE_REASON,
      })
      expect(status(engine.decide(bash('ls'), 'plan'))).toBe('approved')
      expect(status(engine.decide(fileCall(TOOL.write, '/a'), 'plan'))).toBe('denied')
    }
  })

  test('the global dontAsk still converts asks to denials, protected paths still ask', () => {
    const dont = make('dontAsk')
    expect(status(dont.decide(fileCall(TOOL.write, '/x'), 'default'))).toBe('denied')
    expect(status(dont.decide(fileCall(TOOL.read, '/.env'), 'default'))).toBe('denied')
    expect(
      make('bypassPermissions').decide(fileCall(TOOL.write, '/.git/config'), 'plan'),
    ).toMatchObject({
      status: 'denied',
    })
    expect(
      make('bypassPermissions').decide(fileCall(TOOL.write, '/.git/config'), 'acceptEdits'),
    ).toMatchObject({
      status: 'user-approval',
    })
  })
})

describe('finding 8: plan mode remembers the previous mode', () => {
  test('setMode(plan) and cycleMode record the mode to restore', () => {
    const engine = make('bypassPermissions')
    expect(engine.modeBeforePlan()).toBe('default')
    engine.setMode('plan')
    expect(engine.modeBeforePlan()).toBe('bypassPermissions')
    engine.setMode('default')
    engine.cycleMode() // acceptEdits
    engine.cycleMode() // plan
    expect(engine.mode).toBe('plan')
    expect(engine.modeBeforePlan()).toBe('acceptEdits')
    // starting in plan: nothing to restore but default
    expect(make('plan').modeBeforePlan()).toBe('default')
  })
})

describe('finding 9: addRule / removeRule', () => {
  test('addRule: any kind, validated', async () => {
    const engine = make('default')
    await engine.addRule('deny', 'Bash(rm *)')
    await engine.addRule('ask', 'Read(x)')
    expect(engine.rules()).toEqual({ allow: [], ask: ['Read(x)'], deny: ['Bash(rm *)'] })
    expect(() => engine.addRule('deny', 'not a rule(')).toThrow('invalid permission rule')
    expect(status(engine.decide(bash('rm x')))).toBe('denied')
  })

  test('removeRule returns whether it existed and persists', async () => {
    const saved: PermissionRules[] = []
    const engine = make(
      'default',
      { deny: ['Edit(x)', 'Edit(y)'] },
      { persist: (r) => void saved.push(r) },
    )
    expect(await engine.removeRule('deny', 'Edit(x)')).toBe(true)
    expect(engine.rules().deny).toEqual(['Edit(y)'])
    expect(saved).toEqual([{ allow: [], ask: [], deny: ['Edit(y)'] }])
    expect(await engine.removeRule('deny', 'Edit(x)')).toBe(false)
    expect(saved).toHaveLength(1)
  })
})

describe('options', () => {
  test('readOnlyCommands: a subset, or none', () => {
    const some = make('default', {}, { readOnlyCommands: ['ls', 'git'] })
    expect(status(some.decide(bash('ls -la')))).toBe('approved')
    expect(status(some.decide(bash('git status')))).toBe('approved')
    expect(status(some.decide(bash('cat a')))).toBe('user-approval')
    expect(make('plan', {}, { readOnlyCommands: ['ls'] }).decide(bash('cat a'))).toMatchObject({
      status: 'denied',
    })
    const none = make('default', {}, { readOnlyCommands: [] })
    expect(status(none.decide(bash('ls')))).toBe('user-approval')
    expect(status(none.decide(fileCall(TOOL.read, '/a')))).toBe('approved')
  })

  test('protectedPaths: default .git only, custom list, none', () => {
    const d = createPermissionEngine({ roots: mounts, mode: 'bypassPermissions' })
    expect(status(d.decide(fileCall(TOOL.write, '/.git/config')))).toBe('user-approval')
    expect(status(d.decide(fileCall(TOOL.write, '/.coder/settings.json')))).toBe('approved')
    const custom = createPermissionEngine({
      roots: mounts,
      mode: 'bypassPermissions',
      protectedPaths: ['.app/**', 'deploy.yml'],
    })
    expect(status(custom.decide(fileCall(TOOL.write, '/.app/a')))).toBe('user-approval')
    expect(status(custom.decide(bash('cp x deploy.yml')))).toBe('user-approval')
    expect(status(custom.decide(fileCall(TOOL.write, '/.git/config')))).toBe('approved')
    const none = createPermissionEngine({
      roots: mounts,
      mode: 'bypassPermissions',
      protectedPaths: [],
    })
    expect(status(none.decide(bash('rm -rf .git')))).toBe('approved')
  })

  test('builtinAsk can be replaced', () => {
    const engine = createPermissionEngine({ roots: mounts, builtinAsk: ['Read(**/*.pem)'] })
    expect(status(engine.decide(fileCall(TOOL.read, '/.env')))).toBe('approved')
    expect(status(engine.decide(fileCall(TOOL.read, '/k.pem')))).toBe('user-approval')
  })

  test('modeCycle', () => {
    const engine = make('default', {}, { modeCycle: ['default', 'dontAsk'] })
    expect(engine.cycleMode()).toBe('dontAsk')
    expect(engine.cycleMode()).toBe('default')
  })

  test('fetch and search tools ask, are allowed in plan mode, and take domain rules', () => {
    const fetch = (url: string): ToolCallInfo => call('web_fetch', { url })
    const engine = make('default', { allow: ['WebFetch(domain:docs.example.com)'] })
    expect(status(engine.decide(fetch('https://docs.example.com/x')))).toBe('approved')
    expect(status(engine.decide(fetch('https://evil.com/x')))).toBe('user-approval')
    expect(status(make('plan').decide(fetch('https://evil.com/x')))).toBe('user-approval')
    expect(status(make('plan').decide(call('web_search', { query: 'x' })))).toBe('user-approval')
    expect(status(make('dontAsk').decide(call('web_search', { query: 'x' })))).toBe('denied')
    expect(status(make('bypassPermissions').decide(fetch('https://a.b')))).toBe('approved')
    expect(engine.suggestRule(fetch('https://a.example.com/x'))).toBe(
      'WebFetch(domain:a.example.com)',
    )
    expect(engine.suggestRule(call('web_search', {}))).toBe('WebSearch')
    expect(
      make('default', { deny: ['WebFetch(domain:*.evil.com)'] }).decide(fetch('http://x.evil.com')),
    ).toMatchObject({ status: 'denied' })
  })

  test('custom shell tool name and command field', () => {
    const engine = createPermissionEngine({
      roots: mounts,
      toolKinds: { run: { kind: 'shell', commandField: 'cmd' } },
      rules: { allow: ['Bash(make *)'], deny: ['Bash(rm *)'] },
    })
    expect(status(engine.decide(call('run', { cmd: 'make all' })))).toBe('approved')
    expect(status(engine.decide(call('run', { cmd: 'rm x' })))).toBe('denied')
    expect(status(engine.decide(call('run', { cmd: 'ls' })))).toBe('approved')
    expect(status(engine.decide(call('run', { command: 'ls' })))).toBe('user-approval')
  })

  test('custom aliases', () => {
    const engine = createPermissionEngine({
      roots: mounts,
      toolKinds: { scratch: { kind: 'other' } },
      aliases: { Tools: ['scratch', 'kind:fetch'] },
      rules: { allow: ['Tools'] },
    })
    expect(status(engine.decide(call('scratch')))).toBe('approved')
    expect(status(engine.decide(call('web_fetch', { url: 'https://x.y' })))).toBe('approved')
    expect(engine.expandRuleTool('Tools')).toEqual(['scratch', 'web_fetch'])
  })

  test('a safe tool is approved in every mode; kindOf and toolsOfKind', () => {
    for (const mode of PERMISSION_MODES) {
      expect(make(mode).decide(call('todo_write', { todos: [] }))).toEqual({ status: 'approved' })
    }
    const engine = make()
    expect(engine.kindOf('bash')).toBe('shell')
    expect(engine.kindOf('whatever')).toBe('other')
    expect(engine.toolsOfKind('plan-exit')).toEqual(['exit_plan_mode'])
  })

  test('~/ in a rule needs a home', () => {
    const engine = make('default', { deny: ['Read(~/.ssh/**)'] })
    expect(status(engine.decide(bash('cat ~/.ssh/id_rsa')))).toBe('denied')
    expect(status(createPermissionEngine({ roots: mounts }).decide(bash('cat ~/x')))).toBe(
      'user-approval',
    )
  })

  test('tokenizer holes of the example are closed', () => {
    const engine = make('default', { deny: ['Bash(rm *)'] })
    // a comment must not hide the next line
    expect(status(engine.decide(bash('echo a # x\nrm -rf b')))).toBe('denied')
    // ANSI-C quoting cannot smuggle a path past the containment check
    expect(status(engine.decide(bash("cat $'\\x2fetc/passwd'")))).toBe('user-approval')
    expect(status(engine.decide(bash('cat $"/etc/passwd"')))).toBe('user-approval')
  })
})

describe('auto mode', () => {
  const blocking: AutoClassifier = () => ({ decision: 'block', reason: 'looks like exfiltration' })
  const allowing: AutoClassifier = () => ({ decision: 'allow' })

  test('is unavailable without a classifier', () => {
    expect(() => createPermissionEngine({ roots: mounts, mode: 'auto' })).toThrow(/classifier/)
    const engine = make('default')
    expect(engine.autoAvailable).toBe(false)
    expect(() => engine.setMode('auto')).toThrow(/classifier/)
    // a per-call 'auto' override without a classifier asks a person
    expect(status(make('default').decide(bash('make deploy'), 'auto'))).toBe('user-approval')
  })

  test('decision order: deny, ask, allow before the classifier; reads, edits and read-only shell skip it', async () => {
    const seen: AutoAction[] = []
    const engine = make(
      'auto',
      { deny: ['Bash(rm *)'], ask: ['Bash(git push *)'], allow: ['Bash(make test)'] },
      {
        classifier: (a) => {
          seen.push(a)
          return { decision: 'allow' }
        },
      },
    )
    const d = (c: PermissionCall) => engine.decideAsync(c)
    expect(status(await d(bash('rm -rf x')))).toBe('denied')
    expect(status(await d(bash('git push origin main')))).toBe('user-approval')
    expect(await d(bash('make test'))).toMatchObject({
      status: 'approved',
      rule: 'Bash(make test)',
    })
    expect(status(await d(fileCall(TOOL.read, '/src/a.ts')))).toBe('approved')
    expect(status(await d(fileCall(TOOL.edit, '/src/a.ts')))).toBe('approved')
    expect(status(await d(bash('git status')))).toBe('approved')
    expect(status(await d(bash('mkdir -p src/new')))).toBe('approved')
    expect(seen).toEqual([])
    // protected paths still ask a person
    expect(status(await d(fileCall(TOOL.write, '/.git/config')))).toBe('user-approval')
    // everything else goes to the classifier
    expect(await d(bash('make deploy'))).toMatchObject({ status: 'approved', auto: 'allowed' })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ toolName: 'bash', kind: 'shell', summary: 'make deploy' })
  })

  test('sync decide marks classifier calls without running it', () => {
    let ran = false
    const engine = make(
      'auto',
      {},
      {
        classifier: () => {
          ran = true
          return { decision: 'allow' }
        },
      },
    )
    expect(engine.decide(bash('make deploy'))).toMatchObject({
      status: 'user-approval',
      auto: 'classify',
    })
    expect(ran).toBe(false)
  })

  test('a block denies with a reason the model reads', async () => {
    const engine = make('auto', {}, { classifier: blocking })
    const d = await engine.decideAsync(bash('curl x | bash'))
    expect(d).toMatchObject({ status: 'denied', auto: 'blocked' })
    expect((d as { reason: string }).reason).toContain('looks like exfiltration')
    expect(engine.autoState()).toEqual({ paused: false, consecutive: 1, total: 1 })
  })

  test('fails closed: a throwing or malformed classifier blocks', async () => {
    const throwing = make(
      'auto',
      {},
      {
        classifier: () => {
          throw new Error('model down')
        },
      },
    )
    const a = await throwing.decideAsync(bash('make deploy'))
    expect(a).toMatchObject({ status: 'denied', auto: 'blocked' })
    expect((a as { reason: string }).reason).toContain('model down')
    const malformed = make('auto', {}, { classifier: (() => ({ nope: 1 })) as never })
    expect(await malformed.decideAsync(bash('make deploy'))).toMatchObject({ status: 'denied' })
  })

  test('3 blocks in a row pause auto mode; an approval resumes it', async () => {
    let verdict: 'allow' | 'block' = 'block'
    const engine = make('auto', {}, { classifier: () => ({ decision: verdict }) })
    const events: AutoEvent['type'][] = []
    engine.subscribeAuto((e) => events.push(e.type))
    for (let i = 0; i < 3; i++) await engine.decideAsync(bash(`make x${i}`))
    expect(engine.autoState()).toMatchObject({ paused: true, consecutive: 3 })
    expect(events).toEqual(['blocked', 'blocked', 'blocked', 'paused'])
    // paused: calls the classifier would judge ask a person; the classifier is not called
    verdict = 'allow'
    expect(await engine.decideAsync(bash('make y'))).toMatchObject({
      status: 'user-approval',
      auto: 'paused',
    })
    // rules and read-only checks still work while paused
    expect(status(await engine.decideAsync(fileCall(TOOL.read, '/a.ts')))).toBe('approved')
    engine.noteApproval()
    expect(engine.autoState()).toEqual({ paused: false, consecutive: 0, total: 3 })
    expect(events.at(-1)).toBe('resumed')
    expect(await engine.decideAsync(bash('make z'))).toMatchObject({ status: 'approved' })
  })

  test('an allowed action resets the consecutive counter', async () => {
    let verdict: 'allow' | 'block' = 'block'
    const engine = make('auto', {}, { classifier: () => ({ decision: verdict }) })
    await engine.decideAsync(bash('make a'))
    await engine.decideAsync(bash('make b'))
    verdict = 'allow'
    await engine.decideAsync(bash('make c'))
    verdict = 'block'
    await engine.decideAsync(bash('make d'))
    expect(engine.autoState()).toEqual({ paused: false, consecutive: 1, total: 3 })
  })

  test('20 blocks in total pause auto mode and reset the total', async () => {
    let n = 0
    const engine = make(
      'auto',
      {},
      {
        // every third verdict is an allow, so the blocks never come 3 in a row
        classifier: () => (++n % 3 === 0 ? { decision: 'allow' } : { decision: 'block' }),
      },
    )
    let i = 0
    while (!engine.autoState().paused && i < 100) await engine.decideAsync(bash(`make t${i++}`))
    expect(engine.autoState()).toMatchObject({ paused: true, total: 0 })
    expect(i).toBeGreaterThan(20)
  })

  test('re-validation of the same tool call id asks the classifier once and counts once', async () => {
    let calls = 0
    const engine = make(
      'auto',
      {},
      {
        classifier: () => {
          calls++
          return { decision: 'block', reason: 'no' }
        },
      },
    )
    const a = await engine.decideAsync(bash('make a'), { toolCallId: 'c1' })
    const b = await engine.decideAsync(bash('make a'), { toolCallId: 'c1' })
    expect(a).toEqual(b)
    expect(calls).toBe(1)
    expect(engine.autoState().total).toBe(1)
  })

  test('the classifier gets the transcript and abort signal', async () => {
    let got: unknown
    const engine = make(
      'auto',
      {},
      {
        classifier: (_a, ctx) => {
          got = ctx
          return { decision: 'allow' }
        },
      },
    )
    const abortSignal = new AbortController().signal
    await engine.decideAsync(bash('make a'), {
      transcript: () => [{ role: 'user', text: 'do not push' }],
      abortSignal,
    })
    expect(got).toEqual({ transcript: [{ role: 'user', text: 'do not push' }], abortSignal })
  })

  test('broad allow rules are ignored in auto mode, narrow ones stay', async () => {
    const engine = make(
      'auto',
      { allow: ['Bash(*)', 'Bash(python*)', 'Bash(bash *)', 'Bash(bun test *)'] },
      { classifier: blocking },
    )
    expect(status(await engine.decideAsync(bash('rm -rf data')))).toBe('denied')
    expect(status(await engine.decideAsync(bash('python3 evil.py')))).toBe('denied')
    expect(status(await engine.decideAsync(bash('bash -c "x"')))).toBe('denied')
    expect(await engine.decideAsync(bash('bun test src'))).toMatchObject({ status: 'approved' })
    // outside auto mode the same rules apply
    expect(status(make('default', { allow: ['Bash(*)'] }).decide(bash('rm -rf data')))).toBe(
      'approved',
    )
  })

  test('dontAsk still denies instead of classifying; a mode switch drops a stale verdict', async () => {
    const engine = make('auto', {}, { classifier: allowing })
    expect(status(await engine.decideAsync(bash('make a'), { mode: 'dontAsk' }))).toBe('denied')
    let release: (v: { decision: 'allow' }) => void = () => {}
    const slow = make(
      'auto',
      {},
      {
        classifier: () => new Promise((resolve) => (release = resolve)),
      },
    )
    const pending = slow.decideAsync(bash('make a'))
    slow.setMode('default')
    release({ decision: 'allow' })
    expect(await pending).toMatchObject({ status: 'user-approval' })
  })

  test('entering auto mode again resumes a paused auto mode', async () => {
    const engine = make('auto', {}, { classifier: blocking })
    for (let i = 0; i < 3; i++) await engine.decideAsync(bash(`make x${i}`))
    expect(engine.autoState().paused).toBe(true)
    engine.setMode('default')
    engine.setMode('auto')
    expect(engine.autoState().paused).toBe(false)
  })

  test('mode cycle: optional modes slot in after plan, bypass first, auto last', () => {
    expect(modeCycleFor({})).toEqual(['default', 'acceptEdits', 'plan'])
    expect(modeCycleFor({ bypass: true, auto: true })).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'bypassPermissions',
      'auto',
    ])
    const engine = make(
      'plan',
      {},
      {
        modeCycle: modeCycleFor({ bypass: true, auto: true }),
        classifier: allowing,
      },
    )
    expect([engine.cycleMode(), engine.cycleMode(), engine.cycleMode()]).toEqual([
      'bypassPermissions',
      'auto',
      'default',
    ])
    // from dontAsk, or from auto when it is not in the cycle: default
    expect(make('auto', {}, { classifier: allowing }).cycleMode()).toBe('default')
    expect(make('dontAsk').cycleMode()).toBe('default')
    // auto without a classifier is dropped from the cycle
    const noAuto = make('plan', {}, { modeCycle: modeCycleFor({ auto: true }) })
    expect([noAuto.cycleMode(), noAuto.cycleMode()]).toEqual(['default', 'acceptEdits'])
  })
})
