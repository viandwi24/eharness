/** Rule parsing and matching: Bash wildcards, path specifiers, aliases, polarity. */
import { describe, expect, test } from 'bun:test'
import {
  callTarget,
  type MatchContext,
  matchBashSpec,
  matchRule,
  matchWildcard,
  parseRule,
  pathMatchesSpecifier,
  ruleMatchesCall,
  specifierCouldMatch,
  toRealPath,
} from './rules.ts'
import { createToolTable } from './tools.ts'
import type { PermissionCall, PermissionRoot } from './types.ts'

type ToolCallInfo = PermissionCall
const mounts: PermissionRoot[] = [
  { virtual: '/', real: '/proj' },
  { virtual: '/@dirs/lib/', real: '/ext/lib' },
  { virtual: '/.coder/tool-outputs/', real: '/data/out', readonly: true },
]
const tools = createToolTable(undefined, undefined)
const ctx: MatchContext = { root: '/proj', home: '/home/u', roots: mounts, tools }
const toolsForRuleTool = (t: string): readonly string[] => tools.expand(t)
const ruleToolMatches = (t: string, name: string): boolean => tools.covers(t, name)

const bash = (command: string): ToolCallInfo => ({ toolName: 'bash', input: { command } })
const file = (toolName: string, path: string): ToolCallInfo => ({ toolName, input: { path } })

function allows(rule: string, call: ToolCallInfo): boolean {
  const parsed = parseRule(rule)
  if (parsed === undefined) throw new Error(`bad rule ${rule}`)
  return ruleMatchesCall(parsed, call, 'allow', ctx)
}
function restricts(rule: string, call: ToolCallInfo): boolean {
  const parsed = parseRule(rule)
  if (parsed === undefined) throw new Error(`bad rule ${rule}`)
  return ruleMatchesCall(parsed, call, 'restrict', ctx)
}

describe('parseRule', () => {
  test('tool only and tool with specifier', () => {
    expect(parseRule('Edit')).toEqual({ raw: 'Edit', tool: 'Edit' })
    expect(parseRule('Bash(npm run *)')).toEqual({
      raw: 'Bash(npm run *)',
      tool: 'Bash',
      specifier: 'npm run *',
    })
    expect(parseRule('  Read(.env*)  ')?.specifier).toBe('.env*')
    expect(parseRule('mcp__srv__tool')).toEqual({ raw: 'mcp__srv__tool', tool: 'mcp__srv__tool' })
  })

  test('parentheses inside the specifier survive', () => {
    expect(parseRule('Bash(echo $(date))')?.specifier).toBe('echo $(date)')
  })

  test('an empty specifier means the whole tool', () => {
    expect(parseRule('Bash()')?.specifier).toBeUndefined()
  })

  test('garbage is rejected', () => {
    expect(parseRule('')).toBeUndefined()
    expect(parseRule('Bash (x)')).toBeUndefined()
    expect(parseRule('Bash(x')).toBeUndefined()
    expect(parseRule('(x)')).toBeUndefined()
  })
})

describe('aliases', () => {
  test('alias expansion', () => {
    expect(toolsForRuleTool('Read')).toEqual(['read_file', 'list_files', 'grep', 'glob'])
    expect(toolsForRuleTool('Edit')).toEqual(['edit_file', 'write_file', 'delete_file'])
    expect(toolsForRuleTool('Write')).toEqual(['edit_file', 'write_file', 'delete_file'])
    expect(toolsForRuleTool('Bash')).toEqual(['bash'])
    expect(toolsForRuleTool('Agent')).toEqual(['agent'])
    expect(toolsForRuleTool('mcp__a__b')).toEqual(['mcp__a__b'])
  })

  test('real tool names work', () => {
    expect(ruleToolMatches('read_file', 'read_file')).toBe(true)
    expect(ruleToolMatches('read_file', 'list_files')).toBe(false)
    expect(ruleToolMatches('Read', 'glob')).toBe(true)
    expect(ruleToolMatches('Read', 'edit_file')).toBe(false)
    expect(ruleToolMatches('Write', 'delete_file')).toBe(true)
  })

  test('a bare rule covers the whole tool', () => {
    expect(allows('Edit', file('write_file', '/a.ts'))).toBe(true)
    expect(allows('Edit', file('read_file', '/a.ts'))).toBe(false)
    expect(allows('Bash', bash('anything at all'))).toBe(true)
    expect(allows('mcp__srv__tool', { toolName: 'mcp__srv__tool', input: {} })).toBe(true)
    expect(allows('Agent', { toolName: 'agent', input: { subagent_type: 'x' } })).toBe(true)
  })
})

describe('matchWildcard / matchBashSpec', () => {
  test('wildcard', () => {
    expect(matchWildcard('a*c', 'abbbc')).toBe(true)
    expect(matchWildcard('a*c', 'ac')).toBe(true)
    expect(matchWildcard('a*c', 'abd')).toBe(false)
    expect(matchWildcard('a.c', 'abc')).toBe(false)
    expect(matchWildcard('a+b', 'a+b')).toBe(true)
    expect(matchWildcard('a*', 'a\nb')).toBe(true)
  })

  // [specifier, subcommand, expected]
  const table: Array<[string, string, boolean]> = [
    ['npm run build', 'npm run build', true],
    ['npm run build', 'npm run build --prod', false],
    ['npm run build', 'npm run', false],
    ['npm run *', 'npm run build', true],
    ['npm run *', 'npm run', true],
    ['npm run *', 'npm run build --prod', true],
    ['npm run *', 'npm install', false],
    ['npm run *', 'npm runx', false],
    ['ls *', 'ls -la', true],
    ['ls *', 'ls', true],
    ['ls *', 'lsof', false],
    ['ls*', 'lsof', true],
    ['ls*', 'ls -la', true],
    ['ls*', 'ls', true],
    ['git log *', 'git log --oneline', true],
    ['git log *', 'git log', true],
    ['git log *', 'git logx', false],
    ['git log *', 'git status', false],
    ['* --version', 'node --version', true],
    ['* --version', 'npm --version', true],
    ['* --version', 'node --versions', false],
    ['* --version', '--version', false],
    ['npm:*', 'npm', true],
    ['npm run:*', 'npm run build', true],
    ['npm run:*', 'npm run', true],
    ['npm run:*', 'npm install', false],
    ['bun test:*', 'bun test src/a.test.ts', true],
    ['git * main', 'git push origin main', true],
    ['git * main', 'git push origin dev', false],
    ['*', 'anything', true],
  ]
  for (const [spec, sub, expected] of table) {
    test(`Bash(${spec}) vs "${sub}" -> ${expected}`, () => {
      expect(matchBashSpec(spec, sub)).toBe(expected)
    })
  }
})

describe('Bash rules over commands', () => {
  test('exact', () => {
    expect(allows('Bash(npm run build)', bash('npm run build'))).toBe(true)
    expect(allows('Bash(npm run build)', bash('npm run build && npm test'))).toBe(false)
  })

  test('wrappers and safe env are ignored when matching', () => {
    expect(allows('Bash(npm test)', bash('timeout 30 npm test'))).toBe(true)
    expect(allows('Bash(npm test)', bash('NODE_ENV=test npm test'))).toBe(true)
    expect(allows('Bash(npm test)', bash('FOO=1 npm test'))).toBe(false)
  })

  test('allow needs every subcommand to match', () => {
    expect(allows('Bash(npm run *)', bash('npm run a && npm run b'))).toBe(true)
    expect(allows('Bash(npm run *)', bash('npm run a && rm -rf x'))).toBe(false)
    expect(allows('Bash(npm run *)', bash('npm run a | tee out'))).toBe(false)
    expect(allows('Bash(npm run *)', bash('npm run a; npm install'))).toBe(false)
  })

  test('deny and ask match when any subcommand matches', () => {
    expect(restricts('Bash(rm *)', bash('npm run a && rm -rf x'))).toBe(true)
    expect(restricts('Bash(git push *)', bash('git add . ; git push origin main'))).toBe(true)
    expect(restricts('Bash(rm *)', bash('npm run a'))).toBe(false)
  })

  test('deny and ask see inside $(...) and backticks', () => {
    expect(restricts('Bash(rm *)', bash('echo $(rm -rf x)'))).toBe(true)
    expect(restricts('Bash(rm *)', bash('echo `rm -rf x`'))).toBe(true)
    expect(restricts('Bash(rm *)', bash('echo "$(rm -rf x)"'))).toBe(true)
    expect(restricts('Bash(rm *)', bash('(cd a && rm -rf x)'))).toBe(true)
  })

  test('allow never matches a complex command', () => {
    expect(allows('Bash(echo *)', bash('echo $(date)'))).toBe(false)
    expect(allows('Bash(echo *)', bash('echo `date`'))).toBe(false)
    expect(allows('Bash(echo *)', bash('(echo hi)'))).toBe(false)
    expect(allows('Bash(echo *)', bash('echo hi &&'))).toBe(false)
    expect(allows('Bash(cat *)', bash('cat <<EOF\nhi\nEOF'))).toBe(false)
    expect(allows('Bash(*)', bash('echo $(date)'))).toBe(false)
  })

  test('restrict also matches against the raw command', () => {
    expect(restricts('Bash(echo $(date))', bash('echo $(date)'))).toBe(true)
  })

  test('non-string command never matches a specifier rule', () => {
    expect(allows('Bash(ls *)', { toolName: 'bash', input: {} })).toBe(false)
    expect(restricts('Bash(ls *)', { toolName: 'bash', input: null })).toBe(false)
  })
})

describe('Agent rules', () => {
  const agent = (type: string): ToolCallInfo => ({
    toolName: 'agent',
    input: { subagent_type: type },
  })
  test('matches the subagent type', () => {
    expect(allows('Agent(explore)', agent('explore'))).toBe(true)
    expect(allows('Agent(explore)', agent('general'))).toBe(false)
    expect(allows('Agent(ex*)', agent('explore'))).toBe(true)
    expect(restricts('Agent(general)', agent('general'))).toBe(true)
    expect(allows('Agent(explore)', { toolName: 'agent', input: {} })).toBe(false)
  })
})

describe('path specifiers', () => {
  const p = (spec: string, real: string): boolean => pathMatchesSpecifier(spec, real, ctx)

  test('Read(./.env) is the root .env only', () => {
    expect(p('./.env', '/proj/.env')).toBe(true)
    expect(p('./.env', '/proj/sub/.env')).toBe(false)
    expect(p('./.env', '/proj/.env.local')).toBe(false)
  })

  test('Read(.env*) matches at any depth', () => {
    expect(p('.env*', '/proj/.env')).toBe(true)
    expect(p('.env*', '/proj/.env.local')).toBe(true)
    expect(p('.env*', '/proj/a/b/.env.production')).toBe(true)
    expect(p('.env*', '/proj/environment.ts')).toBe(false)
  })

  test('Edit(src/**) is anchored to the root', () => {
    expect(p('src/**', '/proj/src/a.ts')).toBe(true)
    expect(p('src/**', '/proj/src/deep/er/a.ts')).toBe(true)
    expect(p('src/**', '/proj/lib/src/a.ts')).toBe(false)
    expect(p('src/**', '/proj/other/a.ts')).toBe(false)
  })

  test('secrets/** deny at any depth', () => {
    expect(p('secrets/**', '/proj/secrets/key')).toBe(true)
    expect(p('**/secrets/**', '/proj/a/secrets/key')).toBe(true)
  })

  test('a trailing-slash-less directory name matches at any depth', () => {
    expect(p('secrets', '/proj/a/secrets/key')).toBe(true)
  })

  test('/x and ./x are root-relative', () => {
    expect(p('/docs/**', '/proj/docs/a.md')).toBe(true)
    expect(p('/docs/**', '/proj/a/docs/a.md')).toBe(false)
    expect(p('./docs/**', '/proj/docs/a.md')).toBe(true)
  })

  test('//abs is an absolute path', () => {
    expect(p('//etc/hosts', '/etc/hosts')).toBe(true)
    expect(p('//etc/**', '/etc/ssh/config')).toBe(true)
    expect(p('//etc/hosts', '/proj/etc/hosts')).toBe(false)
  })

  test('~/ is the home directory', () => {
    expect(p('~/.ssh/**', '/home/u/.ssh/id_rsa')).toBe(true)
    expect(p('~/.ssh/**', '/proj/.ssh/id_rsa')).toBe(false)
    expect(p('~/notes.md', '/home/u/notes.md')).toBe(true)
  })

  test('paths outside the base never match', () => {
    expect(p('src/**', '/other/src/a.ts')).toBe(false)
    expect(p('**', '/other/a')).toBe(false)
  })

  test('the base itself never matches', () => {
    expect(p('**', '/proj')).toBe(false)
  })
})

describe('virtual paths', () => {
  test('toRealPath maps with the longest prefix', () => {
    expect(toRealPath('/src/a.ts', mounts)?.real).toBe('/proj/src/a.ts')
    expect(toRealPath('/', mounts)?.real).toBe('/proj')
    expect(toRealPath('/@dirs/lib/x/y.ts', mounts)).toMatchObject({ real: '/ext/lib/x/y.ts' })
    expect(toRealPath('/@dirs/lib', mounts)?.real).toBe('/ext/lib')
    expect(toRealPath('/.coder/tool-outputs/a.txt', mounts)?.real).toBe('/data/out/a.txt')
  })

  test('toRealPath normalises and tolerates a missing slash', () => {
    expect(toRealPath('src/a.ts', mounts)?.real).toBe('/proj/src/a.ts')
    expect(toRealPath('/a/../b', mounts)?.real).toBe('/proj/b')
  })

  test('toRealPath is undefined outside every mount', () => {
    expect(toRealPath('/x', [{ virtual: '/@dirs/lib/', real: '/ext/lib' }])).toBeUndefined()
  })

  test('callTarget', () => {
    expect(callTarget(file('read_file', '/a.ts'), ctx)?.real).toBe('/proj/a.ts')
    expect(callTarget({ toolName: 'grep', input: { prefix: '/src' } }, ctx)?.real).toBe('/proj/src')
    expect(callTarget({ toolName: 'grep', input: {} }, ctx)?.real).toBe('/proj')
    expect(callTarget({ toolName: 'read_file', input: {} }, ctx)).toBeUndefined()
    expect(callTarget({ toolName: 'read_file', input: null }, ctx)).toBeUndefined()
    expect(callTarget(file('read_file', '/a'), { ...ctx, roots: [] })).toBeNull()
  })

  test('rules apply to extra directories by their real path', () => {
    // `//ext/lib/**` is the real directory behind /@dirs/lib/
    expect(allows('Edit(//ext/lib/**)', file('write_file', '/@dirs/lib/a.ts'))).toBe(true)
    expect(allows('Edit(//ext/lib/**)', file('write_file', '/a.ts'))).toBe(false)
  })

  test('path rules need the right tool', () => {
    expect(allows('Edit(src/**)', file('write_file', '/src/a.ts'))).toBe(true)
    expect(allows('Edit(src/**)', file('delete_file', '/src/a.ts'))).toBe(true)
    expect(allows('Edit(src/**)', file('read_file', '/src/a.ts'))).toBe(false)
    expect(allows('Read(src/**)', file('read_file', '/src/a.ts'))).toBe(true)
    expect(allows('Read(src/**)', file('write_file', '/src/a.ts'))).toBe(false)
  })

  test('Read rules cover list/grep/glob by path or prefix', () => {
    expect(restricts('Read(secrets/**)', file('list_files', '/secrets/a'))).toBe(true)
    expect(
      restricts('Read(secrets/**)', { toolName: 'grep', input: { prefix: '/secrets/a' } }),
    ).toBe(true)
    expect(restricts('Read(secrets/**)', file('read_file', '/src/a'))).toBe(false)
  })

  test('a path outside every mount or without a path never matches', () => {
    expect(restricts('Read(**)', { toolName: 'read_file', input: {} })).toBe(false)
  })

  test('Read(secrets/**) matches in extra dirs at any depth only with **/', () => {
    expect(restricts('Read(**/secrets/**)', file('read_file', '/@dirs/lib/secrets/k'))).toBe(false)
  })

  test('tool rules for unknown tools with a specifier never match', () => {
    expect(allows('mcp__a__b(x)', { toolName: 'mcp__a__b', input: {} })).toBe(false)
  })
})

describe('mount anchoring (finding 2c)', () => {
  test('a bare pattern applies in the root and in every mount, anchored ones in the root only', () => {
    expect(pathMatchesSpecifier('.env*', '/proj/a/.env', ctx)).toBe(true)
    expect(pathMatchesSpecifier('.env*', '/ext/lib/.env', ctx)).toBe(true)
    expect(pathMatchesSpecifier('.env*', '/ext/lib/sub/.env.local', ctx)).toBe(true)
    expect(pathMatchesSpecifier('.env*', '/elsewhere/.env', ctx)).toBe(false)
    expect(pathMatchesSpecifier('./secret/**', '/proj/secret/a', ctx)).toBe(true)
    expect(pathMatchesSpecifier('./secret/**', '/ext/lib/secret/a', ctx)).toBe(false)
    expect(pathMatchesSpecifier('/secret/**', '/ext/lib/secret/a', ctx)).toBe(false)
    expect(pathMatchesSpecifier('//ext/lib/secret/**', '/ext/lib/secret/a', ctx)).toBe(true)
  })
})

describe('specifierCouldMatch (directory and glob coverage)', () => {
  const could = (spec: string, target: string, subtree = false): boolean =>
    specifierCouldMatch(spec, target, subtree, ctx)

  test('a directory read recursively covers what is below it', () => {
    expect(could('.env*', '/proj', true)).toBe(true)
    expect(could('.env*', '/proj/src', true)).toBe(true)
    expect(could('.env*', '/ext/lib', true)).toBe(true)
    expect(could('secrets/**', '/proj', true)).toBe(true)
    expect(could('secrets/**', '/proj/src', true)).toBe(false)
    expect(could('./a/b/c', '/proj/a', true)).toBe(true)
    expect(could('./a/b/c', '/proj/x', true)).toBe(false)
    expect(could('//etc/x', '/proj', true)).toBe(false)
    expect(could('~/.ssh/**', '/home/u', true)).toBe(true)
    // without recursion a directory itself is not a file read
    expect(could('.env*', '/proj/src')).toBe(false)
  })

  test('globs: wildcards on both sides', () => {
    expect(could('.env*', '/proj/.e*')).toBe(true)
    expect(could('.env*', '/proj/.en?')).toBe(true)
    expect(could('.env*', '/proj/.e[n]v')).toBe(true)
    expect(could('secrets/a', '/proj/sec*/a')).toBe(true)
    expect(could('secrets/**', '/proj/sec*/a')).toBe(true)
    expect(could('*.pem', '/proj/k*')).toBe(true)
    expect(could('.env*', '/proj/src/*.ts')).toBe(false)
    expect(could('*.pem', '/proj/*.ts')).toBe(false)
    expect(could('a/b', '/proj/x*/b')).toBe(false)
  })

  test('a shell glob never matches a leading dot with a leading wildcard', () => {
    expect(could('.env*', '/proj/*')).toBe(false)
    expect(could('.env*', '/proj/*.local')).toBe(false)
    expect(could('.env*', '/proj/.*')).toBe(true)
  })

  test('negations are ignored', () => {
    expect(could('!keep', '/proj', true)).toBe(false)
  })
})

describe('matchRule', () => {
  test('matches one rule without an engine', () => {
    const options = { roots: mounts, home: '/home/u' }
    expect(matchRule('Edit(src/**)', file('write_file', '/src/a.ts'), options)).toBe(true)
    expect(matchRule('Edit(src/**)', file('write_file', '/lib/a.ts'), options)).toBe(false)
    expect(matchRule('Bash(npm *)', bash('npm a && rm x'), { ...options, polarity: 'allow' })).toBe(
      false,
    )
    expect(matchRule('Bash(npm *)', bash('npm a && rm x'), options)).toBe(true)
    expect(matchRule('not a rule(', bash('x'), options)).toBe(false)
  })

  test('custom tool kinds and aliases', () => {
    const options = {
      roots: mounts,
      toolKinds: { fetch_doc: { kind: 'read', pathField: 'file' } as const },
      aliases: { Docs: ['fetch_doc'] },
    }
    const doc = { toolName: 'fetch_doc', input: { file: '/secrets/k' } }
    expect(matchRule('Read(secrets/**)', doc, options)).toBe(true)
    expect(matchRule('Docs', doc, options)).toBe(true)
    expect(matchRule('Docs', file('read_file', '/a'), options)).toBe(false)
  })
})

describe('gitignore semantics', () => {
  const p = (spec: string, real: string): boolean => pathMatchesSpecifier(spec, real, ctx)

  test('character classes, ?, escapes and directory-only patterns', () => {
    expect(p('src/[ab].ts', '/proj/src/a.ts')).toBe(true)
    expect(p('src/[!ab].ts', '/proj/src/a.ts')).toBe(false)
    expect(p('src/?.ts', '/proj/src/c.ts')).toBe(true)
    expect(p('src/?.ts', '/proj/src/cc.ts')).toBe(false)
    expect(p('build/', '/proj/build/out.js')).toBe(true)
    expect(p('build/', '/proj/build')).toBe(false)
    expect(p('a/**/z', '/proj/a/z')).toBe(true)
    expect(p('a/**/z', '/proj/a/b/c/z')).toBe(true)
    expect(p('*.pem', '/proj/deep/k.pem')).toBe(true)
    expect(p('# comment', '/proj/# comment')).toBe(false)
    expect(p('!keep', '/proj/keep')).toBe(false)
  })

  test('* does not cross a slash and does match a leading dot', () => {
    expect(p('src/*', '/proj/src/.hidden')).toBe(true)
    expect(p('src/*.ts', '/proj/src/a/b.ts')).toBe(false)
  })
})
