/**
 * The permission engine of the coder: the library's `createPermissionEngine()` configured for
 * this app (tool kinds of the app's own tools, protected `.coder` paths, mounts as roots):
 *
 * - "don't ask again" has a scope: `session` stays in memory, `project` goes to `persist`, which
 *   writes it to `.coder/settings.local.json`;
 * - `request_directory_access` is an `alwaysAsk` tool: it asks in every mode;
 * - the settings files are the app's: rules are loaded from them by `app/config.ts`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import type { LanguageModel } from 'ai'
import {
  type AutoClassifier,
  createPermissionEngine as createLibraryEngine,
  type PermissionEngine as LibraryEngine,
  modeCycleFor,
  modelClassifier,
  parseRule,
  type RuleChange,
  type ToolKinds,
} from 'eharness/permissions'
import { type CoderConfig, type Mount, type PermissionEngine, TOOL } from '../contracts.ts'
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
  // loads the schema of a deferred tool; the tool itself still asks when it is called
  tool_search: { kind: 'safe' },
  [TOOL.lsp]: { kind: 'safe' },
  // asks in every mode (an allow rule or bypassPermissions never approves it), no rule suggested
  [TOOL.dirAccess]: { kind: 'other', alwaysAsk: true },
}

/** The engine the plugin and the controller use. */
export type CoderPermissionEngine = PermissionEngine & LibraryEngine

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
async function editLocalSettings(file: string, change: RuleChange): Promise<boolean> {
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
  /**
   * Model of the auto mode classifier, read at every check (the session's model unless
   * `autoMode.model` says otherwise). Without it auto mode is unavailable.
   */
  classifierModel?: () => LanguageModel
}): CoderPermissionEngine {
  const { config } = opts
  const classifierModel = opts.classifierModel
  const classifier: AutoClassifier | undefined =
    classifierModel === undefined || config.autoEnabled === false
      ? undefined
      : (action, ctx) =>
          modelClassifier({
            model: classifierModel(),
            environment: `The working directory is ${config.root}.`,
          })(action, ctx)
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
    ...(classifier ? { classifier } : {}),
    // Shift+Tab: default, acceptEdits, plan, then bypassPermissions (opt-in), then auto
    modeCycle: modeCycleFor({
      bypass: config.bypassInCycle === true || config.mode === 'bypassPermissions',
      auto: classifier !== undefined,
    }),
    // a bad rule in a settings file is dropped (the library would refuse to start with it)
    rules: {
      allow: config.rules.allow.filter((r) => parseRule(r) !== undefined),
      ask: config.rules.ask.filter((r) => parseRule(r) !== undefined),
      deny: config.rules.deny.filter((r) => parseRule(r) !== undefined),
    },
    protectedPaths: PROTECTED_PATHS,
    toolKinds: TOOL_KINDS,
    // only `project` rules reach `persist` (the library keeps `session` rules in memory)
    persist: async (_rules, change) => {
      await editLocalSettings(config.settingsFiles.local, change)
    },
  })
  return engine
}
