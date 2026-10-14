/**
 * `eharness/identity`: one person, many platform accounts, roles and safe linking.
 *
 * @see docs/specs/30-identity.md
 */

export type { MemoryPersonStoreOptions } from './memory.ts'
export { memoryPersonStore } from './memory.ts'
export type { PairingGuard, PairingGuardOptions } from './pairing.ts'
export {
  DEFAULT_CODE_TTL_MS,
  generatePairingCode,
  hashPairingCode,
  MAX_PENDING_CODES,
  normalizePairingCode,
  PAIRING_ALPHABET,
  PAIRING_CODE_LENGTH,
  pairingGuard,
} from './pairing.ts'
export type { RoleDecision, RolePolicies, RolePolicy, ToolRisk } from './roles.ts'
export {
  DEFAULT_ROLE_POLICY,
  decideByRisk,
  resolvePolicy,
  resolveRole,
  TOOL_RISKS,
} from './roles.ts'
export type {
  DefaultRole,
  IdentityErrorCode,
  LinkedVia,
  Person,
  PersonAccount,
  PersonEvent,
  PersonInput,
  PersonListQuery,
  PersonPatch,
  PersonStatus,
  PersonStore,
} from './types.ts'
export { DEFAULT_ROLES, IdentityError, isIdentityError, PERSON_STATUSES } from './types.ts'
