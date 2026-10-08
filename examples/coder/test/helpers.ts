/** Shared helpers of the agent/app/CLI tests: temp projects, isolated CODER_HOME, controllers. */
import { afterEach } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { LanguageModel } from 'ai'
import {
  type ScriptedCallOptions,
  type ScriptedModel,
  type ScriptedStep,
  scriptedModel,
} from 'eharness/testing'
import { loadAgentDefinitions } from '../src/agents/index.ts'
import { createAgents } from '../src/app/agent.ts'
import { type CliFlags, loadConfig } from '../src/app/config.ts'
import { createController } from '../src/app/controller.ts'
import { createStorage } from '../src/app/sessions.ts'
import type {
  AgentDefinition,
  ApprovalBroker,
  CoderConfig,
  CoderController,
  ThinkingLevel,
  ToolCallInfo,
} from '../src/contracts.ts'
import { createBroker, createPermissionEngine, describeApproval } from '../src/permissions/index.ts'
import { createLocalSandbox } from '../src/shell/index.ts'
import { createWorkspace } from '../src/workspace/index.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

/** Register a cleanup to run after the current test. */
export function onCleanup(fn: () => Promise<void>): void {
  cleanups.push(fn)
}

/** A fresh temp directory (real path), removed after the test. */
export async function tempDir(prefix = 'coder-test-'): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  onCleanup(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Write files (relative path → content) under `root`. */
export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
}

/** Point CODER_HOME at a fresh temp directory for the current test; returns it. */
export async function isolateHome(): Promise<string> {
  const home = await tempDir('coder-home-')
  const previous = process.env.CODER_HOME
  const previousModel = process.env.CODER_MODEL
  const previousOffline = process.env.CODER_OFFLINE
  const providerEnv = ['OPENROUTER_API_KEY', 'AI_GATEWAY_API_KEY', 'OPENROUTER_BASE_URL']
  const previousProviderEnv = providerEnv.map((k) => [k, process.env[k]] as const)
  for (const k of providerEnv) delete process.env[k]
  process.env.CODER_HOME = home
  process.env.CODER_OFFLINE = '1'
  delete process.env.CODER_MODEL
  onCleanup(async () => {
    if (previous === undefined) delete process.env.CODER_HOME
    else process.env.CODER_HOME = previous
    if (previousOffline === undefined) delete process.env.CODER_OFFLINE
    else process.env.CODER_OFFLINE = previousOffline
    if (previousModel !== undefined) process.env.CODER_MODEL = previousModel
    for (const [k, v] of previousProviderEnv) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
  return home
}

/** A temp project with `files`, an isolated CODER_HOME and its loaded config. */
export async function setup(
  files: Record<string, string> = {},
  flags: CliFlags = {},
): Promise<{ root: string; home: string; config: CoderConfig & { warnings: string[] } }> {
  const home = await isolateHome()
  const root = await tempDir('coder-proj-')
  await writeFiles(root, files)
  const config = await loadConfig({ cwd: root, ...flags })
  return { root, home, config }
}

/** `git init` plus one commit in `root`. */
export async function gitInit(root: string, branch = 'main'): Promise<void> {
  const run = async (...args: string[]): Promise<void> => {
    const proc = Bun.spawn(['git', ...args], { cwd: root, stdout: 'ignore', stderr: 'ignore' })
    await proc.exited
  }
  await run('init', '-q', '-b', branch)
  await run('config', 'user.email', 't@example.com')
  await run('config', 'user.name', 'T')
  await run('add', '-A')
  await run('commit', '-q', '--allow-empty', '-m', 'init')
}

/** A controller over a temp project with a scripted model. */
export async function makeController(opts: {
  files?: Record<string, string>
  flags?: CliFlags
  model: LanguageModel
  broker?: ApprovalBroker
  /** Instead of `model`: id → model, so `setModel` can be observed. */
  resolveModel?: (id: string) => LanguageModel
  thinking?: ThinkingLevel
}): Promise<{ controller: CoderController; root: string; home: string }> {
  const { root, home, config } = await setup(opts.files, opts.flags)
  const controller = await createController({
    config,
    ...(opts.resolveModel ? { resolveModel: opts.resolveModel } : { model: opts.model }),
    broker: opts.broker,
    ...(opts.thinking ? { thinking: opts.thinking } : {}),
  })
  onCleanup(() => controller.close())
  return { controller, root, home }
}

/** Resolve once `broker.pending()` has an entry (polling); returns it. */
export async function nextPending(broker: ApprovalBroker, timeoutMs = 5000) {
  const start = Date.now()
  for (;;) {
    const [first] = broker.pending()
    if (first !== undefined) return first
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for an approval')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Everything `createAgents` needs, over a temp project; for tests below the controller. */
export async function makeAgentsEnv(opts: {
  files?: Record<string, string>
  flags?: CliFlags
  model: LanguageModel
  broker?: ApprovalBroker
  definitions?: AgentDefinition[]
  maxConcurrentAgents?: number
}) {
  const { root, home, config } = await setup(opts.files, opts.flags)
  const workspace = await createWorkspace(config)
  const permissions = createPermissionEngine({ config, mounts: () => workspace.mounts() })
  const broker = opts.broker ?? createBroker()
  const describe = (call: ToolCallInfo) => describeApproval(call, workspace.fs, permissions)
  const definitions =
    opts.definitions ??
    (
      await loadAgentDefinitions({
        root: config.root,
        userDir: config.userDir,
        cliAgents: config.cliAgents,
        loadProject: config.trusted,
      })
    ).definitions
  const warnings: unknown[] = []
  const agents = await createAgents({
    config,
    workspace,
    sandbox: createLocalSandbox(config.root),
    permissions,
    broker,
    describe,
    definitions,
    storage: createStorage(config),
    model: opts.model,
    ...(opts.maxConcurrentAgents !== undefined
      ? { maxConcurrentAgents: opts.maxConcurrentAgents }
      : {}),
    onWarning: (w) => warnings.push(w),
  })
  onCleanup(() => agents.closeAll())
  return {
    root,
    home,
    config,
    workspace,
    permissions,
    broker,
    describe,
    definitions,
    agents,
    warnings,
  }
}

/** What a router handler sees about one model call. */
export interface RouteCall {
  call: ScriptedCallOptions
  /** The agent is a subagent (its instructions start with the subagent preamble). */
  isChild: boolean
  /** All system text. */
  system: string
  /** Text of the first user message that is not a reminder (a child's is the prompt the parent passed). */
  firstUser: string
  /** Number of tool results already in the prompt = which step of its turn the agent is on. */
  toolResults: number
  /** Names of the tools offered in this call. */
  tools: string[]
  /** Everything in the prompt after the system text, as one string. */
  conversation: string
}

type PromptPart = { type?: string; text?: string }
type PromptMessage = { role: string; content: string | PromptPart[] }

/**
 * One scripted model shared by the main agent and every subagent (the app uses one model for all).
 * Calls from concurrent agents interleave, so each call is routed by what the prompt shows
 * instead of by a fixed index. `handler` runs once per model call.
 */
export function routerModel(
  handler: (route: RouteCall) => ScriptedStep,
  size = 60,
): ScriptedModel & { routes: RouteCall[] } {
  const routes: RouteCall[] = []
  const step = (call: ScriptedCallOptions): ScriptedStep => {
    const prompt = call.prompt as unknown as PromptMessage[]
    const text = (m: PromptMessage): string =>
      typeof m.content === 'string'
        ? m.content
        : m.content.map((p) => (p.type === 'text' ? (p.text ?? '') : '')).join('')
    const system = prompt
      .filter((m) => m.role === 'system')
      .map(text)
      .join('\n')
    const route: RouteCall = {
      call,
      isChild: system.includes('You are a subagent'),
      system,
      firstUser: text(
        prompt.find((m) => m.role === 'user' && !text(m).startsWith('<system-reminder>')) ?? {
          role: 'user',
          content: '',
        },
      ),
      toolResults: prompt
        .filter((m) => m.role === 'tool')
        .reduce((n, m) => n + (Array.isArray(m.content) ? m.content.length : 0), 0),
      tools: ((call.tools ?? []) as Array<{ name: string }>).map((t) => t.name),
      conversation: JSON.stringify(prompt.filter((m) => m.role !== 'system')),
    }
    routes.push(route)
    return handler(route)
  }
  const model = scriptedModel(Array.from({ length: size }, () => step))
  return Object.assign(model, { routes })
}
