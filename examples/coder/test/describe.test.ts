/** `describeApproval`: titles, details and diffs shown in the approval prompt. */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryFs } from 'eharness/filesystem/memory'
import {
  type CoderConfig,
  type PermissionEngine,
  TOOL,
  type ToolCallInfo,
} from '../src/contracts.ts'
import { describeApproval } from '../src/permissions/describe.ts'
import { createPermissionEngine } from '../src/permissions/engine.ts'

const root = '/tmp/describe-root'
const engine: PermissionEngine = createPermissionEngine({
  config: {
    root,
    mode: 'default',
    rules: { allow: [], ask: [], deny: [] },
    settingsFiles: {},
  } as unknown as CoderConfig,
  mounts: () => [{ virtual: '/', real: root, readonly: false }],
})
const call = (toolName: string, input: unknown): ToolCallInfo => ({ toolName, input })
const fs = memoryFs({ '/a.ts': 'one\ntwo\nthree\n', '/dup.txt': 'x\nx\n' })

describe('describeApproval', () => {
  test('bash: title from the command, detail is the command, suggested rule', async () => {
    const d = await describeApproval(
      call(TOOL.bash, { command: 'bun test src/a.test.ts' }),
      fs,
      engine,
    )
    expect(d).toEqual({
      title: 'Bash: bun test src/a.test.ts',
      detail: 'bun test src/a.test.ts',
      suggestedRule: 'Bash(bun test *)',
    })
  })

  test('bash: the command is the title, the description only goes into the detail; long commands are shortened', async () => {
    const d = await describeApproval(
      call(TOOL.bash, { command: 'rm -rf dist', description: 'Clean the build' }),
      fs,
      engine,
    )
    expect(d.title).toBe('Bash: rm -rf dist')
    expect(d.detail?.startsWith('rm -rf dist\n\n')).toBe(true)
    expect(d.detail).toContain('Clean the build')
    const long = await describeApproval(
      call(TOOL.bash, { command: `echo ${'x'.repeat(300)}\nsecond line` }),
      fs,
      engine,
    )
    expect(long.title.length).toBeLessThanOrEqual('Bash: '.length + 100)
    expect(long.title).not.toContain('\n')
    expect(long.title.endsWith('…')).toBe(true)
    expect(long.detail).toContain('second line')
  })

  test('bash: no suggested rule for a complex command', async () => {
    const d = await describeApproval(call(TOOL.bash, { command: 'echo $(date)' }), fs, engine)
    expect(d).not.toHaveProperty('suggestedRule')
  })

  test('edit: a real unified patch against the current content', async () => {
    const d = await describeApproval(
      call(TOOL.edit, { path: '/a.ts', old_string: 'two', new_string: 'TWO' }),
      fs,
      engine,
    )
    expect(d.title).toBe('Edit /a.ts')
    expect(d.suggestedRule).toBe('Edit')
    expect(d.detail).toContain('--- /a.ts\tbefore')
    expect(d.detail).toContain('+++ /a.ts\tafter')
    expect(d.detail).toContain('@@ -1,3 +1,3 @@')
    expect(d.detail).toContain(' one\n-two\n+TWO\n three')
  })

  test('edit: replace_all rewrites every occurrence, otherwise only the first', async () => {
    const one = await describeApproval(
      call(TOOL.edit, { path: '/dup.txt', old_string: 'x', new_string: 'y' }),
      fs,
      engine,
    )
    expect(one.detail).toContain('+y\n x\n-x')
    const all = await describeApproval(
      call(TOOL.edit, { path: '/dup.txt', old_string: 'x', new_string: 'y', replace_all: true }),
      fs,
      engine,
    )
    expect(all.detail).toContain('-x\n-x\n+y\n+y')
  })

  test('edit: a missing old_string or file falls back to old/new', async () => {
    for (const input of [
      { path: '/a.ts', old_string: 'absent', new_string: 'n' },
      { path: '/missing.ts', old_string: 'o', new_string: 'n' },
    ]) {
      const d = await describeApproval(call(TOOL.edit, input), fs, engine)
      expect(d.detail).toBe(`--- old\n${input.old_string}\n+++ new\nn`)
    }
  })

  test('edit: an empty old_string does not claim a diff', async () => {
    const d = await describeApproval(
      call(TOOL.edit, { path: '/a.ts', old_string: '', new_string: 'n' }),
      fs,
      engine,
    )
    expect(d.detail).toBe('--- old\n\n+++ new\nn')
  })

  test('write: a new file lists its size and content', async () => {
    const d = await describeApproval(
      call(TOOL.write, { path: '/new.ts', content: 'hello' }),
      fs,
      engine,
    )
    expect(d.title).toBe('Write /new.ts')
    expect(d.detail).toBe('New file (5 characters)\nhello')
  })

  test('write: an existing file shows a diff', async () => {
    const d = await describeApproval(
      call(TOOL.write, { path: '/a.ts', content: 'one\nTWO\nthree\n' }),
      fs,
      engine,
    )
    expect(d.detail).toContain('-two\n+TWO')
    expect(d.detail).not.toContain('New file')
  })

  test('delete', async () => {
    const d = await describeApproval(call(TOOL.delete, { path: '/a.ts' }), fs, engine)
    expect(d).toEqual({ title: 'Delete /a.ts', suggestedRule: 'Edit' })
  })

  test('agent', async () => {
    const d = await describeApproval(
      call(TOOL.agent, {
        subagent_type: 'explore',
        description: 'Find usages',
        prompt: 'search the repo',
      }),
      fs,
      engine,
    )
    expect(d).toEqual({
      title: 'Agent explore: Find usages',
      detail: 'search the repo',
      suggestedRule: 'agent',
    })
  })

  test('exit_plan_mode shows the plan and offers no rule', async () => {
    const d = await describeApproval(call(TOOL.exitPlan, { plan: '1. do it' }), fs, engine)
    expect(d).toEqual({ title: 'Plan ready: start implementing?', detail: '1. do it' })
  })

  test('request_directory_access', async () => {
    const withReason = await describeApproval(
      call(TOOL.dirAccess, { path: '/x/lib', reason: 'read types' }),
      fs,
      engine,
    )
    expect(withReason).toEqual({ title: 'Access directory /x/lib', detail: '/x/lib\n\nread types' })
    const without = await describeApproval(call(TOOL.dirAccess, { path: '/x/lib' }), fs, engine)
    expect(without.detail).toBe('/x/lib')
  })

  test('other tools show their input as JSON', async () => {
    const d = await describeApproval(call('mcp__srv__tool', { a: 1 }), fs, engine)
    expect(d).toEqual({
      title: 'mcp__srv__tool',
      detail: '{\n  "a": 1\n}',
      suggestedRule: 'mcp__srv__tool',
    })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect((await describeApproval(call('mcp__x__y', circular), fs, engine)).detail).toBe(
      '[object Object]',
    )
    expect((await describeApproval(call('mcp__x__y', undefined), fs, engine)).detail).toBe('')
  })

  test('huge details are truncated', async () => {
    const d = await describeApproval(
      call(TOOL.write, { path: '/big.txt', content: 'y'.repeat(50_000) }),
      fs,
      engine,
    )
    expect((d.detail ?? '').length).toBeLessThan(21_000)
    expect(d.detail).toContain('more characters')
  })

  test('garbage inputs do not throw', async () => {
    for (const toolName of Object.values(TOOL)) {
      for (const input of [null, undefined, 'str', 42, {}]) {
        const d = await describeApproval(call(toolName, input), fs, engine)
        expect(typeof d.title).toBe('string')
      }
    }
  })

  test('a failing file system falls back to the new-file or old/new form', async () => {
    const broken = {
      ...fs,
      read: () => Promise.reject(new Error('boom')),
    } as unknown as typeof fs
    const w = await describeApproval(
      call(TOOL.write, { path: '/a.ts', content: 'c' }),
      broken,
      engine,
    )
    expect(w.detail).toContain('New file')
    const e = await describeApproval(
      call(TOOL.edit, { path: '/a.ts', old_string: 'o', new_string: 'n' }),
      broken,
      engine,
    )
    expect(e.detail).toBe('--- old\no\n+++ new\nn')
  })

  test('finding 10: control characters and ANSI escapes are stripped from title and detail', async () => {
    const d = await describeApproval(
      call(TOOL.bash, {
        command: 'echo \u001b[2J\u001b[31mred\u001b[0m \u001b]0;pwned\u0007x\u0000y\rz\nline2\tok',
        description: 'a\u001b[1mb',
      }),
      fs,
      engine,
    )
    expect(d.title).toBe('Bash: echo red xyz')
    expect(d.detail).toContain('line2\tok')
    const codes = [...`${d.title}${d.detail}`].map((ch) => ch.charCodeAt(0))
    expect(codes.filter((c) => (c < 0x20 && c !== 0x0a && c !== 0x09) || c === 0x7f)).toEqual([])
  })

  test('finding 10: the bash title is the first line of the command, 100 characters at most', async () => {
    const d = await describeApproval(
      call(TOOL.bash, { command: `${'x'.repeat(250)}\nsecond`, description: 'harmless' }),
      fs,
      engine,
    )
    expect(d.title.length).toBe('Bash: '.length + 100)
    expect(d.title).not.toContain('harmless')
  })

  test('finding 10: request_directory_access shows the real path of a symlink', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'coder-describe-')))
    try {
      mkdirSync(join(dir, 'real'))
      symlinkSync(join(dir, 'real'), join(dir, 'link'))
      const viaLink = await describeApproval(
        call(TOOL.dirAccess, { path: join(dir, 'link'), reason: 'need it' }),
        fs,
        engine,
      )
      expect(viaLink.title).toBe(`Access directory ${join(dir, 'real')}`)
      expect(viaLink.detail).toContain(`requested ${join(dir, 'link')}`)
      expect(viaLink.detail).toContain('symlink')
      expect(viaLink.detail).toContain('need it')
      const plain = await describeApproval(
        call(TOOL.dirAccess, { path: join(dir, 'real') }),
        fs,
        engine,
      )
      expect(plain.title).toBe(`Access directory ${join(dir, 'real')}`)
      expect(plain.detail).not.toContain('symlink')
      const missing = await describeApproval(
        call(TOOL.dirAccess, { path: join(dir, 'nope') }),
        fs,
        engine,
      )
      expect(missing.title).toBe(`Access directory ${join(dir, 'nope')}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
