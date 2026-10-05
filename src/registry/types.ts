/**
 * Types of the context registry slots: instructions, tools, tool sources, skills.
 *
 * `Skill`/`SkillSource` are specified in spec 07 (implemented in P4); they are declared here so
 * the agent configuration can reference them.
 *
 * @see docs/specs/02-context-registry.md
 * @see docs/specs/07-skills.md
 */
import type { Tool, ToolSet } from 'ai'
import type { DataPartMap, HarnessContext } from '../plugin/types.ts'

/**
 * A dynamic instruction: evaluated with the session context; `undefined`/empty results are skipped.
 *
 * @see docs/specs/02-context-registry.md#2-instructions
 */
export type InstructionFn = (
  ctx: HarnessContext,
) => string | undefined | Promise<string | undefined>

/**
 * One instruction entry: static text, or a function refreshed per session (default) or per turn.
 *
 * @example
 * ```ts
 * instructions: [
 *   'You are a careful reviewer.',                                  // static
 *   (ctx) => `User: ${ctx.runtime.userName}`,                       // once per session
 *   { text: () => `Now: ${new Date().toISOString()}`, refresh: 'turn' }, // turn reminder
 * ]
 * ```
 * @see docs/specs/02-context-registry.md#2-instructions
 */
export type InstructionInput =
  | string
  | { text: string; id?: string }
  | InstructionFn
  | { text: InstructionFn; refresh: 'session' | 'turn'; id?: string }

/**
 * A static tool: an AI SDK `Tool`, or a function resolved once per session with the context of
 * the plugin that declared it. `DP` are the data parts of that plugin (the app's `dataParts` for
 * top-level tools), so `ctx.stream.data(name, data)` is typed.
 *
 * @see docs/specs/02-context-registry.md#31-static-tools
 */
export type ToolInput<DP extends DataPartMap = Record<never, never>> =
  | Tool
  | ((ctx: HarnessContext<DP>) => Tool)

/**
 * Definition of a dynamic tool source.
 *
 * @see docs/specs/02-context-registry.md#32-tool-sources
 */
export interface ToolSourceDef {
  /** Unique source id, e.g. `'mcp:github'`. Used in warnings and for dedupe. */
  id: string
  /** Return the tools currently available. */
  list(ctx: HarnessContext): Promise<ToolSet> | ToolSet
  /** When to call `list()`: once per session at its first turn (default), or before every turn. */
  refresh?: 'session' | 'turn'
  /** Mark returned tools `deferLoading: true` (discovered via tool search). Default false. */
  defer?: boolean
  /** Optional lifecycle, called at session open. */
  open?(ctx: HarnessContext): Promise<void> | void
  /** Optional lifecycle, called at session close / eviction. */
  close?(): Promise<void> | void
}

/**
 * A dynamic tool source, created by {@link defineToolSource}.
 *
 * @see docs/specs/02-context-registry.md#32-tool-sources
 */
export interface ToolSource extends ToolSourceDef {
  /** Brand that distinguishes a source from a tool record at runtime. */
  readonly '~toolSource': true
}

/**
 * Tool names reserved by the core (skill tools and tool search).
 *
 * @see docs/specs/09-tools-and-mcp.md#1-tools-are-ai-sdk-tools
 */
export const RESERVED_TOOL_NAMES: readonly string[] = [
  'tool_search',
  'load_skill',
  'read_skill_file',
  'search_skills',
]

/**
 * Level-1 skill metadata.
 *
 * @see docs/specs/07-skills.md#3-dynamic-skills--skillsource
 */
export interface SkillMeta {
  name: string
  description: string
  /**
   * Optional version (1–64 printable characters, e.g. `'2.1.0'`), shown by `load_skill` and passed
   * to `skill.load` hooks; never shown in the skills index (spec 07 §3).
   */
  version?: string
  meta?: Record<string, unknown>
}

/**
 * Level-2 skill document: `SKILL.md` body plus a manifest of supporting files.
 *
 * @see docs/specs/07-skills.md#3-dynamic-skills--skillsource
 */
export interface SkillDoc extends SkillMeta {
  content: string
  manifest: Array<{ path: string; size?: number }>
}

/**
 * Level-3 content of one supporting skill file.
 *
 * @see docs/specs/07-skills.md#3-dynamic-skills--skillsource
 */
export type SkillFileContent =
  | { type: 'text'; text: string }
  | { type: 'binary'; mediaType: string; data: Uint8Array }

/**
 * A static skill.
 *
 * @see docs/specs/07-skills.md#2-static-skills
 */
export interface Skill {
  name: string
  description: string
  /** Optional version (1–64 printable characters), shown by `load_skill` (spec 07 §3). */
  version?: string
  /** Body of SKILL.md (without frontmatter). */
  content: string
  /** Supporting files, paths relative to the skill root (POSIX, no `..`, no leading `/`). */
  files?: Array<{ path: string; content: string }>
  /** Extra frontmatter fields, preserved and shown in `load_skill`. */
  meta?: Record<string, unknown>
}

/**
 * A dynamic skill source.
 *
 * @see docs/specs/07-skills.md#3-dynamic-skills--skillsource
 */
export interface SkillSource {
  /** Unique id, e.g. `'fs:/skills'`. */
  id: string
  /** L1: metadata only. */
  list(ctx: HarnessContext): Promise<SkillMeta[]> | SkillMeta[]
  /** L2: SKILL.md body + manifest of supporting files. */
  load(name: string, ctx: HarnessContext): Promise<SkillDoc | null> | SkillDoc | null
  /** L3: one supporting file (`path` already validated relative). */
  readFile(
    name: string,
    path: string,
    ctx: HarnessContext,
  ): Promise<SkillFileContent | null> | SkillFileContent | null
  /** Optional L1 alternative for large catalogs. */
  search?(query: string, ctx: HarnessContext): Promise<SkillMeta[]> | SkillMeta[]
  /** Optional physical location, for executors. */
  locate?(name: string, ctx: HarnessContext): { service: string; root: string } | null
  /** When to call `list()`. Default `'session'`. */
  refresh?: 'session' | 'turn'
}

/** The `tools` slot of the agent config and of plugin contributions. */
export type ToolsInput<DP extends DataPartMap = Record<never, never>> =
  | Record<string, ToolInput<DP>>
  | ToolSource
  | Array<Record<string, ToolInput<DP>> | ToolSource>
