/** The tools a standing order's needs open (P52): what the beat's gate and prompt read. */
import type { ActivatedConnectors } from 'eharness/connectors'
import { needTools, parseNeed, type ToolFact } from '../../domain/standing-orders.ts'

/** The tools of an activation as the beat's gate sees them (connector, connection slugs, kind). */
export function toolFactsOf(
  out: Pick<ActivatedConnectors, 'toolNameMap' | 'connections'>,
  kinds: Readonly<Record<string, string>>,
): ToolFact[] {
  return Object.entries(out.toolNameMap).map(([name, origin]) => ({
    name,
    connectorId: origin.connectorId,
    connectionSlugs: out.connections
      .filter((c) => origin.connectionIds.includes(c.connectionId))
      .map((c) => c.slug),
    kind: kinds[name],
  }))
}

/** The tools for some needs, and the needs nothing opens (`files:` needs no tool). */
export function needsToolsOf(
  out: ActivatedConnectors | undefined,
  kinds: Readonly<Record<string, string>> | undefined,
  needs: readonly string[],
): { tools: string[]; missing: string[] } {
  if (out === undefined)
    return { tools: [], missing: needs.filter((n) => parseNeed(n)?.kind !== 'files') }
  const facts = toolFactsOf(out, kinds ?? {})
  const tools = needTools(needs, facts, out.rules)
  const missing = needs.filter(
    (n) => parseNeed(n)?.kind !== 'files' && needTools([n], facts, out.rules).length === 0,
  )
  return { tools, missing }
}
