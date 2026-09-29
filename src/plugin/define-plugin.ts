import { HarnessError } from '../errors.ts'
import { invalidLocalName } from '../messages/data-parts.ts'
import type { DataPartMap, HarnessPlugin, KindMap, PluginDef } from './types.ts'

/** Plugin names: `^[a-z][a-z0-9-]{0,31}$`. */
export const PLUGIN_NAME_PATTERN: RegExp = /^[a-z][a-z0-9-]{0,31}$/

/** Plugin names reserved for the core (`eh`) and the root plugin (`app`). */
export const RESERVED_PLUGIN_NAMES: readonly string[] = ['eh', 'app']

function fail(message: string, details?: Record<string, unknown>): never {
  throw new HarnessError(
    'EH_CONFIG_INVALID',
    message,
    details === undefined ? undefined : { details },
  )
}

/**
 * Validate the static shape of a data part / kind map (names and schema presence).
 * `owner` is used in error messages (`plugin 'fs'`, `app`).
 */
export function validatePartMaps(owner: string, dataParts: unknown, messageKinds: unknown): void {
  for (const [label, map] of [
    ['data part', dataParts],
    ['message kind', messageKinds],
  ] as const) {
    if (map === undefined) continue
    if (typeof map !== 'object' || map === null || Array.isArray(map)) {
      fail(`${owner}: ${label}s must be an object keyed by name.`)
    }
    for (const [key, def] of Object.entries(map)) {
      const problem = invalidLocalName(key)
      if (problem !== undefined) {
        fail(`${owner}: ${label} name '${key}' ${problem}.`, { owner, name: key })
      }
      if (typeof def !== 'object' || def === null || !('schema' in def) || def.schema == null) {
        fail(`${owner}: ${label} '${key}' has no schema.`, { owner, name: key })
      }
      if (label === 'message kind') {
        const role = (def as { role?: unknown }).role
        if (role !== 'user' && role !== 'assistant') {
          fail(`${owner}: message kind '${key}' must have role 'user' or 'assistant'.`, {
            owner,
            name: key,
          })
        }
      }
    }
  }
}

function validateServiceList(name: string, field: string, list: unknown): void {
  if (list === undefined) return
  if (!Array.isArray(list) || list.some((s) => typeof s !== 'string' || s.length === 0)) {
    fail(`plugin '${name}': \`${field}\` must be an array of service names.`, { plugin: name })
  }
}

/**
 * Define a plugin: a bundle of tools, skills, instructions, hooks, services, data parts and
 * message kinds. Pure: validates the definition and returns an opaque value.
 *
 * @example
 * ```ts
 * export const audit = definePlugin({
 *   name: 'audit',
 *   dataParts: { entry: defineDataPart({ schema: z.object({ text: z.string() }) }) },
 *   setup: () => ({
 *     hooks: {
 *       'tool.after': (ctx, e) => { ctx.stream.data('entry', { text: e.toolName }) },
 *     },
 *   }),
 * })
 * ```
 * @throws {HarnessError} `EH_CONFIG_INVALID` for an invalid or reserved name, invalid part names
 *   or missing schemas.
 * @see docs/specs/01-agent-and-plugins.md#2-defineplugin
 */
export function definePlugin<
  const Name extends string,
  const DP extends DataPartMap = Record<never, never>,
  const MK extends KindMap = Record<never, never>,
>(def: PluginDef<Name, DP, MK>): HarnessPlugin<Name, DP, MK> {
  if (typeof def !== 'object' || def === null) fail('definePlugin: expected a definition object.')
  const name: unknown = def.name
  if (typeof name !== 'string' || !PLUGIN_NAME_PATTERN.test(name)) {
    fail(
      `Plugin name '${String(name)}' is invalid: it must match ${String(PLUGIN_NAME_PATTERN)}.`,
      {
        plugin: name,
      },
    )
  }
  if (RESERVED_PLUGIN_NAMES.includes(name)) {
    fail(`Plugin name '${name}' is reserved.`, { plugin: name })
  }
  validatePartMaps(`plugin '${name}'`, def.dataParts, def.messageKinds)
  validateServiceList(name, 'provides', def.provides)
  validateServiceList(name, 'requires', def.requires)
  for (const phase of ['setup', 'session'] as const) {
    if (def[phase] !== undefined && typeof def[phase] !== 'function') {
      fail(`plugin '${name}': \`${phase}\` must be a function.`, { plugin: name })
    }
  }
  return Object.freeze({ name: def.name, '~def': def })
}

/** True for values created by {@link definePlugin} (or the internal root plugin). */
export function isHarnessPlugin(
  value: unknown,
): value is HarnessPlugin<string, DataPartMap, KindMap> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { '~def'?: unknown })['~def'] === 'object'
  )
}
