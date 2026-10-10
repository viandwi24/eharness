/**
 * Permission modes of the team app (docs/specs/18-permissions-plugin.md §4, §12). Pure.
 *
 * The product has three modes, a subset of eharness `PermissionMode`:
 *
 *   manual  = `default`            risky tools ask a person
 *   auto    = `auto`               rules first, then a classifier model allows or blocks
 *   bypass  = `bypassPermissions`  everything runs (deny rules and protected paths still apply)
 *
 * Where a session's mode comes from (first hit wins):
 *   1. the session's own stored mode (the DM chat's `PUT /agents/{id}/mode`);
 *   2. for a child session (a role agent running a delegated task): the effective mode of the
 *      session that delegated (subagents inherit the parent's mode);
 *   3. the agent's own mode, when it has one (anything but `default` = "inherit");
 *   4. the workspace default (Settings).
 * Then two clamps: an agent's own mode is also its **ceiling** (an agent pinned to manual never
 * runs in auto or bypass; one pinned to auto never runs in bypass; one that inherits has no
 * ceiling), and `auto` falls back to manual when the server has no classifier model.
 */
import type { PermissionMode } from './agents.ts'

export const TEAM_MODES = ['manual', 'auto', 'bypass'] as const
export type TeamMode = (typeof TEAM_MODES)[number]

/** An agent's own choice: a mode, or "inherit the workspace default". */
export type AgentModeChoice = 'inherit' | TeamMode

/** The eharness `PermissionMode` of a team mode. */
export const EH_MODE: Record<TeamMode, 'default' | 'auto' | 'bypassPermissions'> = {
  manual: 'default',
  auto: 'auto',
  bypass: 'bypassPermissions',
}

/** How loose a mode is: a mode may only be lowered to a smaller rank by a ceiling. */
const RANK: Record<TeamMode, number> = { manual: 0, auto: 1, bypass: 2 }

/** A stored value (agent column, settings, legacy) as one of the three modes. */
export function teamModeOf(stored: string | null | undefined): TeamMode {
  if (stored === 'auto') return 'auto'
  if (stored === 'bypassPermissions' || stored === 'bypass') return 'bypass'
  return 'manual' // default, manual, acceptEdits, plan, dontAsk, anything unknown
}

/** The agent's own choice from its stored `permissionMode`. */
export function agentModeChoice(stored: PermissionMode | string): AgentModeChoice {
  if (stored === 'default') return 'inherit'
  return teamModeOf(stored)
}

/** Loosest mode an agent may run in. */
export function ceilingOf(choice: AgentModeChoice): TeamMode {
  return choice === 'inherit' ? 'bypass' : choice
}

/** `requested`, lowered to `ceiling` when it is looser. */
export function clampMode(requested: TeamMode, ceiling: TeamMode): TeamMode {
  return RANK[requested] <= RANK[ceiling] ? requested : ceiling
}

/** Modes a person may pick for an agent's session. */
export function allowedModes(ceiling: TeamMode, autoAvailable: boolean): TeamMode[] {
  return TEAM_MODES.filter((m) => RANK[m] <= RANK[ceiling] && (m !== 'auto' || autoAvailable))
}

export type ModeSource = 'chat' | 'parent' | 'agent' | 'workspace'

export interface ModeInput {
  /** Own choice of the session's agent. */
  choice: AgentModeChoice
  /** The mode stored for this session, if a person picked one. */
  stored?: TeamMode | undefined
  /** Effective mode of the delegating session (child sessions only). */
  parent?: TeamMode | undefined
  workspaceDefault: TeamMode
  autoAvailable: boolean
}

export interface ResolvedMode {
  mode: TeamMode
  source: ModeSource
  ceiling: TeamMode
  /** True when a clamp lowered the requested mode. */
  clamped: boolean
}

export function resolveMode(input: ModeInput): ResolvedMode {
  const ceiling = ceilingOf(input.choice)
  let requested: TeamMode
  let source: ModeSource
  if (input.stored !== undefined) {
    requested = input.stored
    source = 'chat'
  } else if (input.parent !== undefined) {
    requested = input.parent
    source = 'parent'
  } else if (input.choice !== 'inherit') {
    requested = input.choice
    source = 'agent'
  } else {
    requested = input.workspaceDefault
    source = 'workspace'
  }
  let mode = clampMode(requested, ceiling)
  if (mode === 'auto' && !input.autoAvailable) mode = 'manual'
  return { mode, source, ceiling, clamped: mode !== requested }
}
