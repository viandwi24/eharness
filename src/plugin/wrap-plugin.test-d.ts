/**
 * Type-level tests of `wrapPlugin`, checked by `tsc --noEmit` (never executed).
 *
 * @see docs/engineering/testing.md#test-layers
 */
import { z } from 'zod/v4'
import {
  defineDataPart,
  definePlugin,
  type HarnessPlugin,
  type StepPrepareEvent,
  wrapPlugin,
} from '../index.ts'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const assert = <_T extends true>(): void => {}

const inner = definePlugin({
  name: 'inner',
  dataParts: { note: defineDataPart({ schema: z.object({ text: z.string() }) }) },
})

// name and part maps are preserved
const same = wrapPlugin(inner)
assert<
  Equal<
    typeof same,
    HarnessPlugin<
      'inner',
      typeof inner extends HarnessPlugin<'inner', infer D> ? D : never,
      Record<never, never>
    >
  >
>()
const sameName: 'inner' = same.name
void sameName

// a new name changes the literal
const renamed = wrapPlugin(inner, { name: 'other' })
const renamedName: 'other' = renamed.name
void renamedName

wrapPlugin(inner, {
  // ctx is typed with the plugin's data parts
  session: (ctx, next) => {
    ctx.stream.data('note', { text: 'x' })
    // @ts-expect-error unknown data part of this plugin
    ctx.stream.data('missing', { text: 'x' })
    return next()
  },
  hooks: {
    'step.prepare': async (ctx, e, next) => {
      assert<Equal<typeof e, StepPrepareEvent>>()
      void ctx
      const patch = await next()
      void patch
      return { reminder: 'x' }
    },
    'tool.approve': (_ctx, e, next) => {
      const name: string = e.toolName
      void name
      return next()
    },
    'session.start': (_ctx, next) => next(),
  },
})

wrapPlugin(inner, {
  hooks: {
    // @ts-expect-error wrong return type for step.prepare
    'step.prepare': () => 42,
  },
})
