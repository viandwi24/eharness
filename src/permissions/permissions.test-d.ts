/**
 * Type-level tests of `eharness/permissions` (0.8), checked by `tsc --noEmit` (never executed).
 *
 * @see docs/engineering/testing.md#test-layers
 */
import type {
  AutoVerdict,
  ClassifierUnavailableError,
  PERMISSION_MODES,
  PermissionMode,
} from './index.ts'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

// a verdict can hand the action to a person (0.8)
type _Decision = Expect<Equal<AutoVerdict['decision'], 'allow' | 'block' | 'ask'>>
const ask: AutoVerdict = { decision: 'ask', reason: 'input truncated' }
void ask
// @ts-expect-error: not a decision
const bad: AutoVerdict = { decision: 'maybe' }
void bad

type _Modes = Expect<
  Equal<
    PermissionMode,
    'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions' | 'auto'
  >
>
type _ModeList = Expect<Equal<typeof PERMISSION_MODES, readonly PermissionMode[]>>

// an unavailable classifier is a provider error, never a verdict
type _Code = Expect<Equal<ClassifierUnavailableError['code'], 'EH_PROVIDER'>>
