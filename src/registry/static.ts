/**
 * Static registries built at boot (internal): instructions, tools, tool sources, skills, skill
 * sources and hooks, in plugin order (root plugin `app` first).
 *
 * Dynamic resolution (sources, `(ctx) => Tool` inputs, session contributions) happens at session
 * open / turn start (P2, P6).
 *
 * @see docs/specs/02-context-registry.md#7-resolution-timing-and-conflicts
 */
import { HarnessError, isHarnessError } from '../errors.ts'
import type { HarnessHooks, HookName, PluginContribution } from '../plugin/types.ts'
import { defineSkill, defineSkillSource } from '../skills/define.ts'
import { isToolSource } from './tool-source.ts'
import {
  type InstructionFn,
  type InstructionInput,
  RESERVED_TOOL_NAMES,
  type Skill,
  type SkillSource,
  type ToolInput,
  type ToolSource,
} from './types.ts'

/** Valid tool names (provider limits). */
export const TOOL_NAME_PATTERN: RegExp = /^[a-zA-Z0-9_-]{1,64}$/

/** Every hook name, in the order of spec 01 §5. */
export const HOOK_NAMES: readonly HookName[] = [
  'session.start',
  'session.close',
  'input.submit',
  'turn.prepare',
  'turn.start',
  'turn.beforeEnd',
  'turn.end',
  'step.prepare',
  'step.end',
  'tool.approve',
  'approval.decided',
  'tool.before',
  'tool.after',
  'message.beforeSave',
  'compaction.before',
  'compaction.prompt',
  'compaction.after',
  'skill.load',
]

/** A normalized instruction entry. */
export type NormalizedInstruction =
  | { owner: string; id?: string; kind: 'static'; text: string }
  | { owner: string; id?: string; kind: 'dynamic'; fn: InstructionFn; refresh: 'session' | 'turn' }

/** A static tool with the plugin that declared it. */
export interface StaticToolEntry {
  owner: string
  name: string
  tool: ToolInput
}

/** A static skill with the plugin that declared it. */
export interface StaticSkillEntry {
  owner: string
  skill: Skill
}

/** A hook with the plugin that registered it. */
export interface HookEntry {
  owner: string
  phase: 'setup' | 'session'
  hooks: HarnessHooks
}

/** Everything contributed statically, in plugin order. */
export interface StaticRegistry {
  instructions: NormalizedInstruction[]
  tools: StaticToolEntry[]
  toolSources: Array<{ owner: string; source: ToolSource }>
  skills: StaticSkillEntry[]
  skillSources: Array<{ owner: string; source: SkillSource }>
  hooks: HookEntry[]
}

/** Human-readable owner for error messages. */
export function describeOwner(owner: string): string {
  return owner === 'app' ? 'the app (agent config)' : `plugin '${owner}'`
}

function invalid(owner: string, message: string): never {
  throw new HarnessError('EH_CONFIG_INVALID', `${describeOwner(owner)}: ${message}`, {
    details: { owner },
  })
}

/** Normalize `instructions` input to entries (throws `EH_CONFIG_INVALID` on bad shapes). */
export function normalizeInstructions(
  owner: string,
  input: InstructionInput | InstructionInput[] | undefined,
): NormalizedInstruction[] {
  if (input === undefined) return []
  const list = Array.isArray(input) ? input : [input]
  return list.map((entry): NormalizedInstruction => {
    if (typeof entry === 'string') return { owner, kind: 'static', text: entry }
    if (typeof entry === 'function')
      return { owner, kind: 'dynamic', fn: entry, refresh: 'session' }
    if (typeof entry === 'object' && entry !== null) {
      const id = typeof entry.id === 'string' ? { id: entry.id } : {}
      if (typeof entry.text === 'string') return { owner, ...id, kind: 'static', text: entry.text }
      if (typeof entry.text === 'function') {
        const refresh = 'refresh' in entry ? entry.refresh : 'session'
        if (refresh !== 'session' && refresh !== 'turn') {
          invalid(owner, `instruction refresh must be 'session' or 'turn'.`)
        }
        return { owner, ...id, kind: 'dynamic', fn: entry.text, refresh }
      }
    }
    return invalid(owner, 'an instruction must be a string, a function or { text }.')
  })
}

/** Create an empty static registry. */
export function createStaticRegistry(): StaticRegistry {
  return { instructions: [], tools: [], toolSources: [], skills: [], skillSources: [], hooks: [] }
}

function isSkillSource(value: unknown): value is SkillSource {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { list?: unknown }).list === 'function' &&
    typeof (value as { load?: unknown }).load === 'function'
  )
}

function isSkill(value: unknown): value is Skill {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { content?: unknown }).content === 'string'
  )
}

/**
 * Add one plugin contribution (setup phase, or the root plugin's config) to the registry,
 * checking static conflicts:
 *
 * - duplicate static tool names and reserved names → `EH_DUPLICATE_TOOL`;
 * - duplicate static skill names → `EH_DUPLICATE_SKILL`;
 * - invalid shapes, invalid tool names, unknown hook names → `EH_CONFIG_INVALID`.
 *
 * Every error message names every involved owner.
 */
export function addContribution(
  registry: StaticRegistry,
  owner: string,
  contribution: PluginContribution,
  phase: 'setup' | 'session' = 'setup',
): void {
  registry.instructions.push(...normalizeInstructions(owner, contribution.instructions))

  const tools = contribution.tools
  if (tools !== undefined) {
    const entries = Array.isArray(tools) ? tools : [tools]
    for (const entry of entries) {
      if (isToolSource(entry)) {
        registry.toolSources.push({ owner, source: entry })
        continue
      }
      if (typeof entry !== 'object' || entry === null) {
        invalid(owner, '`tools` must be a record of tools, a tool source or an array of them.')
      }
      for (const [name, tool] of Object.entries(entry as Record<string, ToolInput>)) {
        addTool(registry, owner, name, tool)
      }
    }
  }

  if (contribution.skills !== undefined) {
    if (!Array.isArray(contribution.skills)) invalid(owner, '`skills` must be an array.')
    for (const entry of contribution.skills) {
      if (isSkillSource(entry)) {
        validateSkillInput(owner, () => defineSkillSource(entry))
        registry.skillSources.push({ owner, source: entry })
      } else if (isSkill(entry)) {
        validateSkillInput(owner, () => defineSkill(entry))
        const existing = registry.skills.find((s) => s.skill.name === entry.name)
        if (existing !== undefined) {
          throw new HarnessError(
            'EH_DUPLICATE_SKILL',
            `Skill '${entry.name}' is declared twice: by ${describeOwner(existing.owner)} and by ${describeOwner(owner)}.`,
            { details: { skill: entry.name, owners: [existing.owner, owner] } },
          )
        }
        registry.skills.push({ owner, skill: entry })
      } else {
        invalid(owner, 'a skill must be a Skill ({ name, description, content }) or a SkillSource.')
      }
    }
  }

  if (contribution.hooks !== undefined) {
    const hooks = contribution.hooks
    if (typeof hooks !== 'object' || hooks === null) invalid(owner, '`hooks` must be an object.')
    for (const [name, fn] of Object.entries(hooks)) {
      if (!HOOK_NAMES.includes(name as HookName)) invalid(owner, `unknown hook '${name}'.`)
      if (typeof fn !== 'function') invalid(owner, `hook '${name}' must be a function.`)
    }
    registry.hooks.push({ owner, phase, hooks: hooks as HarnessHooks })
  }
}

/** Run a skill validator (spec 07 §1–§3), naming the owner in the error. */
function validateSkillInput(owner: string, check: () => unknown): void {
  try {
    check()
  } catch (error) {
    if (isHarnessError(error, 'EH_CONFIG_INVALID')) invalid(owner, error.message)
    throw error
  }
}

function addTool(registry: StaticRegistry, owner: string, name: string, tool: ToolInput): void {
  if (RESERVED_TOOL_NAMES.includes(name)) {
    throw new HarnessError(
      'EH_DUPLICATE_TOOL',
      `Tool name '${name}' is reserved by the core (declared by ${describeOwner(owner)}).`,
      { details: { tool: name, owners: ['eh', owner] } },
    )
  }
  if (!TOOL_NAME_PATTERN.test(name)) {
    invalid(owner, `tool name '${name}' must match ${String(TOOL_NAME_PATTERN)}.`)
  }
  if ((typeof tool !== 'object' || tool === null) && typeof tool !== 'function') {
    invalid(owner, `tool '${name}' must be an AI SDK tool or a (ctx) => tool function.`)
  }
  const existing = registry.tools.find((t) => t.name === name)
  if (existing !== undefined) {
    throw new HarnessError(
      'EH_DUPLICATE_TOOL',
      `Tool '${name}' is declared twice: by ${describeOwner(existing.owner)} and by ${describeOwner(owner)}.`,
      { details: { tool: name, owners: [existing.owner, owner] } },
    )
  }
  registry.tools.push({ owner, name, tool })
}
