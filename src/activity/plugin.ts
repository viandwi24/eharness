/**
 * `activity()` plugin: turns the lifecycle hooks of every session of an agent into events of an
 * {@link ActivityStore}. Appends are awaited in hook order but never break a turn: a failing store
 * is logged and skipped.
 *
 * @see docs/specs/25-activity.md#2-the-activity-plugin
 */
import {
  definePlugin,
  errorText,
  type HarnessContext,
  type HarnessPlugin,
  type HarnessUIMessage,
  type PendingState,
  type StepEndEvent,
  type TurnResult,
} from '../index.ts'
import type {
  ActivityInput,
  ActivityStore,
  PendingRef,
  SessionActivityPayloads,
  SessionActivityType,
  TurnSourceKind,
} from './types.ts'

/** Options of {@link activity}. */
export interface ActivityPluginOptions {
  store: ActivityStore
  /** Map the agent id of a context (the catalog slug) to the id the feed should carry. */
  agentOf?: (agentId: string) => string | undefined
  /**
   * Only sessions this returns true for emit events (default: every session). Use it to keep a
   * feed free of internal sessions.
   */
  sessions?: (sessionId: string, ctx: HarnessContext) => boolean
  /** Event types to emit (default: all of them). */
  types?: readonly SessionActivityType[]
  /** `false` turns `message-saved` off (it fires for every step of every turn). Default `true`. */
  messages?: boolean
  /** Clock for `at`; default: the store's. */
  now?: () => number
}

/** The items of a pending state that wait for a person (or a system), and those already answered. */
export function pendingRefs(pending: PendingState | undefined | null): {
  waiting: PendingRef[]
  answered: PendingRef[]
} {
  const waiting: PendingRef[] = []
  const answered: PendingRef[] = []
  if (pending === undefined || pending === null) return { waiting, answered }
  for (const a of pending.approvals) {
    const ref: PendingRef = {
      kind: 'approval',
      id: a.approvalId,
      toolCallId: a.toolCallId,
      toolName: a.toolName,
    }
    if (a.answer !== undefined || a.granted === true) answered.push(ref)
    else waiting.push(ref)
  }
  for (const c of pending.clientTools) {
    const ref: PendingRef = {
      kind: 'client-tool',
      id: c.toolCallId,
      toolCallId: c.toolCallId,
      toolName: c.toolName,
    }
    if (c.answer !== undefined || c.result !== undefined) answered.push(ref)
    else waiting.push(ref)
  }
  for (const e of pending.externals ?? []) {
    const ref: PendingRef = {
      kind: 'wait',
      id: e.waitId,
      toolCallId: e.toolCallId,
      toolName: e.toolName,
    }
    if (e.result !== undefined) answered.push(ref)
    else waiting.push(ref)
  }
  return { waiting, answered }
}

function sourceOf(kind: TurnResult['kind'], inboxSource: boolean): TurnSourceKind {
  if (kind === 'wake') return 'wake'
  if (kind === 'respond') return 'respond'
  if (kind === 'regenerate' || kind === 'edit') return 'regenerate'
  return inboxSource ? 'event' : 'user'
}

const CHILD_STATUS: Record<string, string> = {
  complete: 'completed',
  error: 'failed',
  aborted: 'stopped',
}

const num = (n: number | undefined): number => (typeof n === 'number' ? n : 0)

/**
 * The plugin. Register it on the agent (`plugins: [activity({ store })]`); every session of the
 * agent then feeds `store`, on whichever instance runs the turn.
 *
 * @example
 * ```ts
 * const store = inMemoryActivityStore()
 * defineHarnessAgent({ model, plugins: [activity({ store })] })
 * ```
 */
export function activity(options: ActivityPluginOptions): HarnessPlugin<'activity'> {
  const { store } = options
  const allowed = options.types === undefined ? undefined : new Set<string>(options.types)
  const withMessages = options.messages !== false

  async function emit<K extends SessionActivityType>(
    ctx: HarnessContext,
    type: K,
    payload: SessionActivityPayloads[K],
    sessionId: string = ctx.session.id,
  ): Promise<void> {
    if (allowed !== undefined && !allowed.has(type)) return
    if (options.sessions !== undefined && !options.sessions(ctx.session.id, ctx)) return
    const input: ActivityInput = {
      type,
      sessionId,
      agentId: options.agentOf?.(ctx.agent.id) ?? ctx.agent.id,
      payload: payload as unknown as Record<string, unknown>,
      ...(options.now === undefined ? {} : { at: options.now() }),
    }
    try {
      await store.append(input)
    } catch (error) {
      ctx.log.warn(`activity: appending ${type} failed: ${errorText(error)}`)
    }
  }

  const parentOf = (ctx: HarnessContext): { parentSessionId?: string } =>
    ctx.session.parent === undefined ? {} : { parentSessionId: ctx.session.parent.sessionId }

  return definePlugin({
    name: 'activity',
    setup: () => ({
      hooks: {
        'turn.start': async (ctx: HarnessContext, e: { kind: TurnResult['kind'] }) => {
          await emit(ctx, 'turn-started', {
            turnId: ctx.turn?.id ?? '',
            kind: e.kind,
            source: sourceOf(e.kind, ctx.turn?.source !== undefined),
            queued: ctx.turn?.queued ?? false,
            ...parentOf(ctx),
          })
        },

        'step.end': async (ctx: HarnessContext, e: StepEndEvent) => {
          await emit(ctx, 'step-finished', {
            turnId: ctx.turn?.id ?? null,
            stepIndex: e.stepIndex,
            finishReason: String(e.finishReason),
            usage: {
              inputTokens: num(e.usage.inputTokens),
              outputTokens: num(e.usage.outputTokens),
              totalTokens: num(e.usage.totalTokens),
            },
            ...(e.costUsd === undefined ? {} : { costUsd: e.costUsd }),
            toolCalls: e.toolCalls.map((c) => c.toolName),
          })
        },

        'turn.end': async (ctx: HarnessContext, e: TurnResult) => {
          await emit(ctx, 'turn-ended', {
            turnId: e.turnId,
            kind: e.kind,
            stop: e.stop,
            ...(e.messageId === undefined ? {} : { messageId: e.messageId }),
            steps: e.steps,
            durationMs: e.durationMs,
            usage: {
              inputTokens: e.usage.inputTokens,
              outputTokens: e.usage.outputTokens,
              totalTokens: e.usage.totalTokens,
            },
            ...(e.usage.costUsd === undefined ? {} : { costUsd: e.usage.costUsd }),
            ...(e.partial === true ? { partial: true as const } : {}),
            ...(e.error === undefined
              ? {}
              : {
                  error: {
                    code: e.error.code,
                    message: e.error.message,
                  },
                }),
            ...parentOf(ctx),
          })
          const parent = ctx.session.parent
          if (parent !== undefined && e.stop !== 'tool-pending') {
            // a child's turn ended for good: its parent hears about it (park, inline and background)
            await emit(
              ctx,
              'child-reported',
              {
                childSessionId: ctx.session.id,
                status: CHILD_STATUS[e.stop] ?? e.stop,
                stop: e.stop,
                ...(parent.toolCallId === undefined ? {} : { toolCallId: parent.toolCallId }),
                ...(e.messageId === undefined ? {} : { messageId: e.messageId }),
              },
              parent.sessionId,
            )
          }
          if (e.stop === 'tool-pending' && e.pending !== undefined) {
            const refs = pendingRefs(e.pending)
            await emit(ctx, 'pending-changed', {
              turnId: e.turnId,
              ...(e.messageId === undefined ? {} : { messageId: e.messageId }),
              ...refs,
              ...parentOf(ctx),
            })
          } else if (e.kind === 'respond' || e.kind === 'regenerate' || e.kind === 'edit') {
            // the turn consumed the pending state: nothing waits any more
            await emit(ctx, 'pending-changed', {
              turnId: e.turnId,
              ...(e.messageId === undefined ? {} : { messageId: e.messageId }),
              waiting: [],
              answered: [],
              ...parentOf(ctx),
            })
          }
        },

        'approval.decided': async (
          ctx: HarnessContext,
          d: {
            toolName: string
            toolCallId: string
            approved: boolean
            by: string
            approvalId?: string
            reason?: string
            actor?: { id: string }
          },
        ) => {
          // automatic approvals are noise; answers of people and every denial are not
          if (d.by !== 'user' && d.approved) return
          await emit(ctx, 'approval-decided', {
            toolName: d.toolName,
            toolCallId: d.toolCallId,
            approved: d.approved,
            by: d.by,
            ...(d.approvalId === undefined ? {} : { id: d.approvalId }),
            ...(d.actor === undefined ? {} : { actor: d.actor.id }),
            ...(d.reason === undefined ? {} : { reason: d.reason }),
          })
        },

        'message.saved': async (ctx: HarnessContext, messages: HarnessUIMessage[]) => {
          const seen = new Set<string>()
          for (const m of messages) {
            if (seen.has(m.id)) continue
            seen.add(m.id)
            const eh = m.metadata?.eharness
            const kind = eh?.kind
            if (withMessages) {
              await emit(ctx, 'message-saved', {
                messageId: m.id,
                role: m.role,
                ...(kind === undefined ? {} : { kind }),
                ...(eh?.stop === undefined ? {} : { stop: eh.stop }),
                ...(eh?.turnId === undefined ? {} : { turnId: eh.turnId }),
              })
            }
            if (kind === 'eh.notice') {
              const part = m.parts.find((p) => p.type === 'data-eh.notice') as
                | { data?: { code?: string } }
                | undefined
              if (part?.data?.code === 'EH_TURN_INTERRUPTED') {
                await emit(ctx, 'session-recovered', {
                  ...(eh?.turnId === undefined ? {} : { turnId: eh.turnId }),
                  messageId: m.id,
                  reason: 'interrupted' as const,
                })
              }
            }
          }
        },

        'compaction.after': async (ctx: HarnessContext, e: { marker: HarnessUIMessage }) => {
          const part = e.marker.parts.find((p) => p.type === 'data-eh.compaction') as
            | { data?: { trigger?: string; tokens?: { before: number; after: number } } }
            | undefined
          await emit(ctx, 'compaction', {
            markerId: e.marker.id,
            ...(part?.data?.trigger === undefined ? {} : { trigger: part.data.trigger }),
            ...(part?.data?.tokens === undefined ? {} : { tokens: part.data.tokens }),
          })
        },
      },
    }),
  })
}
