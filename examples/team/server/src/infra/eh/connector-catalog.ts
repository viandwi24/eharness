/**
 * The connector definitions of the team app: the built-in connectors (the shipped plugins: Files,
 * Memory, Planning, Web, Ask the user, Team), the curated GitHub connector and the generic custom
 * connector (any remote MCP server by URL).
 *
 * Built-in plugin factories are called by `activateConnectors` for one agent at a time (`ctx.agent`).
 * Everything that needs the agent factory (the subagents plugin) is late-bound through `hooks`.
 */
import type { Database } from 'bun:sqlite'
import { ask } from 'eharness/ask'
import {
  type AnyConnectorDefinition,
  type BuiltinInput,
  builtinConnectors,
  type ConnectorActivation,
  capabilitiesFromTools,
  defineConnector,
  type RemoteToolInfo,
  remoteMcpConnector,
} from 'eharness/connectors'
import { type FileToolName, filesystem } from 'eharness/filesystem'
import { listRemoteMcpTools, mcpServerSource } from 'eharness/mcp'
import { memory } from 'eharness/memory'
import { ehMeta } from 'eharness/providers'
import { todos } from 'eharness/todos'
import { webFetch, webSearch } from 'eharness/web'
import { nodeResolveHost } from 'eharness/web/node'
import { z } from 'zod'
import type { AgentDef } from '../../domain/agents.ts'
import { READ_BRIEFINGS_TOOL } from '../../domain/briefings.ts'
import { agentMemory, WORKSPACE_MEMORY } from '../../domain/memory.ts'
import { PROGRAM_FILE_TOOLS } from '../../domain/programs.ts'
import { type BigDataHook, bigDataConnector } from '../bigdata/index.ts'
import { CHANNEL_OWN_WRITE_TOOLS, CHANNEL_READ_TOOLS } from '../channels/index.ts'
import { telegramConnector } from '../telegram/connector.ts'
import { telegramUserConnector, type UserConnectorOptions } from '../telegram-user/connector.ts'
import { DATETIME_TOOL } from './clock-plugin.ts'
import { DECISION_TOOLS } from './decisions-plugin.ts'
import { type LibraryChange, libraryFs } from './library-fs.ts'
import { PERSONA_TOOLS } from './persona-plugin.ts'
import type { ModelConfig } from './provider.ts'
import { sessionFileSystem } from './rehearsal-registry.ts'
import { WORK_QUEUE_TOOLS } from './work-queue-plugin.ts'

/** Memory tools are file writes by definition: the agent owns its memory, so they never ask. */
export const MEMORY_TOOL_KINDS = {
  memory_view: { kind: 'read' as const, pathField: 'path' },
  memory_create: { kind: 'write' as const, pathField: 'path' },
  memory_str_replace: { kind: 'write' as const, pathField: 'path' },
  memory_insert: { kind: 'write' as const, pathField: 'path' },
  memory_delete: { kind: 'write' as const, pathField: 'path' },
  memory_rename: { kind: 'write' as const, pathField: 'old_path' },
}
const MEMORY_ALLOW = Object.keys(MEMORY_TOOL_KINDS).filter((n) => n !== 'memory_view')

/**
 * The app's own rules of an agent, merged most-restrictive-wins with the connector rules
 * (`activateConnectors({ appRules })`): its definition rules, memory writes (the agent owns its
 * memory) and library edits (the point of the role agents; deletes still ask).
 */
export function appRulesOf(def: Pick<AgentDef, 'rules'>): {
  allow: string[]
  ask: string[]
  deny: string[]
} {
  return {
    // asking the client for a decision never needs a permission of its own (decisions-plugin.ts)
    allow: [
      ...def.rules.allow,
      ...MEMORY_ALLOW,
      'write_file',
      'edit_file',
      ...DECISION_TOOLS,
      ...WORK_QUEUE_TOOLS,
      // reading the Briefing page is read-only
      READ_BRIEFINGS_TOOL,
      // the clock is read-only
      DATETIME_TOOL,
      // an agent's own background worker (a copy of itself): its tool calls keep their own rules;
      // the lead's Team connector modes still win for the lead (most restrictive)
      'agent',
      'agent_output',
      'agent_stop',
      // reading and describing chat channels is read-only; posting keeps its own risk (`infra/channels`)
      ...CHANNEL_READ_TOOLS,
      // a recap note and a reminder stay in the team's own space; roles decide who may use them
      ...CHANNEL_OWN_WRITE_TOOLS,
      // the persona tool decides in code who may do what; apply and revert always ask the person
      ...PERSONA_TOOLS,
    ],
    ask: [...def.rules.ask],
    deny: [...def.rules.deny],
  }
}

export const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/'

/** Late-bound pieces that need the agent factory. */
export interface CatalogHooks {
  /** The subagents plugin of a lead (delegation and messaging); undefined for other agents. */
  team?: (agent: AgentDef, input: BuiltinInput) => ConnectorActivation
  /** The big-data toolkit plugin (`infra/bigdata`); undefined = the connector offers nothing. */
  bigdata?: BigDataHook
}

export interface CatalogOptions {
  sqlite: Database
  agentById: (id: string) => AgentDef | undefined
  /** Search backend of `web_search`; absent = the Web connector has no search capability. */
  search?: ModelConfig['search']
  onFileChange?: (change: LibraryChange) => void
  hooks: CatalogHooks
  /** Lists the tools of a remote MCP server (default `listRemoteMcpTools`; tests inject a fake). */
  listTools?: typeof listRemoteMcpTools
  /**
   * `defer` of the remote MCP servers of the agent being activated (tool access: `true` = found
   * with `tool_search`, `'auto'` = the library's per-server threshold). Default `true`.
   */
  defer?: () => boolean | 'auto'
  /** Bot API root of the Telegram bot connector (default `https://api.telegram.org`). */
  telegramApiRoot?: string
  /** The "Telegram account" connector (user account over MTProto); absent = not offered. */
  telegramUser?: UserConnectorOptions
}

/** Connection label of the two memory scopes, as people and the model read them. */
export const MEMORY_LABELS = {
  workspace: 'Workspace memory — shared by the whole team',
  agent: "This agent's memory — only this agent",
} as const

interface RemoteSettings {
  url: string
  authMode: 'none' | 'headers' | 'oauth'
  headers?: Record<string, string>
  transport?: 'http' | 'sse'
  allow?: string[]
  deny?: string[]
  /** The user's own OAuth client of this server (otherwise registered dynamically). */
  oauthClientId?: string
  oauthClientSecret?: string
}

/** Request headers apply in every mode (OAuth adds its token on top). */
const hasHeaders = (s: RemoteSettings): boolean =>
  s.headers !== undefined && Object.keys(s.headers).length > 0

/**
 * Reads of custom and third-party servers default to Allowed: asking for every lookup of a tracker
 * is noise that trains the owner to click through (P40 value pass). Writes and destructive tools
 * keep Ask first and stay pinned to ask.
 */
const readsAllowed = <T extends { kind: string; defaultMode: string }>(caps: T[]): T[] =>
  caps.map((c) => (c.kind === 'read' ? { ...c, defaultMode: 'allow' } : c))

/** A field only the migration sets (never shown: the condition can not hold). */
const NEVER = { field: 'authMode', in: [] as unknown[] }

/** The custom remote MCP connector, extended with the legacy SSE transport and a stable tool prefix. */
function customMcp(
  listTools: typeof listRemoteMcpTools,
  defer: () => boolean | 'auto',
): AnyConnectorDefinition {
  const base = remoteMcpConnector({
    id: 'mcp-remote',
    name: 'Custom connector',
    description: 'Connect any remote MCP server by its URL.',
    icon: 'plugs',
    category: 'custom',
    listTools: (server) => listTools(server) as Promise<RemoteToolInfo[]>,
  })
  const settings = (base.settings as z.ZodObject).extend({
    transport: z
      .enum(['http', 'sse'])
      .default('http')
      .meta({
        title: 'Transport',
        description: 'Streamable HTTP, or the older SSE transport.',
        ...ehMeta({ group: 'advanced', widget: 'radio', showWhen: NEVER }),
      }),
    // the user's own OAuth client of this server (set when adding it; never shown in the flow form)
    oauthClientId: z
      .string()
      .optional()
      .meta({ title: 'OAuth client ID', ...ehMeta({ group: 'auth', showWhen: NEVER }) }),
    oauthClientSecret: z
      .string()
      .optional()
      .meta({
        title: 'OAuth client secret',
        ...ehMeta({ group: 'auth', secret: true, widget: 'password', showWhen: NEVER }),
      }),
    // tool lists of servers set up before connectors (hidden; capabilities replace them on a test)
    allow: z
      .array(z.string())
      .optional()
      .meta({ title: 'Allowed tools', ...ehMeta({ group: 'advanced', showWhen: NEVER }) }),
    deny: z
      .array(z.string())
      .optional()
      .meta({ title: 'Blocked tools', ...ehMeta({ group: 'advanced', showWhen: NEVER }) }),
  })
  return defineConnector({
    ...base,
    docsUrl: 'https://modelcontextprotocol.io/docs/getting-started/intro',
    // a remote tool never shadows a built-in one and rules keep one name per tool
    toolPrefix: 'always',
    settings,
    test: async (ctx) => {
      const s = ctx.settings as unknown as RemoteSettings
      if (s.transport === 'sse')
        return { ok: true, message: 'Saved. Tools of SSE servers are not listed.' }
      const token = ctx.accessToken
      try {
        const tools = await listTools({
          url: s.url,
          ...(hasHeaders(s) ? { headers: s.headers as Record<string, string> } : {}),
          ...(s.authMode === 'oauth' && token !== undefined
            ? { getAccessToken: () => Promise.resolve(token) }
            : {}),
        })
        return {
          ok: true,
          message: `Found ${tools.length} tools.`,
          // reads of a custom server default to Allowed (a tracker's lookups asked on every call);
          // writes and destructive tools keep Ask first (P40 value pass)
          capabilities: readsAllowed(capabilitiesFromTools(tools as RemoteToolInfo[])),
        }
      } catch (error) {
        return {
          ok: false,
          message: `Could not reach the server: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`,
        }
      }
    },
    activate: (ctx) => {
      const s = ctx.settings as unknown as RemoteSettings
      // tools are always `<slug>_<tool>` (`toolPrefix: 'always'`): `ctx.toolPrefix`
      const prefix = ctx.toolPrefix
      if (s.transport === 'sse') {
        const modes = Object.entries(ctx.toolModes)
        const off = modes.filter(([, m]) => m === 'off').map(([t]) => t)
        const on = modes.filter(([, m]) => m !== 'off').map(([t]) => t)
        return mcpServerSource({
          name: ctx.slug,
          transport: {
            type: 'sse',
            url: s.url,
            ...(hasHeaders(s) ? { headers: s.headers as Record<string, string> } : {}),
          },
          prefix,
          ...(modes.length > 0 ? { allow: on } : s.allow === undefined ? {} : { allow: s.allow }),
          ...(off.length > 0 || s.deny !== undefined ? { deny: [...off, ...(s.deny ?? [])] } : {}),
          defer: defer(),
          wrapUntrusted: true,
          timeoutMs: 15_000,
        })
      }
      return {
        kind: 'mcp' as const,
        name: ctx.slug,
        url: s.url,
        ...(hasHeaders(s) ? { headers: s.headers as Record<string, string> } : {}),
        ...(s.authMode === 'oauth' ? { getAccessToken: ctx.connection.getAccessToken } : {}),
        ...(s.allow === undefined ? {} : { allow: s.allow }),
        ...(s.deny === undefined ? {} : { deny: s.deny }),
        defer: defer(),
      }
    },
  })
}

const GITHUB_API = 'https://api.github.com'

/** GitHub through its remote MCP server: OAuth app (admin credentials) or a personal access token. */
function github(
  listTools: typeof listRemoteMcpTools,
  defer: () => boolean | 'auto',
): AnyConnectorDefinition {
  return defineConnector({
    id: 'github',
    version: '1',
    name: 'GitHub',
    description: 'Work with repositories, issues and pull requests.',
    icon: 'github-logo',
    publisher: 'GitHub',
    homepage: 'https://github.com/github/github-mcp-server',
    docsUrl: 'https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md',
    category: 'development',
    source: 'curated',
    scopes: ['workspace', 'agent'],
    toolPrefix: 'always',
    settings: z.object({
      authMode: z
        .enum(['oauth', 'token'])
        .default('oauth')
        .meta({
          title: 'Sign in with',
          description: 'GitHub account (OAuth app) or a personal access token.',
          ...ehMeta({ group: 'auth', widget: 'radio' }),
        }),
      token: z
        .string()
        .optional()
        .meta({
          title: 'Personal access token',
          description: 'Create one at github.com/settings/tokens. Stored encrypted.',
          ...ehMeta({
            group: 'auth',
            secret: true,
            widget: 'password',
            showWhen: { field: 'authMode', equals: 'token' },
          }),
        }),
    }),
    auth: {
      type: 'oauth2',
      authorizationUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      scopes: ['repo', 'read:org', 'read:user'],
      pkce: true,
      dcr: 'never',
      clientAuth: 'post',
      client: z.object({ clientId: z.string(), clientSecret: z.string().optional() }),
      when: (settings) => settings.authMode !== 'token',
    },
    // discovered at connect time (read-only tools allowed, the rest ask first)
    capabilities: [],
    test: async (ctx) => {
      const s = ctx.settings as { authMode?: string; token?: string }
      const token = s.authMode === 'token' ? s.token : ctx.accessToken
      if (token === undefined || token === '') {
        return { ok: false, message: 'Enter a personal access token.' }
      }
      let accountLabel: string | undefined
      try {
        const res = await ctx.fetch(`${GITHUB_API}/user`, {
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'user-agent': 'eharness-team',
          },
        })
        if (res.status === 401) return { ok: false, message: 'GitHub rejected the credentials.' }
        if (res.ok) accountLabel = ((await res.json()) as { login?: string }).login
      } catch {
        return { ok: false, message: 'Could not reach GitHub.' }
      }
      try {
        const tools = await listTools({
          url: GITHUB_MCP_URL,
          getAccessToken: () => Promise.resolve(token),
        })
        return {
          ok: true,
          ...(accountLabel === undefined ? {} : { accountLabel }),
          capabilities: readsAllowed(capabilitiesFromTools(tools as RemoteToolInfo[])),
        }
      } catch (error) {
        return {
          ok: false,
          message: `Could not list GitHub tools: ${error instanceof Error ? error.message.slice(0, 160) : 'unknown error'}`,
        }
      }
    },
    activate: (ctx) => {
      const s = ctx.settings as { authMode?: string; token?: string }
      return {
        kind: 'mcp' as const,
        name: ctx.slug,
        url: GITHUB_MCP_URL,
        ...(s.authMode === 'token' && s.token !== undefined
          ? { headers: { Authorization: `Bearer ${s.token}` } }
          : { getAccessToken: ctx.connection.getAccessToken }),
        defer: defer(),
      }
    },
  })
}

export function createConnectorDefinitions(options: CatalogOptions): AnyConnectorDefinition[] {
  const { sqlite } = options
  const defOf = (id: string): AgentDef => {
    const def = options.agentById(id)
    if (def === undefined) throw new Error(`unknown agent ${id}`)
    return def
  }
  const builtins = builtinConnectors({
    labels: {
      files: {
        description: 'Read, write and organise the shared library of files.',
        capabilities: {
          read: { description: 'Open, list and search library files.' },
          edit: { description: 'Create and change library files.' },
          delete: { description: 'Delete library files.' },
        },
      },
      memory: {
        description: 'Remember durable facts across conversations.',
        scopeLabels: { workspace: MEMORY_LABELS.workspace, agent: MEMORY_LABELS.agent },
      },
      planning: { description: 'Keep a todo list while working on multi-step tasks.' },
      web: { description: 'Search the web and read web pages.' },
      ask: { description: 'Ask you a question when something is unclear, and wait.' },
      team: {
        name: 'Team',
        description: 'Delegate work to the other agents and message them (lead only).',
      },
    },
    files: {
      plugin: ({ tools }, ctx) => {
        const def = defOf(ctx.agent.id)
        return filesystem({
          // a rehearsal session sees an overlay over the library (`rehearsal-registry.ts`)
          fs: sessionFileSystem(
            libraryFs(sqlite, {
              agentId: def.id,
              ...(options.onFileChange ? { onChange: options.onFileChange } : {}),
            }),
          ),
          // every tool a program run can be granted is defined; the ones the connection does not
          // offer are hidden from every session but a run that is granted them (`fileGrant`)
          tools: [...new Set([...tools, ...PROGRAM_FILE_TOOLS])] as FileToolName[],
          hiddenPrefixes: ['/memories'],
          ...(def.skills.length > 0 ? { skills: { root: '/skills' } } : {}),
        })
      },
    },
    memory: {
      paths: { workspace: WORKSPACE_MEMORY, agent: agentMemory },
      plugin: (roots) =>
        memory({
          roots: () => roots.map(({ path, write, label }) => ({ path, write, label })),
          pinned: () => roots.map((r) => `${r.path}/profile.md`),
          flushOnCompaction: true,
        }),
    },
    planning: { plugin: () => todos() },
    web: {
      read: () => webFetch({ resolveHost: nodeResolveHost }),
      // offered only with a real backend: a tool that always fails makes models retry forever
      ...(options.search === undefined
        ? {}
        : {
            search: () =>
              webSearch({ search: options.search as NonNullable<typeof options.search> }),
          }),
    },
    ask: { plugin: () => ask() },
    team: { plugin: (input, ctx) => options.hooks.team?.(defOf(ctx.agent.id), input) },
  })
  const listTools = options.listTools ?? listRemoteMcpTools
  const defer = options.defer ?? ((): boolean => true)
  return [
    ...builtins,
    bigDataConnector(() => options.hooks.bigdata),
    github(listTools, defer),
    telegramConnector(
      options.telegramApiRoot === undefined ? {} : { apiRoot: options.telegramApiRoot },
    ),
    ...(options.telegramUser === undefined ? [] : [telegramUserConnector(options.telegramUser)]),
    customMcp(listTools, defer),
  ]
}
