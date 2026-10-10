import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { definePlugin, defineToolSource } from '../index.ts'
import { createPermissionEngine } from '../permissions/index.ts'
import { activateConnectors, compileConnectorRules, mergeConnectorRules } from './activate.ts'
import { type BuiltinMemoryRoot, builtinConnectors, ensureBuiltinConnections } from './builtin.ts'
import { defineConnector } from './definition.ts'
import { mostRestrictive, resolveModes } from './enablement.ts'
import { memoryConnectionStore } from './store.ts'
import type { ConnectionRecord, ConnectorDefinition, McpSourceSpec } from './types.ts'

const conn = (
  id: string,
  definitionId: string,
  extra: Partial<ConnectionRecord> = {},
): ConnectionRecord => ({
  id,
  kind: 'connection',
  definitionId,
  label: id,
  settings: {},
  enabled: true,
  updatedAt: 0,
  scope: 'workspace',
  status: 'connected',
  defaultEnabled: true,
  createdAt: 0,
  ...extra,
})

const plugin = (name: string) => definePlugin({ name, setup: () => ({}) })

const github: ConnectorDefinition = defineConnector({
  id: 'github',
  version: '1',
  name: 'GitHub',
  description: 'd',
  category: 'dev',
  source: 'curated',
  scopes: ['workspace', 'agent'],
  auth: { type: 'none' },
  instructions: 'GITHUB INSTRUCTIONS',
  capabilities: [
    {
      id: 'read',
      title: 'Read',
      description: '',
      kind: 'read',
      tools: ['get_issue', 'search'],
      defaultMode: 'allow',
    },
    {
      id: 'write',
      title: 'Write',
      description: '',
      kind: 'write',
      tools: ['create_issue'],
      defaultMode: 'ask',
    },
    {
      id: 'danger',
      title: 'Danger',
      description: '',
      kind: 'destructive',
      tools: ['delete_repo'],
      defaultMode: 'off',
    },
  ],
  activate: (ctx) => ({ kind: 'mcp', name: ctx.slug, url: 'https://x.example.com/mcp' }),
})

const mcpFactory = (specs: McpSourceSpec[]) => (spec: McpSourceSpec) => {
  specs.push(spec)
  return defineToolSource({ id: `mcp:${spec.name}`, list: () => ({}) })
}

describe('modes and precedence', () => {
  const caps = github.capabilities
  test('agent tool override, agent capability, connection default, capability default', () => {
    const r = resolveModes(
      caps,
      { defaultModes: { read: 'ask', danger: 'ask' } },
      { capabilities: { read: 'off' }, tools: { create_issue: 'allow' } },
    )
    expect(r.modes).toEqual({ read: 'off', write: 'ask', danger: 'ask' })
    expect(r.toolModes).toMatchObject({
      get_issue: 'off',
      create_issue: 'allow',
      delete_repo: 'ask',
    })
    expect(r.tools.sort()).toEqual(['create_issue', 'delete_repo'])
  })
  test('mostRestrictive orders off over ask over allow', () => {
    expect(mostRestrictive('allow', 'ask')).toBe('ask')
    expect(mostRestrictive('ask', 'off', 'allow')).toBe('off')
    expect(mostRestrictive()).toBe('allow')
  })
})

describe('rules', () => {
  test('compile: off denies, ask asks and pins non-builtin writes, allow allows non-builtins', () => {
    const rules = compileConnectorRules([
      { name: 'a', mode: 'allow', kind: 'read', source: 'curated' },
      { name: 'b', mode: 'ask', kind: 'write', source: 'curated' },
      { name: 'c', mode: 'ask', kind: 'read', source: 'curated' },
      { name: 'd', mode: 'off', kind: 'destructive', source: 'custom' },
      { name: 'e', mode: 'ask', kind: 'destructive', source: 'builtin' },
      { name: 'f', mode: 'allow', kind: 'read', source: 'builtin' },
    ])
    expect(rules).toEqual({
      allow: ['a'],
      ask: ['b', 'c', 'e'],
      deny: ['d'],
      pinnedAsk: ['b'],
      toolKinds: { b: { kind: 'other', alwaysAsk: true } },
    })
  })

  test('merge is most-restrictive-wins', () => {
    const merged = mergeConnectorRules(
      { allow: ['x', 'y', 'z'], ask: ['q'], deny: [], pinnedAsk: ['q'], toolKinds: {} },
      { allow: ['q', 'w'], ask: ['x'], deny: ['y'] },
    )
    expect(merged.allow.sort()).toEqual(['w', 'z'])
    expect(merged.ask.sort()).toEqual(['q', 'x'])
    expect(merged.deny).toEqual(['y'])
  })

  test('pinned asks hold under bypassPermissions in the permission engine; other tools follow the mode', async () => {
    const specs: McpSourceSpec[] = []
    const out = await activateConnectors({
      definitions: [github],
      connections: [conn('gh', 'github')],
      agent: { id: 'a1' },
      mcp: mcpFactory(specs),
    })
    expect(out.rules).toMatchObject({
      allow: ['get_issue', 'search'],
      ask: ['create_issue'],
      deny: ['delete_repo'],
      pinnedAsk: ['create_issue'],
    })
    const engine = createPermissionEngine({
      roots: () => [{ virtual: '/', real: '/work' }],
      mode: 'bypassPermissions',
      rules: { allow: out.rules.allow, ask: out.rules.ask, deny: out.rules.deny },
      toolKinds: out.rules.toolKinds,
    })
    expect(engine.decide({ toolName: 'create_issue', input: {} }).status).toBe('user-approval')
    expect(engine.decide({ toolName: 'get_issue', input: {} }).status).toBe('approved')
    expect(engine.decide({ toolName: 'delete_repo', input: {} }).status).toBe('denied')
    // without the pin, bypass would approve an ask-rule tool... and an unrelated tool is approved
    expect(engine.decide({ toolName: 'unrelated', input: {} }).status).toBe('approved')
    const plain = createPermissionEngine({
      roots: () => [{ virtual: '/', real: '/work' }],
      mode: 'default',
      rules: out.rules,
    })
    expect(plain.decide({ toolName: 'create_issue', input: {} }).status).toBe('user-approval')
  })

  test('an app deny rule beats a connector allow; an app ask beats it too', async () => {
    const out = await activateConnectors({
      definitions: [github],
      connections: [conn('gh', 'github')],
      agent: { id: 'a1' },
      appRules: { deny: ['get_issue'], ask: ['search'] },
      mcp: mcpFactory([]),
    })
    expect(out.rules.allow).toEqual([])
    expect(out.rules.deny).toContain('get_issue')
    expect(out.rules.ask).toContain('search')
  })
})

describe('activation', () => {
  test('enablement: workspace inherit/on/off, agent scope, disabled and unavailable connections', async () => {
    const connections = [
      conn('w-default-on', 'github', { defaultEnabled: true }),
      conn('w-default-off', 'github', { defaultEnabled: false }),
      conn('w-forced-on', 'github', { defaultEnabled: false }),
      conn('w-forced-off', 'github', { defaultEnabled: true }),
      conn('mine', 'github', { scope: 'agent', scopeId: 'a1', defaultEnabled: false }),
      conn('theirs', 'github', { scope: 'agent', scopeId: 'a2' }),
      conn('disabled', 'github', { enabled: false }),
      conn('needs', 'github', { status: 'needs-auth' }),
    ]
    const out = await activateConnectors({
      definitions: [github],
      connections,
      agent: { id: 'a1' },
      mcp: mcpFactory([]),
      enablement: { 'w-forced-on': { enabled: 'on' }, 'w-forced-off': { enabled: 'off' } },
    })
    expect(out.connections.map((c) => c.connectionId).sort()).toEqual([
      'mine',
      'w-default-on',
      'w-forced-on',
    ])
    expect(out.warnings.map((w) => [w.code, w.connectionId])).toEqual([
      ['connection-unavailable', 'needs'],
    ])
  })

  test('two connections of one connector get slug prefixes, rules use the final names, the map points back', async () => {
    const specs: McpSourceSpec[] = []
    const out = await activateConnectors({
      definitions: [github],
      connections: [
        conn('b', 'github', { label: 'Work GitHub' }),
        conn('a', 'github', { label: 'Personal' }),
      ],
      agent: { id: 'a1' },
      mcp: mcpFactory(specs),
    })
    expect(out.connections.map((c) => [c.connectionId, c.toolPrefix])).toEqual([
      ['a', 'personal_'],
      ['b', 'work-github_'],
    ])
    expect(specs.map((s) => s.prefix)).toEqual(['personal_', 'work-github_'])
    expect(specs[0]?.allow).toEqual(['get_issue', 'search', 'create_issue']) // delete_repo is off
    expect(specs[0]?.deny).toEqual(['delete_repo'])
    expect(out.toolNameMap.personal_get_issue).toEqual({
      connectorId: 'github',
      connectionIds: ['a'],
      capabilityId: 'read',
      tool: 'get_issue',
    })
    expect(out.rules.ask).toEqual(['personal_create_issue', 'work-github_create_issue'])
    expect(out.rules.pinnedAsk).toEqual(['personal_create_issue', 'work-github_create_issue'])
    expect(out.instructions).toEqual(['GITHUB INSTRUCTIONS'])
  })

  test('a stored slug is the prefix, whatever the label says now', async () => {
    const out = await activateConnectors({
      definitions: [github],
      connections: [
        conn('a', 'github', { label: 'Renamed', slug: 'docs' }),
        conn('b', 'github', { label: 'Other', slug: 'Not Valid!' }),
      ],
      agent: { id: 'a1' },
      mcp: mcpFactory([]),
    })
    expect(out.connections.map((c) => [c.connectionId, c.toolPrefix])).toEqual([
      ['a', 'docs_'],
      ['b', 'other_'],
    ])
  })

  test('a single connection has no prefix', async () => {
    const out = await activateConnectors({
      definitions: [github],
      connections: [conn('a', 'github')],
      agent: { id: 'a1' },
      mcp: mcpFactory([]),
    })
    expect(Object.keys(out.toolNameMap)).toContain('get_issue')
  })

  test("toolPrefix 'always' prefixes a single connection, 'never' never prefixes", async () => {
    for (const [policy, many, expected] of [
      ['always', false, ['a1_get_issue']],
      ['never', true, ['get_issue']],
    ] as const) {
      const specs: McpSourceSpec[] = []
      const out = await activateConnectors({
        definitions: [{ ...github, toolPrefix: policy }],
        connections: many
          ? [conn('a', 'github', { label: 'One' }), conn('b', 'github', { label: 'Two' })]
          : [conn('a', 'github', { label: 'A1' })],
        agent: { id: 'a1' },
        mcp: mcpFactory(specs),
      })
      expect(Object.keys(out.toolNameMap).filter((n) => n.endsWith('get_issue'))[0]).toBe(
        expected[0],
      )
      expect(out.rules.allow.includes(expected[0] as string)).toBe(true)
      expect(specs[0]?.prefix).toBe(policy === 'always' ? 'a1_' : '')
    }
  })

  test('order is stable: builtins in a fixed order, then connectors by id, connections by id; independent of input order', async () => {
    const names = ['zeta', 'alpha']
    const custom = names.map((id) =>
      defineConnector({
        id,
        version: '1',
        name: id,
        description: 'd',
        category: 'x',
        source: 'curated',
        scopes: ['workspace'],
        auth: { type: 'none' },
        instructions: `I-${id}`,
        capabilities: [],
        activate: () => plugin(`p-${id}`),
      }),
    )
    const built = builtinConnectors({
      ask: { plugin: () => plugin('ask-p') },
      files: { plugin: () => plugin('files-p') },
      planning: { plugin: () => plugin('plan-p') },
    })
    const defs = [...custom, ...built]
    const conns = ['zeta', 'alpha', 'ask', 'files', 'planning'].map((d) => conn(`c-${d}`, d))
    const run = (list: ConnectionRecord[]) =>
      activateConnectors({ definitions: defs, connections: list, agent: { id: 'a1' } })
    const one = await run(conns)
    const two = await run([...conns].reverse())
    const order = ['files-p', 'plan-p', 'ask-p', 'p-alpha', 'p-zeta']
    expect(one.plugins.map((p) => p.name)).toEqual(order)
    expect(two.plugins.map((p) => p.name)).toEqual(order)
    expect(two.instructions).toEqual(['I-alpha', 'I-zeta'])
  })

  test('a failing activate is a warning, not an exception; mcp without a factory warns', async () => {
    const broken = defineConnector({
      id: 'broken',
      version: '1',
      name: 'B',
      description: 'd',
      category: 'x',
      source: 'custom',
      scopes: ['workspace'],
      auth: { type: 'none' },
      capabilities: [],
      activate: () => {
        throw new Error('boom')
      },
    })
    const out = await activateConnectors({
      definitions: [broken, github],
      connections: [conn('a', 'broken'), conn('b', 'github')],
      agent: { id: 'a1' },
    })
    expect(out.warnings.map((w) => w.code).sort()).toEqual([
      'activate-failed',
      'mcp-factory-missing',
    ])
  })

  test('settings are validated; secrets reach activate but never the result JSON', async () => {
    let seen = ''
    const def = defineConnector({
      id: 'sec',
      version: '1',
      name: 'S',
      description: 'd',
      category: 'x',
      source: 'custom',
      scopes: ['workspace'],
      auth: { type: 'apiKey', fields: z.object({ key: z.string() }) },
      capabilities: [],
      activate: (ctx) => {
        seen = (ctx.settings as { key: string }).key
        return undefined
      },
    })
    const out = await activateConnectors({
      definitions: [def],
      connections: [
        conn('ok', 'sec', { settings: { key: 'TOPSECRET' } }),
        conn('bad', 'sec', { settings: {} }),
      ],
      agent: { id: 'a1' },
    })
    expect(seen).toBe('TOPSECRET')
    expect(out.warnings.map((w) => w.code)).toEqual(['invalid-settings'])
    expect(JSON.stringify(out)).not.toContain('TOPSECRET')
  })

  test('all capabilities off: no activation, deny rules remain', async () => {
    let activated = false
    const def = defineConnector({
      ...github,
      activate: () => {
        activated = true
        return undefined
      },
    })
    const out = await activateConnectors({
      definitions: [def],
      connections: [
        conn('a', 'github', { defaultModes: { read: 'off', write: 'off', danger: 'off' } }),
      ],
      agent: { id: 'a1' },
    })
    expect(activated).toBe(false)
    expect(out.rules.deny.sort()).toEqual(['create_issue', 'delete_repo', 'get_issue', 'search'])
    expect(out.instructions).toEqual([])
  })

  test('getAccessToken goes through the provider', async () => {
    let token = ''
    const def = defineConnector({
      id: 'tok',
      version: '1',
      name: 'T',
      description: 'd',
      category: 'x',
      source: 'custom',
      scopes: ['workspace'],
      auth: { type: 'none' },
      capabilities: [],
      activate: async (ctx) => {
        token = await ctx.connection.getAccessToken()
        return undefined
      },
    })
    await activateConnectors({
      definitions: [def],
      connections: [conn('a', 'tok')],
      agent: { id: 'a1' },
      accessToken: async (id) => `token-for-${id}`,
    })
    expect(token).toBe('token-for-a')
  })
})

describe('built-in connectors', () => {
  test('files map capabilities to the file tools; edit and delete can be turned off per agent', async () => {
    let received: string[] = []
    const defs = builtinConnectors({
      files: {
        plugin: (input) => {
          received = input.tools
          return plugin('files-p')
        },
      },
    })
    const store = memoryConnectionStore()
    await ensureBuiltinConnections({ store, definitions: defs })
    expect((await store.list()).map((c) => c.id)).toEqual(['builtin:files'])
    await ensureBuiltinConnections({ store, definitions: defs }) // idempotent
    expect((await store.list()).length).toBe(1)
    const out = await activateConnectors({
      definitions: defs,
      connections: await store.list(),
      agent: { id: 'a1' },
      enablement: { 'builtin:files': { capabilities: { edit: 'off', delete: 'off' } } },
    })
    expect(received).toEqual(['read_file', 'list_files', 'grep', 'glob'])
    expect(out.rules.deny.sort()).toEqual(['delete_file', 'edit_file', 'write_file'])
    expect(out.rules.allow).toEqual([]) // builtin allow adds no rule
    expect(out.rules.pinnedAsk).toEqual([]) // builtin asks are never pinned
  })

  test('labels rename a built-in connector and its capabilities', () => {
    const [files] = builtinConnectors({
      files: { plugin: () => plugin('f') },
      labels: { files: { name: 'Berkas', capabilities: { read: { title: 'Baca berkas' } } } },
    })
    expect(files?.name).toBe('Berkas')
    expect(files?.capabilities[0]?.title).toBe('Baca berkas')
    expect(files?.source).toBe('builtin')
  })

  test('memory: workspace and agent scopes become two roots; write follows the capability mode', async () => {
    let roots: BuiltinMemoryRoot[] = []
    const defs = builtinConnectors({
      memory: {
        paths: { workspace: '/memory/shared', agent: (id) => `/memory/agents/${id}` },
        plugin: (r) => {
          roots = r
          return plugin('memory-p')
        },
      },
      labels: { memory: { scopeLabels: { workspace: 'Team memory' } } },
    })
    const store = memoryConnectionStore()
    await ensureBuiltinConnections({ store, definitions: defs, agentId: 'a1' })
    await ensureBuiltinConnections({ store, definitions: defs, agentId: 'a2' })
    const all = await store.list()
    expect(all.map((c) => [c.id, c.label, c.scope]).sort()).toEqual([
      ['builtin:memory', 'Team memory', 'workspace'],
      ['builtin:memory:agent:a1', "This agent's memory", 'agent'],
      ['builtin:memory:agent:a2', "This agent's memory", 'agent'],
    ])
    const out = await activateConnectors({
      definitions: defs,
      connections: all,
      agent: { id: 'a1' },
      enablement: { 'builtin:memory': { capabilities: { write: 'off' } } },
    })
    expect(out.plugins.map((p) => p.name)).toEqual(['memory-p'])
    expect(roots.map((r) => [r.path, r.write, r.label]).sort()).toEqual([
      ['/memory/agents/a1', true, "This agent's memory"],
      ['/memory/shared', false, 'Team memory'],
    ])
    // another agent never sees a1's private memory
    const other = await activateConnectors({
      definitions: defs,
      connections: all,
      agent: { id: 'a2' },
    })
    expect(other.connections.map((c) => c.connectionId).sort()).toEqual([
      'builtin:memory',
      'builtin:memory:agent:a2',
    ])
    // shared tools: write is on for the agent root, so no deny for them
    expect(out.rules.deny).toEqual([])
  })

  test('web offers only the capabilities whose factory exists; team is off by default', async () => {
    const defs = builtinConnectors({
      web: { search: () => plugin('ws') },
      team: { plugin: () => plugin('team-p') },
    })
    expect(defs.find((d) => d.id === 'web')?.capabilities.map((c) => c.id)).toEqual(['search'])
    const store = memoryConnectionStore()
    await ensureBuiltinConnections({ store, definitions: defs })
    const out = await activateConnectors({
      definitions: defs,
      connections: await store.list(),
      agent: { id: 'a1' },
    })
    expect(out.plugins.map((p) => p.name)).toEqual(['ws'])
    const on = await activateConnectors({
      definitions: defs,
      connections: await store.list(),
      agent: { id: 'a1' },
      enablement: { 'builtin:team': { enabled: 'on' } },
    })
    expect(on.plugins.map((p) => p.name)).toEqual(['ws', 'team-p'])
  })
})
