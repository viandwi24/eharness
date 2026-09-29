import { HarnessError } from '../errors.ts'
import type { ToolSource, ToolSourceDef } from './types.ts'

/**
 * Define a dynamic tool source (tools listed at runtime, e.g. from a database or an MCP server).
 *
 * @example
 * ```ts
 * const tenantTools = defineToolSource({
 *   id: 'db:tenant-tools',
 *   refresh: 'turn',
 *   list: async (ctx) => loadTools(ctx.runtime.tenantId),
 * })
 * defineHarnessAgent({ model, tools: [tenantTools] })
 * ```
 * @see docs/specs/02-context-registry.md#32-tool-sources
 */
export function defineToolSource(def: ToolSourceDef): ToolSource {
  if (typeof def.id !== 'string' || def.id.length === 0) {
    throw new HarnessError(
      'EH_CONFIG_INVALID',
      'defineToolSource: `id` must be a non-empty string.',
    )
  }
  if (typeof def.list !== 'function') {
    throw new HarnessError(
      'EH_CONFIG_INVALID',
      `defineToolSource('${def.id}'): \`list\` must be a function.`,
    )
  }
  if (def.refresh !== undefined && def.refresh !== 'session' && def.refresh !== 'turn') {
    throw new HarnessError(
      'EH_CONFIG_INVALID',
      `defineToolSource('${def.id}'): \`refresh\` must be 'session' or 'turn'.`,
    )
  }
  if (def.defer !== undefined && typeof def.defer !== 'boolean') {
    throw new HarnessError(
      'EH_CONFIG_INVALID',
      `defineToolSource('${def.id}'): \`defer\` must be a boolean.`,
    )
  }
  for (const hook of ['open', 'close'] as const) {
    if (def[hook] !== undefined && typeof def[hook] !== 'function') {
      throw new HarnessError(
        'EH_CONFIG_INVALID',
        `defineToolSource('${def.id}'): \`${hook}\` must be a function.`,
      )
    }
  }
  return Object.freeze({ ...def, '~toolSource': true as const })
}

/** True for values created by {@link defineToolSource}. */
export function isToolSource(value: unknown): value is ToolSource {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { '~toolSource'?: unknown })['~toolSource'] === true
  )
}
