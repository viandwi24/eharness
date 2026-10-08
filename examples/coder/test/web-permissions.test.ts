/** Permission rules, modes, descriptions and agent availability of web_fetch and web_search. */
import { describe, expect, test } from 'bun:test'
import { memoryFs } from 'eharness/filesystem/memory'
import { BUILTIN_AGENTS } from '../src/agents/builtin.ts'
import {
  type CoderConfig,
  PERMISSION_MODES,
  type PermissionMode,
  type PermissionRules,
  TOOL,
  type ToolCallInfo,
} from '../src/contracts.ts'
import { describeApproval } from '../src/permissions/describe.ts'
import { createPermissionEngine, DONT_ASK_REASON } from '../src/permissions/engine.ts'
import { domainSpecifierMatches } from '../src/permissions/rules.ts'

const root = '/tmp/web-perm-root'
function make(mode: PermissionMode = 'default', rules: Partial<PermissionRules> = {}) {
  return createPermissionEngine({
    config: {
      root,
      mode,
      rules: { allow: [], ask: [], deny: [], ...rules },
      settingsFiles: {},
    } as unknown as CoderConfig,
    mounts: () => [{ virtual: '/', real: root, readonly: false }],
  })
}
const fetchCall = (url: string): ToolCallInfo => ({ toolName: TOOL.webFetch, input: { url } })
const searchCall = (query: string): ToolCallInfo => ({ toolName: TOOL.webSearch, input: { query } })

describe('web tool permissions', () => {
  test('both ask by default, in acceptEdits and in plan mode; bypass approves; dontAsk denies', () => {
    for (const mode of ['default', 'acceptEdits', 'plan'] as const) {
      expect(make(mode).decide(fetchCall('https://a.com/x')).status).toBe('user-approval')
      expect(make(mode).decide(searchCall('q')).status).toBe('user-approval')
    }
    expect(make('bypassPermissions').decide(fetchCall('https://a.com')).status).toBe('approved')
    expect(make('bypassPermissions').decide(searchCall('q')).status).toBe('approved')
    const denied = make('dontAsk').decide(searchCall('q'))
    expect(denied).toMatchObject({ status: 'denied', reason: DONT_ASK_REASON })
    expect(make('dontAsk').decide(fetchCall('https://a.com')).status).toBe('denied')
  })

  test('allow rules: WebFetch(domain:host), wildcard subdomains, bare WebFetch/WebSearch, real names', () => {
    const e = make('dontAsk', {
      allow: ['WebFetch(domain:example.com)', 'WebFetch(domain:*.docs.dev)', 'WebSearch'],
    })
    expect(e.decide(fetchCall('https://example.com/a?b=1'))).toEqual({
      status: 'approved',
      rule: 'WebFetch(domain:example.com)',
    })
    expect(e.decide(fetchCall('http://EXAMPLE.com:8080/')).status).toBe('approved')
    expect(e.decide(fetchCall('https://api.docs.dev/x')).status).toBe('approved')
    expect(e.decide(fetchCall('https://docs.dev/x')).status).toBe('denied')
    expect(e.decide(fetchCall('https://evil-example.com/')).status).toBe('denied')
    expect(e.decide(fetchCall('https://example.com.evil.io/')).status).toBe('denied')
    expect(e.decide(searchCall('q')).status).toBe('approved')
    expect(make('default', { allow: ['WebFetch'] }).decide(fetchCall('https://x.io')).status).toBe(
      'approved',
    )
    expect(make('default', { allow: ['web_search'] }).decide(searchCall('q')).status).toBe(
      'approved',
    )
  })

  test('deny and ask rules; plan mode still asks', () => {
    expect(
      make('bypassPermissions', { deny: ['WebFetch(domain:bad.com)'] }).decide(
        fetchCall('https://bad.com/'),
      ).status,
    ).toBe('denied')
    expect(
      make('default', { allow: ['WebFetch'], ask: ['WebFetch(domain:x.com)'] }).decide(
        fetchCall('https://x.com/'),
      ).status,
    ).toBe('user-approval')
    expect(make('plan', { deny: ['WebSearch'] }).decide(searchCall('q')).status).toBe('denied')
  })

  test('a malformed url never matches a domain rule', () => {
    const e = make('dontAsk', { allow: ['WebFetch(domain:example.com)'] })
    expect(e.decide({ toolName: TOOL.webFetch, input: { url: 42 } }).status).toBe('denied')
    expect(domainSpecifierMatches('path:/x', 'example.com')).toBe(false)
    expect(domainSpecifierMatches('domain:*.example.com', 'example.com')).toBe(false)
  })

  test('suggestRule', () => {
    const e = make()
    expect(e.suggestRule(fetchCall('https://docs.example.com/a/b'))).toBe(
      'WebFetch(domain:docs.example.com)',
    )
    expect(e.suggestRule({ toolName: TOOL.webFetch, input: {} })).toBeUndefined()
    expect(e.suggestRule(searchCall('q'))).toBe('WebSearch')
  })

  test('inactiveTools keeps both web tools in plan mode', () => {
    const inactive = make('plan').inactiveTools()
    expect(inactive).not.toContain(TOOL.webFetch)
    expect(inactive).not.toContain(TOOL.webSearch)
    expect(make().inactiveTools('plan')).not.toContain(TOOL.webSearch)
    expect(make('default', { deny: ['WebSearch'] }).inactiveTools()).toContain(TOOL.webSearch)
    for (const mode of PERMISSION_MODES) {
      expect(make(mode, { deny: ['WebFetch'] }).inactiveTools()).toContain(TOOL.webFetch)
    }
  })

  test('describeApproval', async () => {
    const fs = memoryFs({})
    const e = make()
    const f = await describeApproval(
      { toolName: TOOL.webFetch, input: { url: 'https://docs.example.com/a', prompt: 'the API' } },
      fs,
      e,
    )
    expect(f.title).toBe('Fetch https://docs.example.com/a')
    expect(f.detail).toBe('the API')
    expect(f.suggestedRule).toBe('WebFetch(domain:docs.example.com)')
    const s = await describeApproval(
      {
        toolName: TOOL.webSearch,
        input: {
          query: 'bun  test\nrunner',
          allowed_domains: ['bun.sh'],
          blocked_domains: ['x.com'],
        },
      },
      fs,
      e,
    )
    expect(s.title).toBe('Web search: bun test runner')
    expect(s.detail).toBe('Only: bun.sh\nNot: x.com')
    expect(s.suggestedRule).toBe('WebSearch')
  })

  test('explore, plan and general-purpose agents can use both tools', () => {
    for (const def of BUILTIN_AGENTS) {
      if (def.tools === undefined) continue
      expect(def.tools).toContain(TOOL.webFetch)
      expect(def.tools).toContain(TOOL.webSearch)
      expect(def.disallowedTools ?? []).not.toContain(TOOL.webFetch)
    }
    expect(BUILTIN_AGENTS.find((d) => d.name === 'general-purpose')?.tools).toBeUndefined()
  })
})
