/**
 * The only place in `src/` (core) that names an `experimental_*` AI SDK option. If a future `ai`
 * release renames one, this file and `src/ai-sdk-experimental.test.ts` are the only changes.
 *
 * Still experimental in `ai` 7.0.137 with no stable alternative: `experimental_refineToolInput`,
 * `experimental_toolApprovalSecret`. Already stable and used by name: `telemetry`, `toolApproval`,
 * `repairToolCall`, `include`.
 *
 * @see docs/engineering/api-stability.md
 */
import type { streamText } from 'ai'

type StreamTextOptions = Parameters<typeof streamText>[0]

/** Tool input refinement map (AI SDK `experimental_refineToolInput`). */
export type RefineToolInput = NonNullable<StreamTextOptions['experimental_refineToolInput']>

/**
 * `streamText` options that are still `experimental_` upstream. Spread into the call options;
 * `undefined` inputs add nothing.
 */
export function experimentalStreamOptions(opts: {
  refineToolInput?: RefineToolInput | undefined
  approvalSecret?: string | undefined
}): Partial<
  Pick<StreamTextOptions, 'experimental_refineToolInput' | 'experimental_toolApprovalSecret'>
> {
  return {
    ...(opts.refineToolInput === undefined
      ? {}
      : { experimental_refineToolInput: opts.refineToolInput }),
    ...(opts.approvalSecret === undefined
      ? {}
      : { experimental_toolApprovalSecret: opts.approvalSecret }),
  }
}
