/**
 * Type-level tests of the connector flow results and definitions (0.8), checked by
 * `tsc --noEmit` (never executed).
 *
 * @see docs/engineering/testing.md#test-layers
 */
import { z } from 'zod/v4'
import {
  type AdvanceResult,
  type advanceFlow,
  type ConnectorActivationContext,
  defineConnector,
  type FlowState,
} from './index.ts'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

type Failure = Extract<AdvanceResult, { ok: false }>

// the failure codes are a closed union, including the 0.8 principal check
type _Codes = Expect<
  Equal<
    Failure['error'],
    'stale-view' | 'expired' | 'finished' | 'invalid-action' | 'principal-mismatch'
  >
>
type _Success = Expect<Equal<Extract<AdvanceResult, { ok: true }>, { ok: true; state: FlowState }>>
type _AlwaysState = Expect<Equal<AdvanceResult['state'], FlowState>>

declare const result: AdvanceResult
if (result.ok) {
  type _S = Expect<Equal<typeof result.state, FlowState>>
  // @ts-expect-error: only failures carry an error code
  result.error
} else {
  const code: Failure['error'] = result.error
  void code
  const message: string = result.message
  void message
  switch (result.error) {
    case 'stale-view':
    case 'expired':
    case 'finished':
    case 'invalid-action':
    case 'principal-mismatch':
      break
    default: {
      const exhaustive: never = result.error
      void exhaustive
    }
  }
}

// advanceFlow resolves with the same union
type _Advance = Expect<Equal<Awaited<ReturnType<typeof advanceFlow>>, AdvanceResult>>

// the settings schema of a definition types the activation context
const schema = z.object({ apiKey: z.string(), retries: z.number().default(2) })
defineConnector({
  id: 'demo',
  version: '1.0.0',
  name: 'Demo',
  description: 'd',
  category: 'dev',
  source: 'custom',
  scopes: ['agent'],
  auth: { type: 'none' },
  settings: schema,
  capabilities: [],
  activate: (ctx) => {
    type _Ctx = Expect<Equal<typeof ctx, ConnectorActivationContext<typeof schema>>>
    type _Settings = Expect<Equal<typeof ctx.settings, { apiKey: string; retries: number }>>
    // @ts-expect-error: not a settings key
    ctx.settings.missing
    return undefined
  },
})
