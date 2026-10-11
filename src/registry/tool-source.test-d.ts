/**
 * Type-level tests of tool sources and skill sources (0.8), checked by `tsc --noEmit` (never
 * executed).
 *
 * @see docs/engineering/testing.md#test-layers
 */
import { tool } from 'ai'
import { z } from 'zod/v4'
import {
  type defineSkill,
  type defineSkillSource,
  defineToolSource,
  type HarnessContext,
  type Skill,
  type SkillSource,
  type ToolSource,
} from '../index.ts'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const source = defineToolSource({
  id: 'db:tools',
  refresh: 'turn',
  list: async (ctx) => {
    type _Ctx = Expect<Equal<typeof ctx, HarnessContext>>
    return {
      echo: tool({ inputSchema: z.object({ text: z.string() }), execute: ({ text }) => text }),
    }
  },
})
type _Returns = Expect<Equal<typeof source, ToolSource>>
type _Brand = Expect<Equal<(typeof source)['~toolSource'], true>>

defineToolSource({
  id: 'x',
  // @ts-expect-error: refresh is 'session' or 'turn'
  refresh: 'always',
  list: () => ({}),
})
// @ts-expect-error: id and list are required
defineToolSource({ id: 'x' })

type _Skill = Expect<Equal<ReturnType<typeof defineSkill>, Skill>>
type _SkillSource = Expect<Equal<ReturnType<typeof defineSkillSource>, SkillSource>>
// a skill source's L2/L3 may be sync or async and return null for "not found"
type _Load = Expect<
  Equal<
    ReturnType<SkillSource['load']>,
    Promise<import('../index.ts').SkillDoc | null> | import('../index.ts').SkillDoc | null
  >
>
