/**
 * Type-level tests: shipped plugins return `HarnessPlugin<'name'>` with a literal name (the name
 * keys `ctx.plugins` and typed data parts), checked by `tsc --noEmit` (never executed).
 *
 * @see docs/engineering/testing.md#test-layers
 */
import type { LanguageModel } from 'ai'
import { ask } from './ask/index.ts'
import { group } from './group/index.ts'
import { guard } from './guard/index.ts'
import type { HarnessPlugin } from './index.ts'
import { permissions } from './permissions/index.ts'
import { subagent } from './subagent/index.ts'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

declare const model: LanguageModel
declare const engine: Parameters<typeof permissions>[0]['engine']

type NameOf<P> = P extends HarnessPlugin<infer N> ? N : never

const a = ask()
const g = guard({ model })
const p = permissions({ engine })
const gr = group({ bot: { id: 'bot' } } as never)
const s = subagent({ agents: {}, approvals: 'park' })

type _Ask = Expect<Equal<NameOf<typeof a>, 'ask'>>
type _Guard = Expect<Equal<NameOf<typeof g>, 'guard'>>
type _Permissions = Expect<Equal<NameOf<typeof p>, 'permissions'>>
type _Group = Expect<Equal<NameOf<typeof gr>, 'group'>>
type _Subagent = Expect<Equal<NameOf<typeof s>, 'subagent'>>

// @ts-expect-error: a plugin is not assignable to another plugin's name
const wrong: HarnessPlugin<'guard'> = a
void wrong
