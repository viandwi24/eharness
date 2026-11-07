import type { KnownStopReason, NoticeCode } from './codes.ts'
import type { HarnessErrorCode, HarnessNoticeCode } from './errors.ts'
import type { StopReason } from './messages/types.ts'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const assert = <T extends true>(): T | undefined => undefined

// STOP_REASONS lists every fixed `StopReason`; only the plugin form has no constant
assert<Equal<KnownStopReason, Exclude<StopReason, `plugin:${string}`>>>()
// NOTICE_CODES lists every library code a notice can carry
assert<Equal<NoticeCode, HarnessErrorCode | HarnessNoticeCode>>()
