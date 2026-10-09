/** The tool map: which tool is what, rule aliases, and how a call's fields are read. */
import type { PermissionCall, PermissionRoot, ToolKind, ToolKindSpec, ToolKinds } from './types.ts'

/** Tool kinds of eharness's own tools (`eharness/filesystem`, `eharness/shell`, `eharness/web`, …). */
export const DEFAULT_TOOL_KINDS: Readonly<ToolKinds> = {
  read_file: { kind: 'read', pathField: 'path' },
  list_files: { kind: 'read', pathField: ['prefix', 'path'], defaultPath: '/', listing: 'list' },
  grep: { kind: 'read', pathField: ['prefix', 'path'], defaultPath: '/', listing: 'grep' },
  glob: { kind: 'read', pathField: ['path', 'prefix'], defaultPath: '/', listing: 'paths' },
  edit_file: { kind: 'write', pathField: 'path' },
  write_file: { kind: 'write', pathField: 'path' },
  delete_file: { kind: 'write', pathField: 'path' },
  bash: { kind: 'shell', commandField: 'command' },
  bash_output: { kind: 'safe' },
  kill_shell: { kind: 'safe' },
  web_fetch: { kind: 'fetch', urlField: 'url' },
  web_search: { kind: 'search' },
  agent: { kind: 'agent', nameField: 'subagent_type' },
  ask_user_question: { kind: 'ask' },
  exit_plan_mode: { kind: 'plan-exit' },
  todo_write: { kind: 'safe' },
}

/**
 * Rule aliases: a rule's tool part expands to tools. `kind:<kind>` stands for every tool of that
 * kind in the tool map, anything else is a tool name.
 */
export const DEFAULT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  Read: ['kind:read'],
  Edit: ['kind:write'],
  Write: ['kind:write'],
  Bash: ['kind:shell'],
  WebFetch: ['kind:fetch'],
  WebSearch: ['kind:search'],
  Agent: ['kind:agent'],
}

/** Resolved tool map, shared by rule matching and the engine. */
export interface ToolTable {
  /** The tool's description; `undefined` for an unknown tool (kind `other`). */
  spec(toolName: string): ToolKindSpec | undefined
  /** The tool's kind (`other` when unknown). */
  kindOf(toolName: string): ToolKind
  /** Every tool of the map. */
  names(): string[]
  /** Names of the tools of a kind. */
  namesOfKind(kind: ToolKind): string[]
  /** Tool names a rule's tool part stands for (alias expansion; other names verbatim). */
  expand(ruleTool: string): readonly string[]
  /** True when the rule's tool part covers the tool called `toolName`. */
  covers(ruleTool: string, toolName: string): boolean
  /** True when the rule's tool part covers at least one tool of `kind`. */
  coversKind(ruleTool: string, kind: ToolKind): boolean
}

/** Build a {@link ToolTable}; `kinds` and `aliases` are merged over the defaults. */
export function createToolTable(
  kinds: ToolKinds | undefined,
  aliases: Record<string, readonly string[]> | undefined,
): ToolTable {
  const specs: Record<string, ToolKindSpec> = { ...DEFAULT_TOOL_KINDS, ...kinds }
  const aliasMap: Record<string, readonly string[]> = { ...DEFAULT_ALIASES, ...aliases }
  const has = (name: string): boolean => Object.hasOwn(specs, name)
  const namesOfKind = (kind: ToolKind): string[] =>
    Object.keys(specs).filter((name) => (specs[name] as ToolKindSpec).kind === kind)
  const expand = (ruleTool: string): readonly string[] => {
    if (!Object.hasOwn(aliasMap, ruleTool)) return [ruleTool]
    const out = new Set<string>()
    for (const item of aliasMap[ruleTool] as readonly string[]) {
      if (item.startsWith('kind:')) {
        for (const name of namesOfKind(item.slice(5) as ToolKind)) out.add(name)
      } else {
        out.add(item)
      }
    }
    return [...out]
  }
  return {
    spec: (name) => (has(name) ? specs[name] : undefined),
    kindOf: (name) => (has(name) ? (specs[name] as ToolKindSpec).kind : 'other'),
    names: () => Object.keys(specs),
    namesOfKind,
    expand,
    covers: (ruleTool, toolName) => expand(ruleTool).includes(toolName),
    coversKind: (ruleTool, kind) =>
      expand(ruleTool).some((name) => has(name) && (specs[name] as ToolKindSpec).kind === kind),
  }
}

/** The string value of the first field of `input` that is present. */
export function fieldOf(input: unknown, fields: string | readonly string[]): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const record = input as Record<string, unknown>
  for (const field of typeof fields === 'string' ? [fields] : fields) {
    const value = record[field]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** The virtual path argument of a read or write call, or `undefined` when missing or invalid. */
export function virtualPathOf(
  call: PermissionCall,
  spec: ToolKindSpec | undefined,
): string | undefined {
  if (spec === undefined) return undefined
  const value = fieldOf(call.input, spec.pathField ?? 'path')
  if (value !== undefined) return value
  const record = call.input
  const present =
    typeof record === 'object' && record !== null
      ? [spec.pathField ?? 'path']
          .flat()
          .some((f) => (record as Record<string, unknown>)[f] !== undefined)
      : false
  return present ? undefined : spec.defaultPath
}

/** The shell command of a call, if the input has one. */
export function commandOf(
  call: PermissionCall,
  spec: ToolKindSpec | undefined,
): string | undefined {
  return fieldOf(call.input, spec?.commandField ?? 'command')
}

/** A virtual prefix with its trailing `/`. */
export function withSlash(virtual: string): string {
  return virtual.endsWith('/') ? virtual : `${virtual}/`
}

/** Roots with normalised virtual prefixes. */
export type Roots = readonly PermissionRoot[]
