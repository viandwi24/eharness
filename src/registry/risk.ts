/**
 * Tool risk (spec 11 §3.2, internal): `tool({ metadata: { risk } })`, else MCP's
 * `annotations.destructiveHint`. MCP `readOnlyHint` never lowers a risk: annotations are untrusted.
 */
import type { ToolRisk } from '../messages/types.ts'

const RISKS: ReadonlySet<string> = new Set(['read', 'write', 'destructive'])

/** Risk from a tool's metadata (`tool.metadata` / `toolCall.toolMetadata`). */
export function riskOf(metadata: unknown): ToolRisk | undefined {
  if (metadata === null || typeof metadata !== 'object') return undefined
  const m = metadata as { risk?: unknown; annotations?: { destructiveHint?: unknown } }
  if (typeof m.risk === 'string' && RISKS.has(m.risk)) return m.risk as ToolRisk
  if (m.annotations?.destructiveHint === true) return 'destructive'
  return undefined
}
