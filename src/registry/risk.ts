/**
 * Tool traits (spec 11 §3.2, ADR-0025): the risk and the idempotency of a tool, read from AI SDK
 * tool metadata. App metadata (`tool({ metadata: { risk, idempotent } })`) is trusted and wins;
 * MCP annotations (`metadata.annotations`, set by `@ai-sdk/mcp`) are untrusted and only tighten.
 *
 * @see docs/specs/11-interaction.md#32-tool-risk
 */
import type { ToolRisk } from '../messages/types.ts'

const RISKS: ReadonlySet<string> = new Set(['read', 'write', 'destructive', 'external'])

const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const

/**
 * Behavioural hints of an MCP tool, as the server sent them (untrusted). Same keys as
 * `McpToolAnnotations` of `@ai-sdk/mcp` (without `title`).
 */
export interface ToolHints {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/**
 * Traits of a tool (spec 11 §3.2): from trusted app metadata first, then (tighten-only) MCP hints.
 *
 * @see docs/specs/11-interaction.md#32-tool-risk
 */
export interface ToolTraits {
  /**
   * `metadata.risk` when it is a valid {@link ToolRisk} (trusted, may be lower than the hints);
   * else `'destructive'` for `destructiveHint: true`, else `'external'` for `openWorldHint: true`;
   * else absent (`unknown` in `approval.risk`). `readOnlyHint` never yields or lowers a risk.
   */
  risk?: ToolRisk
  /**
   * Only from app metadata (`tool({ metadata: { idempotent: true } })`). MCP's `idempotentHint`
   * would loosen retry behaviour, so it is reported in `hints` only. Absent = unknown.
   */
  idempotent?: boolean
  /** Raw MCP hints as the server sent them (untrusted), for app policies and UIs. */
  hints?: ToolHints
}

/** True for a valid {@link ToolRisk} value. */
export function isToolRisk(value: unknown): value is ToolRisk {
  return typeof value === 'string' && RISKS.has(value)
}

/**
 * Traits of a tool from its AI SDK metadata (`tool.metadata`, or `toolCall.toolMetadata` in an
 * approval function). Pure; never throws; unknown or malformed values are ignored.
 *
 * @example
 * ```ts
 * toolTraits({ annotations: { openWorldHint: true } }) // { risk: 'external', hints: { openWorldHint: true } }
 * toolTraits({ risk: 'read', annotations: { destructiveHint: true } }).risk // 'read' (app wins)
 * ```
 * @see docs/specs/11-interaction.md#32-tool-risk
 */
export function toolTraits(metadata: unknown): ToolTraits {
  if (metadata === null || typeof metadata !== 'object') return {}
  const m = metadata as { risk?: unknown; idempotent?: unknown; annotations?: unknown }
  const out: ToolTraits = {}
  let hints: ToolHints | undefined
  if (m.annotations !== null && typeof m.annotations === 'object') {
    const a = m.annotations as Record<string, unknown>
    for (const key of HINTS) {
      const value = a[key]
      if (typeof value === 'boolean') {
        hints ??= {}
        hints[key] = value
      }
    }
  }
  if (isToolRisk(m.risk)) out.risk = m.risk
  else if (hints?.destructiveHint === true) out.risk = 'destructive'
  else if (hints?.openWorldHint === true) out.risk = 'external'
  if (typeof m.idempotent === 'boolean') out.idempotent = m.idempotent
  if (hints !== undefined) out.hints = hints
  return out
}

/** Risk from a tool's metadata (internal shorthand for `toolTraits(metadata).risk`). */
export function riskOf(metadata: unknown): ToolRisk | undefined {
  return toolTraits(metadata).risk
}
