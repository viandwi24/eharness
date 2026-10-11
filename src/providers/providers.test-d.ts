/**
 * Type-level tests of `eharness/providers` (0.8), checked by `tsc --noEmit` (never executed).
 *
 * @see docs/engineering/testing.md#test-layers
 */
import { z } from 'zod/v4'
import { defineProvider } from './builtin.ts'
import type { ModelRef, ProviderDefinition } from './index.ts'
import type { formatModelRef, parseModelRef } from './manager.ts'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

// a model ref is a string or an explicit pair, nothing else
type _Ref = Expect<Equal<ModelRef, string | { profile: string; model: string }>>
// @ts-expect-error: a number is not a model ref
const bad: ModelRef = 3
void bad

type _Parsed = Expect<Equal<ReturnType<typeof parseModelRef>, { profile: string; model: string }>>
type _Formatted = Expect<Equal<ReturnType<typeof formatModelRef>, string>>

// the settings schema types `create`, `listModels` and `test` (output type: defaults applied)
const settings = z.object({ apiKey: z.string(), baseUrl: z.string().default('https://x.test') })
const def = defineProvider({
  id: 'demo',
  label: 'Demo',
  settings,
  envMap: { apiKey: 'DEMO_KEY' },
  create: (s) => {
    type _Settings = Expect<Equal<typeof s, { apiKey: string; baseUrl: string }>>
    return { languageModel: () => ({}) as never }
  },
  listModels: async (s) => {
    const url: string = s.baseUrl
    void url
    return []
  },
})
type _Def = Expect<Equal<typeof def, ProviderDefinition>>

defineProvider({
  id: 'bad-env',
  label: 'Bad',
  settings,
  // @ts-expect-error: envMap keys must be fields of the settings schema
  envMap: { nope: 'X' },
  create: () => ({ languageModel: () => ({}) as never }),
})
