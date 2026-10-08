/**
 * Drives a turn to its end: answers every `tool-pending` stop through the approval broker and
 * continues with `respond()`. Shared by the controller (main agent) and the `agent` tool (children).
 */
import type { HarnessRun, HarnessSession, TurnResult } from 'eharness'
import {
  type ApprovalBroker,
  type ApprovalRequest,
  type CoderMessage,
  type PermissionEngine,
  type PermissionMode,
  TOOL,
  type ToolCallInfo,
} from '../contracts.ts'
import { formatAnswers, parseQuestions, questionRequest } from './ask-tool.ts'

/** Options of {@link driveTurn}. */
export interface DriveOptions {
  session: HarnessSession<CoderMessage>
  broker: ApprovalBroker
  permissions: PermissionEngine
  /** Title/detail/suggested rule of a pending call (permissions/describe.ts). */
  describe(call: ToolCallInfo): Promise<{ title: string; detail?: string; suggestedRule?: string }>
  /** Subagent name, shown in prompts; undefined for the main agent. */
  agent?: string
  signal?: AbortSignal
  /** Called with every run (the first one and every respond continuation) before it is awaited; must consume run.stream if it wants the chunks. */
  onRun?(run: HarnessRun<CoderMessage>): void
  /**
   * A bare "No" (no feedback) on a prompt stops the turn: the continuation is aborted right after
   * the denial is recorded. Main agent only; a subagent's denial lets the child continue.
   */
  stopOnBareDeny?: boolean
}

/** Input of a tool call: a pending client tool carries only its id, the call is in the messages. */
async function inputOf(
  session: HarnessSession<CoderMessage>,
  toolCallId: string,
): Promise<unknown> {
  const messages = await session.messages()
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const part of messages[i]?.parts ?? []) {
      const p = part as { toolCallId?: string; input?: unknown }
      if (p.toolCallId === toolCallId) return p.input
    }
  }
  return undefined
}

/**
 * Lets the continuation run until its stream reports the denied tool call (so the denial is what
 * gets stored), then aborts it. The caller's `onRun` gets the run with the stream it expects.
 */
async function stopAfterDenial(
  run: HarnessRun<CoderMessage>,
  onRun: DriveOptions['onRun'],
): Promise<Awaited<HarnessRun<CoderMessage>['result']>> {
  const [forCaller, forUs] = run.stream.tee()
  const proxy = new Proxy(run, {
    get(target, key) {
      if (key === 'stream') return forCaller
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  onRun?.(proxy)
  const reader = forUs.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if ((value as { type?: string }).type === 'tool-output-denied') break
    }
  } catch {
    // the stream failed: the result below carries the error
  } finally {
    reader.cancel().catch(() => {})
  }
  run.abort('denied by user')
  return run.result
}

/** Texts of the `data-eh.input` parts of the last assistant message (what steers delivered). */
async function inputTexts(session: HarnessSession<CoderMessage>): Promise<Set<string>> {
  const messages = await session.messages()
  const last = [...messages].reverse().find((m) => m.role === 'assistant')
  const texts = new Set<string>()
  for (const part of last?.parts ?? []) {
    const p = part as { type: string; data?: { text?: string } }
    if (p.type === 'data-eh.input' && p.data?.text !== undefined) texts.add(p.data.text)
  }
  return texts
}

const DENIED = 'Denied by the user.'

/** The part of the permission engine that remembers the mode chosen on a plan approval. */
interface PlanExitControl {
  setPlanExitMode(mode: PermissionMode | undefined): void
}

/**
 * Awaits `first`, and while the turn stops `tool-pending` asks the user for each open approval
 * (one prompt at a time), applies "don't ask again" rules and continues with `respond()`.
 * Resolves with the last result; never throws for run errors.
 */
export async function driveTurn(
  first: HarnessRun<CoderMessage>,
  opts: DriveOptions,
): Promise<TurnResult<CoderMessage>> {
  const { session, broker, permissions, signal } = opts
  let run = first
  opts.onRun?.(run)
  let result = await run.result
  // notes a continuation could not take (it stopped `tool-pending` before the next step boundary)
  let carried: string[] = []
  while (result.stop === 'tool-pending' && result.pending !== undefined && !signal?.aborted) {
    const pending = result.pending
    const approvals: Array<{ id: string; approved: boolean; reason?: string }> = []
    const notes: string[] = [...carried]
    carried = []
    let bareDeny = false
    for (const entry of pending.approvals) {
      if (entry.granted) continue
      const call: ToolCallInfo = { toolName: entry.toolName, input: entry.input, agent: opts.agent }
      const description = await opts.describe(call)
      const request: ApprovalRequest = {
        id: entry.approvalId,
        agent: opts.agent,
        toolName: entry.toolName,
        input: entry.input,
        title: description.title,
        detail: description.detail,
        suggestedRule: description.suggestedRule,
      }
      let answer: Awaited<ReturnType<ApprovalBroker['ask']>>
      try {
        answer = await broker.ask(request, signal)
      } catch {
        answer = { approved: false }
      }
      if (signal?.aborted) {
        session.abort()
        return result
      }
      if (answer.approved) {
        if (answer.remember !== undefined && request.suggestedRule !== undefined) {
          await permissions.allow(request.suggestedRule, answer.remember)
        }
        approvals.push({ id: entry.approvalId, approved: true })
        if (entry.toolName === TOOL.exitPlan && opts.agent === undefined) {
          // the user chose the mode to continue in; the exit_plan_mode tool switches to it
          const chosen =
            answer.mode === 'acceptEdits' || answer.mode === 'default' ? answer.mode : undefined
          const engine = permissions as Partial<PlanExitControl>
          engine.setPlanExitMode?.(chosen)
        }
        const note = answer.note?.trim()
        if (note) {
          notes.push(`Note from the user about the approved ${entry.toolName} call: ${note}`)
        }
      } else {
        if (!answer.feedback) bareDeny = true
        approvals.push({ id: entry.approvalId, approved: false, reason: answer.feedback || DENIED })
      }
    }
    const toolOutputs: Array<
      { toolCallId: string; output: string } | { toolCallId: string; errorText: string }
    > = []
    for (const call of pending.clientTools) {
      if (call.toolName !== TOOL.ask) {
        toolOutputs.push({
          toolCallId: call.toolCallId,
          errorText: 'Not supported in this client.',
        })
        continue
      }
      const parsed = parseQuestions(await inputOf(session, call.toolCallId))
      if ('error' in parsed) {
        toolOutputs.push({ toolCallId: call.toolCallId, errorText: parsed.error })
        continue
      }
      const request = questionRequest(call.toolCallId, parsed.questions, opts.agent)
      let answered: Awaited<ReturnType<ApprovalBroker['question']>>
      try {
        answered = await broker.question(request, signal)
      } catch {
        answered = null
      }
      if (signal?.aborted) {
        session.abort()
        return result
      }
      toolOutputs.push({ toolCallId: call.toolCallId, output: formatAnswers(request, answered) })
    }
    run = session.respond({ approvals, toolOutputs }, { abortSignal: signal })
    if (bareDeny && opts.stopOnBareDeny) {
      result = await stopAfterDenial(run, opts.onRun)
      break
    }
    opts.onRun?.(run)
    // The notes reach the model at the next step boundary, after the tool result. A steer that
    // misses the running continuation (it ended first) becomes a queued turn: it is followed here.
    const steered: Array<HarnessRun<CoderMessage>> = []
    for (const note of notes) {
      steered.push(session.send(note, { ifBusy: 'steer', abortSignal: signal }))
    }
    const continuation = run
    result = await continuation.result
    if (result.stop === 'tool-pending' && notes.length > 0) {
      // a steer is dropped when the turn stops pending: send what the model has not seen again
      const seenTexts = await inputTexts(session)
      carried = notes.filter((note) => !seenTexts.has(note))
    }
    const seen = new Set<string>([continuation.turnId])
    for (const extra of steered) {
      if (seen.has(extra.turnId)) continue
      seen.add(extra.turnId)
      run = extra
      opts.onRun?.(extra)
      result = await extra.result
    }
  }
  return result
}
