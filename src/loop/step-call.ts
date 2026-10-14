/**
 * The model call of one step (internal): `streamText`, the chunk copy and the recovery of a held-back
 * provider error (expired file, context overflow).
 */
import {
  DownloadError,
  isStepCount,
  type ModelMessage,
  streamText,
  toUIMessageStream,
  type UIMessageChunk,
} from 'ai'
import { experimentalStreamOptions } from '../internal/ai-compat.ts'
import { inputWireMessage } from '../messages/input-wire.ts'
import { observeForSession } from '../models/model-calls.ts'
import { noCallModel } from '../models/no-call.ts'
import { describeError } from '../stream/describe-error.ts'
import type { LoopResult, StepRequest, StepRun, StepsCtx } from './step-ctx.ts'
import { guarded, isToolCallError, withReasoningDuration } from './step-events.ts'
import { degradeFile, fileResolution } from './step-files.ts'
import { aborted, firstOfContinuation, overBudget } from './step-guards.ts'
import { callSettings } from './step-settings.ts'

/** Call the model for one step and copy its chunks to the turn stream. */
export async function streamStep(st: StepsCtx, req: StepRequest): Promise<StepRun> {
  const { stepModel, settings, activeTools, toolChoice, cached } = req
  // the step
  const turnState = st.rt.turn
  if (turnState !== undefined) turnState.step = { index: st.stepIndex, model: stepModel }
  st.input.write({
    type: 'data-eh.status',
    data: { state: 'thinking', step: st.stepIndex },
    transient: true,
  })
  let sawError = false
  let errorText: string | undefined
  let stepAborted = false
  let stepStarted = false
  /** An error chunk before the step's first start-step, held back for overflow recovery. */
  let held: UIMessageChunk | undefined
  let rawError: unknown
  const toolErrorTexts = new Set<string>()
  // step 0 of a continuation: the notes of approved calls follow the tool result message, and
  // `endTurn` runs the approved tools against a model that makes no call (spec 11 §4)
  const endStep = firstOfContinuation(st) && st.input.endAfterContinuation === true
  const noteData = firstOfContinuation(st) ? (st.input.approvalNotes ?? []) : []
  const noteWire: ModelMessage[] = []
  for (const data of noteData)
    noteWire.push(...(await inputWireMessage(data, fileResolution(st.input.rt, st.model))))
  let notesWritten = noteData.length === 0
  const writeNotes = (): void => {
    if (notesWritten) return
    notesWritten = true
    for (const data of noteData)
      st.input.write({ type: 'data-eh.input', data: structuredClone(data) })
  }
  const result = streamText({
    model: endStep
      ? noCallModel()
      : observeForSession(st.rt, stepModel, {
          kind: 'step',
          turnId: st.rt.turn?.info.id,
          stepIndex: st.stepIndex,
          messageId: st.input.messageId,
        }),
    ...(noteWire.length === 0
      ? {}
      : {
          prepareStep: ({ messages }: { messages: ModelMessage[] }) => ({
            messages: [...messages, ...noteWire],
          }),
        }),
    ...(cached.system.length > 0 ? { instructions: cached.system } : {}),
    messages: cached.messages,
    tools: cached.tools,
    toolOrder: st.registry.toolOrder,
    ...(activeTools === undefined ? {} : { activeTools }),
    ...(toolChoice === undefined ? {} : { toolChoice }),
    stopWhen: isStepCount(1),
    abortSignal: st.input.signal,
    ...(cached.providerOptions === undefined ? {} : { providerOptions: cached.providerOptions }),
    ...(st.registry.approval === undefined ? {} : { toolApproval: st.registry.approval }),
    ...experimentalStreamOptions({
      approvalSecret: st.rt.agent.config.approval?.secret,
      refineToolInput: st.registry.refine,
    }),
    ...(st.rt.agent.config.repairToolCall === undefined
      ? {}
      : { repairToolCall: st.rt.agent.config.repairToolCall }),
    ...(st.rt.agent.config.telemetry === undefined
      ? {}
      : { telemetry: st.rt.agent.config.telemetry }),
    ...(st.input.toolsContext === undefined
      ? {}
      : { toolsContext: st.input.toolsContext as never }),
    // native structured output (AI SDK Output.object); never on the wrap-up step
    ...(st.output?.native === undefined || st.wrapping ? {} : { output: st.output.native }),
    onError: ({ error }: { error: unknown }) => {
      rawError ??= error
      st.rt.log.debug('eharness: step error', { error })
    },
    ...callSettings(settings),
  } as Parameters<typeof streamText>[0])

  const ui = toUIMessageStream({
    stream: result.stream,
    tools: cached.tools,
    sendStart: false,
    sendFinish: false,
    onError: (error: unknown) => {
      // tool call errors: the text the wire got (spec 04 §8). For invalid/unknown tool calls AI
      // SDK reports the error object (tool-input-error), then its text (tool-output-error).
      if (isToolCallError(error)) {
        const text = String(error)
        toolErrorTexts.add(text)
        return text
      }
      if (typeof error === 'string' && toolErrorTexts.has(error)) return error
      rawError ??= error
      return describeError(error, (m, d) => st.rt.log.error(m, d))
    },
  })
  /** Start time of every open reasoning part (spec 04 §2: `providerMetadata.eharness.durationMs`). */
  const reasoningStarted = new Map<string, number>()
  for await (const rawChunk of ui) {
    let chunk = rawChunk
    if (chunk.type === 'reasoning-start') reasoningStarted.set(chunk.id, Date.now())
    else if (chunk.type === 'reasoning-end') chunk = withReasoningDuration(chunk, reasoningStarted)
    if (chunk.type === 'abort') {
      stepAborted = true
      continue // the core writes the single terminal abort
    }
    if (chunk.type === 'start-step') {
      stepStarted = true
      writeNotes() // after the approved tools' outputs, before the model's answer
    }
    if (chunk.type === 'error') {
      if (!stepStarted && held === undefined) {
        held = chunk as UIMessageChunk // decided after the stream (spec 06 §7)
        continue
      }
      sawError = true
      errorText ??= chunk.errorText
    }
    st.input.write(chunk as UIMessageChunk)
  }
  const response = await guarded(result.responseMessages)
  if (held === undefined && !stepAborted) writeNotes()
  return {
    result,
    response,
    turnState,
    sawError,
    errorText,
    stepAborted,
    stepStarted,
    held,
    rawError,
    endStep,
    noteWire,
    writeNotes,
  }
}

/**
 * A provider error held back before the step's first `start-step`: degrade an expired file and
 * retry, recover from a context overflow, or release it as the step's error. `'retry'` = run the
 * same step again; `undefined` = go on with the step's outcome.
 */
export async function recoverHeld(
  st: StepsCtx,
  req: StepRequest,
  run: StepRun,
): Promise<LoopResult | 'retry' | undefined> {
  const { capped } = req
  const { held, turnState, stepStarted, stepAborted, rawError } = run
  if (held !== undefined) {
    const heldText = (held as { errorText?: string }).errorText ?? 'The model call failed.'
    // a file of an earlier turn could not be downloaded (an expired link): degrade it to a
    // FILE_UNAVAILABLE text on the wire and retry the step; each retry removes one URL, so this
    // ends. A file of the current turn stays an error (spec 05 §3).
    if (
      !stepStarted &&
      !stepAborted &&
      !st.input.signal.aborted &&
      DownloadError.isInstance(rawError) &&
      degradeFile(st.wire, st.turnStart, rawError.url)
    ) {
      if (turnState !== undefined) turnState.step = undefined
      return 'retry'
    }
    if (
      !stepStarted &&
      !stepAborted &&
      !st.input.signal.aborted &&
      st.compaction.isOverflow(rawError)
    ) {
      const costBefore = st.input.usage.costUsd
      const decision = await st.compaction.onOverflow({
        error: rawError,
        raw: capped.raw,
        delivered: st.wire.slice(st.sinceBarrier),
        wire: capped.messages,
      })
      if (st.input.signal.aborted) return aborted(st)
      if (st.input.usage.costUsd !== costBefore && overBudget(st) !== undefined) {
        if (turnState !== undefined) turnState.step = undefined
        return { stop: 'cost-cap', steps: st.stepIndex, model: st.model }
      }
      if (decision.retry) {
        if (decision.rebuilt !== undefined) {
          const delivered = st.wire.slice(st.sinceBarrier)
          st.wire.splice(0, st.wire.length, ...decision.rebuilt.wire)
          st.turnStart = decision.rebuilt.turnStart
          st.sinceBarrier = st.wire.length - delivered.length
        }
        if (turnState !== undefined) turnState.step = undefined
        return 'retry' // the held-back error chunk is discarded; retry the same step
      }
      st.input.write(held)
      if (turnState !== undefined) turnState.step = undefined
      return {
        stop: 'error',
        error: { code: 'EH_CONTEXT_OVERFLOW', message: heldText },
        steps: st.stepIndex,
        model: st.model,
      }
    }
    st.input.write(held)
    run.sawError = true
    run.errorText ??= heldText
  }
  return undefined
}
