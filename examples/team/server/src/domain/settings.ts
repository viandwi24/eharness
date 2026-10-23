/** Workspace settings (plan §6.7): defaults the factory and the use cases read. Pure. */
import { PERMISSION_MODES, type PermissionMode, TOOL_ACCESS, type ToolAccess } from './agents.ts'
import { checkBackupPatch } from './backups.ts'
import { invalid } from './errors.ts'
import { checkCompanyRoot } from './library-structure.ts'
import { EH_MODE, type TeamMode, teamModeOf } from './modes.ts'
import { checkWorksRoot, WORKS_ROOT_DEFAULT } from './works-journal.ts'

/**
 * The workspace default mode as stored: one of the three product modes, in eharness spelling
 * (`default` = Manual). Legacy values (`acceptEdits`, `plan`, `dontAsk`) normalize to Manual.
 */
export const SETTINGS_MODES = ['default', 'auto', 'bypassPermissions'] as const
export type SettingsMode = (typeof SETTINGS_MODES)[number]

export const toSettingsMode = (stored: string | null | undefined): SettingsMode =>
  EH_MODE[teamModeOf(stored)]

export const settingsTeamMode = (stored: string | null | undefined): TeamMode => teamModeOf(stored)

export interface WorkspaceSettings {
  /** Tool access of agents that have no setting of their own. */
  toolAccess: ToolAccess
  /**
   * Tools an agent called in the last this many days load up front instead of being found with
   * `tool_search` (a discovery changes the tool list and resets the prompt cache). 0 = off.
   */
  toolWarmDays: number
  /** Mode of chats and agents that have no mode of their own (Manual, Auto or Bypass). */
  defaultPermissionMode: SettingsMode
  /** Monthly USD limit of the workspace budget ledger; null = tracked, not limited. */
  budgetUsd: number | null
  /** Children the lead runs at once (the `subagents` `maxConcurrent`). */
  spawnCap: number
  /** Model id of agents without their own; null = the default profile's default model. */
  defaultModel: string | null
  /** Provider profile of agents without their own; null = the server's default profile. */
  defaultProfile: string | null
  /** IANA timezone of the team: default of the heartbeat's active hours and the digest time. */
  timezone: string
  /** A background run with no activity this many minutes is interrupted and alarmed (P54). */
  stuckRunMinutes: number
  /**
   * Model of the Auto mode classifier (model id, or the legacy `profile:model`); null = the model
   * of the agent whose action is judged ("Same as the agent"). Never a hidden fallback.
   */
  classifierModel: string | null
  /** Provider profile of `classifierModel`; null = the workspace default profile. */
  classifierProfile: string | null
  /** Model of `web_search` (model id); null = the built-in small model of the provider. */
  searchModel: string | null
  /** Provider profile of `searchModel`; null = the workspace default profile (else the first that can search). */
  searchProfile: string | null
  /**
   * The working context window of an agent's heartbeat session (tokens, at least 16 000),
   * independent of its chat window and clamped to the model's. A beat is a small, repeated job:
   * a smaller window keeps every model call of it cheap.
   */
  heartbeatContextWindow: number
  /** Deprecated ceiling on every agent's context window (tokens, at least 16 000); null = none. */
  contextCap: number | null
  /** A custom connector is re-checked in the background when its last check is this old (ms); 0 = on every listing; null = never. */
  connectorHealthTtlMs: number | null
  /** One failed check of a connected server is retried after this long (ms) before it counts as down. */
  connectorProbeRetryMs: number
  /** A background worker job stops when its estimated cost reaches this (USD); 0 = no limit. */
  longRunMaxCostUsd: number
  /** A background worker job stops this many hours after it started; 0 = no limit. */
  longRunMaxHours: number
  /** Steps per chunk of a background worker job. */
  longRunChunkSteps: number
  /** Most active repeating reminders one person may have (chat platforms); 0 = no limit. */
  maxRepeatingReminders: number
  /** The team's name, given to agents in chats ("You are <agent>, the assistant of <team>"); null = none. */
  teamName: string | null
  /** Folder of the daily works journal (`<root>/YYYY/MM/DD.md`); default `/library/works`. */
  worksRoot: string
  /**
   * Folder that holds the company's files (`profile.md`, `knowledge/`, `reports/`, `data/`, ...);
   * the agents' library instructions follow it. null = the built-in layout (`/library/company`,
   * `/library/knowledge`, ...). Changing it moves no file.
   */
  companyRoot: string | null
  /** Events feed: hours kept (0 = by count only). */
  eventsRetentionHours: number
  /** Events feed: rows kept. */
  eventsMaxRows: number
  /** Model call log: rows kept. */
  logMaxRows: number
  /** Model call log: days kept. */
  logRetentionDays: number
  /** Hours the full request and response of a model call are kept (then metadata only). */
  logBodyHours: number
  /** Tool media and browser screenshots kept this many days (0 = keep). */
  mediaRetentionDays: number
  /** Finished routine runs kept this many days (0 = keep). */
  routineRunsRetentionDays: number
  /** Finished tasks kept this many days (0 = keep). */
  tasksRetentionDays: number
  /** Library history kept this many days (0 = keep). */
  libraryHistoryRetentionDays: number
  /** Automatic backups (a daily snapshot and one at start-up when none was taken today). */
  backupEnabled: boolean
  /** Local time (team timezone) of the daily snapshot, `HH:MM`. */
  backupTime: string
  /** Backups: the newest of each of this many days is kept. */
  backupKeepDaily: number
  /** Backups: the newest of each of this many weeks is kept. */
  backupKeepWeekly: number
}

/** Built-in values of the knobs that have a fixed default (current behaviour). */
export const SETTINGS_BUILTIN = {
  toolWarmDays: 7,
  spawnCap: 4,
  stuckRunMinutes: 45,
  classifierModel: null,
  classifierProfile: null,
  searchModel: null,
  searchProfile: null,
  contextCap: null,
  heartbeatContextWindow: 64_000,
  connectorHealthTtlMs: 60_000,
  connectorProbeRetryMs: 3_000,
  longRunMaxCostUsd: 10,
  longRunMaxHours: 24,
  longRunChunkSteps: 80,
  maxRepeatingReminders: 10,
  teamName: null,
  worksRoot: WORKS_ROOT_DEFAULT,
  companyRoot: null,
  eventsRetentionHours: 72,
  eventsMaxRows: 100_000,
  logMaxRows: 5000,
  logRetentionDays: 7,
  // full prompts are large: keep them for a day only, metadata longer
  logBodyHours: 24,
  mediaRetentionDays: 3,
  routineRunsRetentionDays: 30,
  tasksRetentionDays: 90,
  libraryHistoryRetentionDays: 180,
  backupEnabled: true,
  backupTime: '02:00',
  backupKeepDaily: 7,
  backupKeepWeekly: 0,
} as const satisfies Partial<WorkspaceSettings>

type Env = Record<string, string | undefined>

/**
 * Initial defaults from the server environment (precedence: a saved setting > these > the built-in
 * value). The environment is read only here, once at boot: the Settings page owns the values after.
 * Unset, empty or invalid values are ignored.
 */
export function settingsFromEnv(env: Env): Partial<WorkspaceSettings> {
  const text = (name: string): string | undefined => {
    const v = env[name]?.trim()
    return v === undefined || v === '' ? undefined : v
  }
  const num = (name: string): number | undefined => {
    const v = text(name)
    if (v === undefined) return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const out: Partial<WorkspaceSettings> = {}
  const set = <K extends keyof WorkspaceSettings>(
    key: K,
    value: WorkspaceSettings[K] | undefined,
  ) => {
    if (value !== undefined) out[key] = value
  }
  const atLeast = (n: number | undefined, min: number): number | undefined =>
    n !== undefined && n >= min ? n : undefined
  const budget = num('TEAM_BUDGET_USD')
  set('budgetUsd', budget !== undefined && budget > 0 ? budget : undefined)
  const spawn = num('TEAM_SPAWN_CAP')
  set(
    'spawnCap',
    spawn !== undefined && spawn >= 1 ? Math.min(Math.floor(spawn), SPAWN_CAP_MAX) : undefined,
  )
  set('classifierModel', text('TEAM_CLASSIFIER_MODEL'))
  set('searchModel', text('TEAM_SEARCH_MODEL'))
  set('contextCap', atLeast(num('TEAM_CONTEXT_CAP'), CONTEXT_CAP_MIN))
  const ttl = num('TEAM_CONNECTOR_HEALTH_TTL_MS')
  if (ttl !== undefined)
    set('connectorHealthTtlMs', ttl < 0 ? null : Math.min(ttl, HEALTH_TTL_MAX_MS))
  const retry = num('TEAM_CONNECTOR_PROBE_RETRY_MS')
  set(
    'connectorProbeRetryMs',
    retry !== undefined && retry >= 0 ? Math.min(retry, PROBE_RETRY_MAX_MS) : undefined,
  )
  set('longRunMaxCostUsd', atLeast(num('TEAM_LONG_RUN_MAX_COST_USD'), 0))
  set('longRunMaxHours', atLeast(num('TEAM_LONG_RUN_MAX_HOURS'), 0))
  const chunk = num('TEAM_LONG_RUN_CHUNK_STEPS')
  set(
    'longRunChunkSteps',
    chunk !== undefined && chunk >= LONG_RUN_CHUNK_MIN
      ? Math.min(Math.floor(chunk), LONG_RUN_CHUNK_MAX)
      : undefined,
  )
  const reminders = num('TEAM_MAX_REPEATING_REMINDERS')
  set(
    'maxRepeatingReminders',
    reminders !== undefined && Number.isInteger(reminders) && reminders >= 0
      ? reminders
      : undefined,
  )
  set('teamName', text('TEAM_NAME'))
  set('eventsRetentionHours', atLeast(num('TEAM_EVENTS_RETENTION_HOURS'), 0))
  const rows = num('TEAM_EVENTS_MAX_ROWS')
  set('eventsMaxRows', rows !== undefined && rows > 0 ? Math.floor(rows) : undefined)
  const logRows = num('TEAM_LOG_MAX_ROWS')
  set('logMaxRows', logRows !== undefined && logRows > 0 ? Math.floor(logRows) : undefined)
  const logDays = num('TEAM_LOG_RETENTION_DAYS')
  set('logRetentionDays', logDays !== undefined && logDays > 0 ? logDays : undefined)
  set('mediaRetentionDays', atLeast(num('TEAM_MEDIA_RETENTION_DAYS'), 0))
  set('routineRunsRetentionDays', atLeast(num('TEAM_ROUTINE_RUNS_RETENTION_DAYS'), 0))
  set('tasksRetentionDays', atLeast(num('TEAM_TASKS_RETENTION_DAYS'), 0))
  set('libraryHistoryRetentionDays', atLeast(num('TEAM_LIBRARY_HISTORY_RETENTION_DAYS'), 0))
  return out
}

/** The effective initial settings: built-in, then the environment, then explicit `overrides`. */
export function settingsDefaults(
  env: Env,
  overrides: Partial<WorkspaceSettings> = {},
): WorkspaceSettings {
  return {
    toolAccess: 'auto',
    defaultPermissionMode: 'default',
    budgetUsd: null,
    defaultModel: null,
    defaultProfile: null,
    timezone: hostTimezone(env),
    ...SETTINGS_BUILTIN,
    ...settingsFromEnv(env),
    ...overrides,
  }
}

/** The host's timezone (the `TZ` variable, else what the runtime reports), `UTC` as the last resort. */
export function hostTimezone(env: { TZ?: string | undefined } = {}): string {
  const candidates = [env.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone]
  for (const tz of candidates) {
    if (tz === undefined || tz === '') continue
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz })
      return tz
    } catch {}
  }
  return 'UTC'
}

export const SPAWN_CAP_MAX = 32
export const STUCK_RUN_MINUTES_DEFAULT = 45
export const CONTEXT_CAP_MIN = 16_000
export const HEALTH_TTL_MAX_MS = 86_400_000
export const PROBE_RETRY_MAX_MS = 60_000
export const LONG_RUN_CHUNK_MIN = 10
export const LONG_RUN_CHUNK_MAX = 500
export const STUCK_RUN_MINUTES_MIN = 5
export const STUCK_RUN_MINUTES_MAX = 1440

/** A patch accepts any stored mode (legacy spellings too); the store keeps the normalized one. */
export type SettingsPatch = Partial<Omit<WorkspaceSettings, 'defaultPermissionMode'>> & {
  defaultPermissionMode?: PermissionMode | SettingsMode
}

export function checkSettingsPatch(patch: SettingsPatch): void {
  if (patch.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: patch.timezone })
    } catch {
      throw invalid(`unknown timezone: ${patch.timezone}`, 'INVALID_SETTINGS')
    }
  }
  if (patch.toolAccess !== undefined && !TOOL_ACCESS.includes(patch.toolAccess)) {
    throw invalid(`toolAccess must be one of ${TOOL_ACCESS.join(', ')}`, 'INVALID_SETTINGS')
  }
  if (
    patch.defaultPermissionMode !== undefined &&
    !PERMISSION_MODES.includes(patch.defaultPermissionMode)
  ) {
    throw invalid(
      `defaultPermissionMode must be one of ${PERMISSION_MODES.join(', ')}`,
      'INVALID_SETTINGS',
    )
  }
  if (patch.budgetUsd != null && !(Number.isFinite(patch.budgetUsd) && patch.budgetUsd > 0)) {
    throw invalid('budgetUsd must be a positive number or null', 'INVALID_SETTINGS')
  }
  if (
    patch.spawnCap !== undefined &&
    !(Number.isInteger(patch.spawnCap) && patch.spawnCap >= 1 && patch.spawnCap <= SPAWN_CAP_MAX)
  ) {
    throw invalid(`spawnCap must be an integer from 1 to ${SPAWN_CAP_MAX}`, 'INVALID_SETTINGS')
  }
  if (
    patch.stuckRunMinutes !== undefined &&
    !(
      Number.isInteger(patch.stuckRunMinutes) &&
      patch.stuckRunMinutes >= STUCK_RUN_MINUTES_MIN &&
      patch.stuckRunMinutes <= STUCK_RUN_MINUTES_MAX
    )
  ) {
    throw invalid(
      `stuckRunMinutes must be an integer from ${STUCK_RUN_MINUTES_MIN} to ${STUCK_RUN_MINUTES_MAX}`,
      'INVALID_SETTINGS',
    )
  }
  if (
    patch.defaultModel != null &&
    (patch.defaultModel.trim() === '' || patch.defaultModel.length > 200)
  ) {
    throw invalid('defaultModel must be 1-200 characters or null', 'INVALID_SETTINGS')
  }
  if (
    patch.defaultProfile != null &&
    (patch.defaultProfile.trim() === '' || patch.defaultProfile.length > 64)
  ) {
    throw invalid('defaultProfile must be 1-64 characters or null', 'INVALID_SETTINGS')
  }
  checkModelPick(patch.classifierModel, patch.classifierProfile, 'classifierModel')
  checkModelPick(patch.searchModel, patch.searchProfile, 'searchModel')
  const intIn = (
    name: string,
    v: number | null | undefined,
    min: number,
    max: number,
    nullable = false,
  ): void => {
    if (v === undefined || (v === null && nullable)) return
    if (!(typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max)) {
      throw invalid(
        `${name} must be an integer from ${min} to ${max}${nullable ? ' or null' : ''}`,
        'INVALID_SETTINGS',
      )
    }
  }
  const numIn = (name: string, v: number | undefined, min: number, max: number): void => {
    if (v === undefined) return
    if (!(typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max)) {
      throw invalid(`${name} must be a number from ${min} to ${max}`, 'INVALID_SETTINGS')
    }
  }
  intIn('toolWarmDays', patch.toolWarmDays, 0, 365)
  intIn('contextCap', patch.contextCap, CONTEXT_CAP_MIN, 10_000_000, true)
  intIn('heartbeatContextWindow', patch.heartbeatContextWindow, CONTEXT_CAP_MIN, 10_000_000)
  intIn('connectorHealthTtlMs', patch.connectorHealthTtlMs, 0, HEALTH_TTL_MAX_MS, true)
  intIn('connectorProbeRetryMs', patch.connectorProbeRetryMs, 0, PROBE_RETRY_MAX_MS)
  numIn('longRunMaxCostUsd', patch.longRunMaxCostUsd, 0, 100_000)
  numIn('longRunMaxHours', patch.longRunMaxHours, 0, 24 * 365)
  intIn('longRunChunkSteps', patch.longRunChunkSteps, LONG_RUN_CHUNK_MIN, LONG_RUN_CHUNK_MAX)
  intIn('maxRepeatingReminders', patch.maxRepeatingReminders, 0, 1000)
  intIn('eventsRetentionHours', patch.eventsRetentionHours, 0, 24 * 3650)
  intIn('eventsMaxRows', patch.eventsMaxRows, 1000, 100_000_000)
  intIn('logMaxRows', patch.logMaxRows, 100, 10_000_000)
  numIn('logRetentionDays', patch.logRetentionDays, 1, 3650)
  numIn('logBodyHours', patch.logBodyHours, 0, 24 * 365)
  for (const key of [
    'mediaRetentionDays',
    'routineRunsRetentionDays',
    'tasksRetentionDays',
    'libraryHistoryRetentionDays',
  ] as const) {
    intIn(key, patch[key], 0, 36_500)
  }
  checkBackupPatch(patch)
  if (patch.worksRoot !== undefined) checkWorksRoot(patch.worksRoot)
  if (patch.companyRoot != null) checkCompanyRoot(patch.companyRoot)
  if (patch.teamName != null && (patch.teamName.trim() === '' || patch.teamName.length > 100)) {
    throw invalid('teamName must be 1-100 characters or null', 'INVALID_SETTINGS')
  }
}

function checkModelPick(
  model: string | null | undefined,
  profile: string | null | undefined,
  name: string,
): void {
  if (model != null && (model.trim() === '' || model.length > 200)) {
    throw invalid(`${name} must be 1-200 characters or null`, 'INVALID_SETTINGS')
  }
  if (profile != null && (profile.trim() === '' || profile.length > 64)) {
    throw invalid(`${name} profile must be 1-64 characters or null`, 'INVALID_SETTINGS')
  }
}
