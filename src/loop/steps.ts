/**
 * The manual step loop (ADR-0002): one `streamText` call per step, chunks copied with
 * `for await … writer.write`, wire accumulation from guarded `responseMessages`, step barrier,
 * hooks, stop rules and step-boundary input delivery (internal). `runSteps` only sequences the
 * step functions (`step-input`, `step-build`, `step-call`, `step-settle`, `step-decide`).
 *
 * @see docs/architecture.md#34-step-inside-the-loop
 * @see docs/specs/05-session-and-storage.md#31-continue-vs-stop-after-a-step-normative
 */
import { hookTimeoutOf } from '../internal/hook-run.ts'
import { observeSpan } from '../internal/observe.ts'
import { createProgressTracker, DEFAULT_PROGRESS } from './progress.ts'
import { buildStep } from './step-build.ts'
import { recoverHeld, streamStep } from './step-call.ts'
import type { LoopResult, StepLoopInput, StepsCtx } from './step-ctx.ts'
import { decideNext } from './step-decide.ts'
import { beginStep } from './step-input.ts'
import { recordStep } from './step-settle.ts'

/** The state of a fresh step loop run. */
function createStepsCtx(input: StepLoopInput): StepsCtx {
  const { rt } = input
  const open = rt.open
  // plain-error: internal invariant: the step loop only runs on an open session
  if (open === undefined) throw new Error('eharness: session is not open')
  return {
    input,
    rt,
    registry: input.registry,
    info: input.info,
    wire: input.wire,
    compaction: input.compaction,
    open,
    hooks: open.hooks,
    hookTimeoutMs: hookTimeoutOf(rt.agent.config),
    contextOf: rt.contextOf,
    budget: input.maxSteps,
    continues: 0,
    idleContinues: 0,
    novelAtContinue: undefined,
    progress: createProgressTracker(input.progress === false ? {} : input.progress),
    maxNudges: input.progress === false ? 0 : (input.progress?.nudges ?? DEFAULT_PROGRESS.nudges),
    nudges: 0,
    nudge: undefined,
    wrapping: false,
    wrapped: false,
    budgetWarned: new Set<string>(),
    stepIndex: 0,
    model: input.info.model,
    waiting: [],
    lastPrefix: undefined,
    cacheBustWarned: false,
    turnStart: input.turnStart,
    sinceBarrier: input.wire.length,
    external: [],
    inbox: input.inbox,
    output: input.output,
    forceOutputTool: false,
  }
}

/** Run steps until a stop rule matches. Never throws for model or tool failures. */
export async function runSteps(input: StepLoopInput): Promise<LoopResult> {
  const st = createStepsCtx(input)
  while (true) {
    const early = await beginStep(st)
    if (early !== undefined) return early
    const req = await buildStep(st)
    if ('stop' in req) return req
    const run = await observeSpan(
      st.rt.agent.observe,
      'model.call',
      { sessionId: st.rt.id, turnId: st.rt.turn?.info.id, step: st.stepIndex },
      () => streamStep(st, req),
    )
    const held = await recoverHeld(st, req, run)
    if (held === 'retry') continue
    if (held !== undefined) return held
    const rec = await recordStep(st, req, run)
    if ('stop' in rec) return rec
    const next = await decideNext(st, run, rec)
    if (next !== 'continue') return next
  }
}
