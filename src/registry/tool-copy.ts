/**
 * Copying a tool with a replaced `execute` or changed fields, in one place.
 *
 * AI SDK v7 has no tool-wrapping helper (its middleware wraps models only), and `Tool` is a union
 * of function, dynamic and provider-defined shapes whose members cannot be rebuilt from a spread
 * without a cast. The cast lives here and nowhere else.
 *
 * @see docs/specs/01-agent-and-plugins.md#5-hooks
 */
import type { Tool, ToolExecutionOptions } from 'ai'
import { configError } from '../errors.ts'

/** Fields {@link withToolFields} may set; `metadata` carries eharness hints such as `risk`. */
export type ToolFieldOverrides = Partial<Pick<Tool, 'deferLoading' | 'toModelOutput'>> & {
  metadata?: Record<string, unknown>
}

/**
 * A copy of `tool` with a new `execute`; every other field (schemas, `metadata`, `deferLoading`,
 * `toModelOutput`, ...) is preserved. The tool is not mutated.
 *
 * A tool without an `execute` (a client tool or a provider-executed tool) has nothing to wrap, so
 * this is a programmer error and throws `EH_CONFIG_INVALID`; check `typeof tool.execute ===
 * 'function'` first when the input may be either.
 *
 * @experimental
 */
export function withToolExecute<T extends Tool>(
  tool: T,
  // biome-ignore lint/suspicious/noExplicitAny: wrappers are written against the concrete tool's types
  execute: (input: any, options: ToolExecutionOptions<any>) => unknown,
): T {
  if (typeof tool.execute !== 'function') {
    throw configError(
      'withToolExecute: the tool has no `execute` to replace (client and provider-executed tools cannot be wrapped).',
    )
  }
  // cast: spreading a member of AI SDK's `Tool` union widens it; the copy keeps the same shape
  return { ...tool, execute } as unknown as T
}

/**
 * A copy of `tool` with some fields changed (`deferLoading`, `toModelOutput`, `metadata`). Works
 * for every tool shape, with or without `execute`. The tool is not mutated.
 *
 * @experimental
 */
export function withToolFields<T extends Tool>(tool: T, fields: ToolFieldOverrides): T {
  // cast: see withToolExecute
  return { ...tool, ...fields } as unknown as T
}
