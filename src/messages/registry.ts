/**
 * Registry of data parts and message kinds of one agent (internal).
 *
 * Names are stored without the `data-` prefix (`eh.status`, `filesystem.change`, `invoice`).
 *
 * @see docs/specs/03-messages.md#42-namespacing
 */
import type { FlexibleSchema } from 'ai'
import { HarnessError } from '../errors.ts'
import { coreDataParts, type DataPartDef } from './data-parts.ts'
import { coreMessageKinds, type MessageKindDef } from './kinds.ts'

/** Owner of a registered part: `'eh'` (core), `'app'` (root plugin) or a plugin name. */
export type PartOwner = string

/** A registered data part. Kinds are registered as data parts too (`kind` is then set). */
export interface RegisteredDataPart {
  name: string
  owner: PartOwner
  def: DataPartDef
  /** Set when the part is the payload part of a message kind. */
  kind?: RegisteredKind
}

/** A registered message kind. */
export interface RegisteredKind {
  name: string
  owner: PartOwner
  def: MessageKindDef
}

/** Read-only view of the registry (used by projection and validation). */
export interface MessageRegistry {
  /** Look up a data part by name (`'eh.status'`) or part type (`'data-eh.status'`). */
  dataPart(nameOrType: string): RegisteredDataPart | undefined
  /** Look up a message kind by name. */
  kind(name: string): RegisteredKind | undefined
  /** Every registered data part (including kind payload parts), in registration order. */
  dataParts(): RegisteredDataPart[]
  /** Every registered kind, in registration order. */
  kinds(): RegisteredKind[]
  /** Schemas keyed by name, for `safeValidateUIMessages({ dataSchemas })`. */
  dataSchemas(): Record<string, FlexibleSchema>
}

/** A registry that accepts registrations (boot only). */
export interface MutableMessageRegistry extends MessageRegistry {
  registerDataPart(name: string, def: DataPartDef, owner: PartOwner): void
  registerKind(name: string, def: MessageKindDef, owner: PartOwner): void
}

function describeOwner(owner: PartOwner, what: 'data part' | 'message kind'): string {
  if (owner === 'eh') return `core ${what}`
  if (owner === 'app') return `app ${what} (agent config)`
  return `${what} of plugin '${owner}'`
}

/** Create an empty registry. Use {@link createCoreMessageRegistry} for one with the `eh.*` parts. */
export function createMessageRegistry(): MutableMessageRegistry {
  const parts = new Map<string, RegisteredDataPart>()
  const kinds = new Map<string, RegisteredKind>()
  let schemas: Record<string, FlexibleSchema> | undefined

  const assertFree = (name: string, owner: PartOwner, what: 'data part' | 'message kind') => {
    const existing = parts.get(name)
    if (existing === undefined) return
    const existingWhat = existing.kind === undefined ? 'data part' : 'message kind'
    throw new HarnessError(
      'EH_DUPLICATE_DATA_PART',
      `Data part type 'data-${name}' is declared twice: ${describeOwner(existing.owner, existingWhat)} and ${describeOwner(owner, what)}.`,
      { details: { type: `data-${name}`, owners: [existing.owner, owner] } },
    )
  }

  const strip = (nameOrType: string) =>
    nameOrType.startsWith('data-') && !parts.has(nameOrType) ? nameOrType.slice(5) : nameOrType

  return {
    dataPart: (nameOrType) => parts.get(strip(nameOrType)),
    kind: (name) => kinds.get(name),
    dataParts: () => [...parts.values()],
    kinds: () => [...kinds.values()],
    dataSchemas: () => {
      if (schemas === undefined) {
        schemas = {}
        for (const [name, part] of parts) schemas[name] = part.def.schema
      }
      return schemas
    },
    registerDataPart(name, def, owner) {
      assertFree(name, owner, 'data part')
      parts.set(name, { name, owner, def })
      schemas = undefined
    },
    registerKind(name, def, owner) {
      assertFree(name, owner, 'message kind')
      const kind: RegisteredKind = { name, owner, def }
      kinds.set(name, kind)
      const partDef: DataPartDef = { schema: def.schema, transient: false, model: 'omit' }
      if (def.upgrade !== undefined) partDef.upgrade = def.upgrade
      parts.set(name, { name, owner, def: partDef, kind })
      schemas = undefined
    },
  }
}

/** Create a registry pre-filled with the core data parts and kinds (owner `'eh'`). */
export function createCoreMessageRegistry(): MutableMessageRegistry {
  const registry = createMessageRegistry()
  for (const [name, def] of Object.entries(coreDataParts)) {
    registry.registerDataPart(name, def as DataPartDef, 'eh')
  }
  for (const [name, def] of Object.entries(coreMessageKinds)) {
    registry.registerKind(name, def as MessageKindDef, 'eh')
  }
  return registry
}
