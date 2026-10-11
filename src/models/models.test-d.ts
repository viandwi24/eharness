/**
 * Type-level tests of the model catalog and cost helpers (0.8), checked by `tsc --noEmit`
 * (never executed).
 *
 * @see docs/engineering/testing.md#test-layers
 */
import type { LanguageModel } from 'ai'
import type { lookupModel, ModelCatalog, ModelInfo, TurnResult } from '../index.ts'
import type { costOf } from './cost.ts'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

declare const model: LanguageModel

// a catalog is a record or a function; the lookup is optional
type _Lookup = Expect<Equal<ReturnType<typeof lookupModel>, ModelInfo | undefined>>
type _Cost = Expect<Equal<ReturnType<typeof costOf>, number | undefined>>
const record: ModelCatalog = {
  'a/b': { contextWindow: 1000, pricing: { inputPerMTok: 1, outputPerMTok: 2 } as never },
}
const fn: ModelCatalog = (m) => (m === model ? { contextWindow: 10 } : undefined)
void record
void fn
// @ts-expect-error: contextWindow is a number
const badInfo: ModelInfo = { contextWindow: '1000' }
void badInfo

// the error of a turn is optional and carries a typed code (spec 10)
type Code = NonNullable<TurnResult['error']>['code']
type _CodeIsString = Expect<Equal<Code extends string ? true : false, true>>
const known: Code = 'EH_SESSION_BUSY'
void known
// @ts-expect-error: not an error code or notice code
const unknown: Code = 'NOT_A_CODE'
void unknown
type _Optional = Expect<Equal<undefined extends TurnResult['error'] ? true : false, true>>
