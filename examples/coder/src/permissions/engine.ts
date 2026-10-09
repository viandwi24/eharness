/**
 * The permission engine of the coder: the library's `createPermissionEngine()` configured for
 * this app (tool kinds of the app's own tools, protected `.coder` paths, mounts as roots) plus the
 * three pieces of policy the library leaves to applications:
 *
 * - "don't ask again" has a scope: `session` keeps the rule in memory, `project` also writes it to
 *   `.coder/settings.local.json` (the library's `persist` hook is called for every change);
 * - `request_directory_access` asks in every mode, an allow rule or `bypassPermissions` never
 *   approves it (the library has no "always ask" tool kind);
 * - the settings files are the app's: rules are loaded from them by `app/config.ts`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import {
  createPermissionEngine as createLibraryEngine,
  DONT_ASK_REASON,
  type PermissionEngine as LibraryEngine,
  type PermissionRules,
  parseRule,
  type ToolKinds,
} from 'eharness/permissions'
import {
  type CoderConfig,
  type Mount,
  type PermissionDecision,
  type PermissionEngine,
  type PermissionMode,
  TOOL,
  type ToolCallInfo,
} from '../contracts.ts'
import { TOOL_OUTPUTS_VIRTUAL } from '../workspace/index.ts'

export { DONT_ASK_REASON, PLAN_MODE_REASON } from 'eharness/permissions'

/** Paths (relative to a mount root) that always ask before a write, in every mode. */
export const PROTECTED_PATHS: readonly string[] = ['.git', '.coder/settings*.json', '.coder/agents']

/** What the app's own tools are, on top of the library's defaults for eharness's tools. */
export const TOOL_KINDS: ToolKinds = {
  // skills (the core's skill tools) and language servers only read
  load_skill: { kind: 'safe' },
  read_skill_file: { kind: 'safe' },
  search_skills: { kind: 'safe' },
  [TOOL.lsp]: { kind: 'safe' },
  // `other`: asks, denied in plan mode; `decide` below makes it ask even with an allow rule
  [TOOL.dirAccess]: { kind: 'other' },
}

/** The engine the plugin and the controller use (the library's, plus the app's extras). */
export type CoderPermissionEngine = PermissionEngine & LibraryEngine

type Change = { kind: keyof PermissionRules; rule: string; op: 'add' | 'remove' }

/** Read a settings file as an object; `undefined` when it is missing or not an object. */
async function readSettings(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // missing or unreadable
  }
  return undefined
}

/** Apply one rule change to the `permissions` object of the local settings file. */
async function editLocalSettings(file: string, change: Change): Promise<boolean> {
  const existing = await readSettings(file)
  if (existing === undefined && change.op === 'remove') return false
  const settings = existing ?? {}
  const permissions =
    typeof settings.permissions === 'object' &&
    settings.permissions !== null &&
    !Array.isArray(settings.permissions)
      ? (settings.permissions as Record<string, unknown>)
      : {}
  const list = Array.isArray(permissions[change.kind])
    ? (permissions[change.kind] as unknown[])
    : []
  if (change.op === 'add') {
    if (list.includes(change.rule)) return false
    permissions[change.kind] = [...list, change.rule]
  } else {
    if (!list.includes(change.rule)) return false
    permissions[change.kind] = list.filter((entry) => entry !== change.rule)
  }
  settings.permissions = permissions
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`)
  return true
}

/**
 * Create the permission engine.
 *
 * @param opts.config - Settings merged with the CLI flags (initial mode and rules).
 * @param opts.mounts - Current mounts of the virtual tree (directories can be added at runtime).
 */
export function createPermissionEngine(opts: {
  config: CoderConfig
  mounts: () => Mount[]
}): CoderPermissionEngine {
  const { config } = opts
  let writing: Change | undefined
  const engine = createLibraryEngine({
    roots: () =>
      opts.mounts().map((m) => ({
        virtual: m.virtual,
        real: m.real,
        readonly: m.readonly,
        // the tool-outputs mount is readable by the file tools, not a place for shell commands
        workingDir: m.virtual !== TOOL_OUTPUTS_VIRTUAL,
      })),
    home: homedir(),
    mode: config.mode,
    // a bad rule in a settings file is dropped (the library would refuse to start with it)
    rules: {
      allow: config.rules.allow.filter((r) => parseRule(r) !== undefined),
      ask: config.rules.ask.filter((r) => parseRule(r) !== undefined),
      deny: config.rules.deny.filter((r) => parseRule(r) !== undefined),
    },
    protectedPaths: PROTECTED_PATHS,
    toolKinds: TOOL_KINDS,
    // the library calls `persist` for every rule change; only a `project` change is written
    persist: async () => {
      const change = writing
      writing = undefined
      if (change !== undefined) await editLocalSettings(config.settingsFiles.local, change)
    },
  })

  const change = async (c: Change, scope: 'session' | 'project'): Promise<void> => {
    writing = scope === 'project' ? c : undefined
    try {
      if (c.op === 'add') await engine.addRule(c.kind, c.rule)
      else await engine.removeRule(c.kind, c.rule)
    } finally {
      writing = undefined
    }
  }

  // The library engine is a closure object: delegating through the prototype keeps every other
  // method and the `mode` getter live.
  return Object.assign(Object.create(engine) as CoderPermissionEngine, {
    decide(call: ToolCallInfo, modeOverride?: PermissionMode): PermissionDecision {
      const decision = engine.decide(call, modeOverride)
      // Access to a new directory always needs the user, whatever the mode and the rules say.
      if (call.toolName === TOOL.dirAccess && decision.status === 'approved') {
        return engine.mode === 'dontAsk' || modeOverride === 'dontAsk'
          ? { status: 'denied', reason: DONT_ASK_REASON }
          : { status: 'user-approval', reason: 'Access to a new directory always needs approval.' }
      }
      return decision
    },
    suggestRule(call: ToolCallInfo): string | undefined {
      return call.toolName === TOOL.dirAccess ? undefined : engine.suggestRule(call)
    },
    // an invalid rule is ignored (the suggested rules are always valid)
    allow: async (rule: string, scope: 'session' | 'project' = 'session') => {
      if (parseRule(rule.trim()) !== undefined) {
        await change({ kind: 'allow', rule: rule.trim(), op: 'add' }, scope)
      }
    },
    addRule: (
      kind: keyof PermissionRules,
      rule: string,
      scope: 'session' | 'project' = 'session',
    ) => change({ kind, rule: rule.trim(), op: 'add' }, scope),
    // a rule that only lives in the local settings file is removed from there as well
    async removeRule(kind: keyof PermissionRules, rule: string): Promise<boolean> {
      const clean = rule.trim()
      const existed = await engine.removeRule(kind, clean)
      const inFile = await editLocalSettings(config.settingsFiles.local, {
        kind,
        rule: clean,
        op: 'remove',
      })
      return existed || inFile
    },
  })
}
