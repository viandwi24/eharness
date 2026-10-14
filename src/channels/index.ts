/**
 * `eharness/channels`: platform-neutral delivery machinery for chat products: a rate governor
 * (token buckets and platform park state), an outbox (store port, retrying worker, circuit
 * breaker) and structured mentions. The gateway (adapters, inbound) is a later slice.
 *
 * Imports core only through `src/index.ts` (ADR-0008); runtime-neutral.
 *
 * **Draft:** every symbol of this subpath is experimental and may change in a minor release
 * (docs/engineering/api-stability.md).
 *
 * @see docs/specs/31-channels.md
 */

export {
  type AcquireOptions,
  abortableSleep,
  createRateGovernor,
  PARK_ALL,
  type RateClass,
  type RateGovernor,
  type RateGovernorOptions,
  type RateGovernorState,
} from './governor.ts'
export { type MemoryOutboxStoreOptions, memoryOutboxStore } from './memory.ts'
export {
  hasMentionTokens,
  mentionToken,
  neutralizeHandles,
  type ParsedMention,
  parseMentionTokens,
  plainMentions,
  readableMentions,
} from './mentions.ts'
export {
  type BackoffOptions,
  type BreakerOptions,
  createOutbox,
  type Outbox,
  type OutboxEvent,
  type OutboxOptions,
  PermanentSendError,
  RetryAfter,
  type SendContext,
} from './outbox.ts'
export type {
  Json,
  OutboxFailure,
  OutboxItem,
  OutboxRecord,
  OutboxState,
  OutboxStore,
} from './types.ts'
