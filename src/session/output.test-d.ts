/**
 * Type-level tests of `SendOptions.output` (spec 05 §3.3), checked by `tsc --noEmit` (never
 * executed).
 *
 * @see docs/engineering/testing.md#test-layers
 */
import { jsonSchema, type LanguageModel } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent, type HarnessRun, type TurnResult } from '../index.ts'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

declare const model: LanguageModel
const agent = defineHarnessAgent({ model })
const session = agent.session('s')
type M = typeof agent extends { '~types': { message: infer X } } ? X : never

// zod: output is z.infer<schema>
const ticket = z.object({ label: z.enum(['bug', 'question']), confidence: z.number() })
const zodRun = session.send('classify', { output: { schema: ticket } })
type ZodOutput = Awaited<typeof zodRun.result>['output']
type _zod = Expect<Equal<ZodOutput, z.infer<typeof ticket> | undefined>>

// AI SDK jsonSchema<T>()
const json = jsonSchema<{ title: string; tags: string[] }>({ type: 'object' })
const jsonRun = session.send('x', { output: { schema: json, mode: 'native' } })
type _json = Expect<
  Equal<Awaited<typeof jsonRun.result>['output'], { title: string; tags: string[] } | undefined>
>

// a Standard Schema
declare const standard: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: 'custom'
    readonly validate: (
      value: unknown,
    ) => { value: { n: number } } | { issues: ReadonlyArray<{ message: string }> }
    readonly types?: { readonly input: unknown; readonly output: { n: number } }
  }
}
const standardRun = session.send(undefined, { output: { schema: standard } })
type _standard = Expect<
  Equal<Awaited<typeof standardRun.result>['output'], { n: number } | undefined>
>

// respond / regenerate / edit carry the type too
const responded = session.respond({}, { output: { schema: ticket } })
type _respond = Expect<
  Equal<Awaited<typeof responded.result>['output'], z.infer<typeof ticket> | undefined>
>
const regenerated = session.regenerate({ output: { schema: ticket } })
type _regenerate = Expect<
  Equal<Awaited<typeof regenerated.result>['output'], z.infer<typeof ticket> | undefined>
>
const edited = session.edit('id', 'again', { output: { schema: ticket } })
type _edit = Expect<
  Equal<Awaited<typeof edited.result>['output'], z.infer<typeof ticket> | undefined>
>

// send() without output keeps HarnessRun<M> unchanged
const plain = session.send('hi')
type _plain = Expect<Equal<typeof plain, HarnessRun<M>>>
const plainOptions = session.send('hi', { maxSteps: 3 })
type _plainOptions = Expect<Equal<typeof plainOptions, HarnessRun<M>>>
type _plainOutput = Expect<Equal<Awaited<typeof plain.result>['output'], undefined>>

// a typed run is still usable where a TurnResult is expected
const asResult: Promise<TurnResult<M>> = zodRun.result
void asResult
