/**
 * `taskIndex` plugin (docs/plans/P32-team-example.md §6.4): turn and approval hooks write the
 * `tasks` index (one row per task session) and the append-only `events` feed, on whichever
 * instance runs the turn. Nothing here is a source of truth: the sessions are, and the drift
 * pass (`team-service.ts`) repairs rows a crashed instance never closed.
 *
 *  - `turn.start`   task session: row created / back to `running`; DM chat: `message-added` (user)
 *  - `turn.end`     task session: status from the stop reason (+ cost, summary, pending kind);
 *                   DM chat: `message-added` (assistant, preview for the sidebar);
 *                   `approval-needed` for every pending approval / question
 *  - `approval.decided`  `approval-decided` (user answers and denials)
 *  - `tool.after`   `agent-message` when an agent sent `send_message`
 *
 * A session is a DM chat when its id starts with `dm:`, a task when it has a `parent` (delegated
 * by the lead) or starts with `routine:` (M7). Hook errors are logged, never thrown.
 */
import { definePlugin, type HarnessContext, type HarnessPlugin, type PendingState } from 'eharness'
import { isDmSession } from '../../domain/chat.ts'
import { previewOf, statusFromStop, titleFromText } from '../../domain/tasks.ts'
import type { TaskWriter } from '../db/tasks-repo.ts'

export interface TaskIndexOptions {
  store: TaskWriter
  /** The agent of a hook context (`ctx.agent.id` is the slug of the definition). */
  agentOf(slug: string): { id: string; name: string } | undefined
  now?: () => number
}

type Part = { type: string; text?: string }
type Message = { role: string; parts: Part[] }

const textOf = (message: Message | undefined): string =>
  (message?.parts ?? [])
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n')
    .trim()

/** Text of an `<agent-message …>…</agent-message>` frame body, else the text itself. */
const unframe = (text: string): string => {
  const m = /^<agent-message\b[^>]*>([\s\S]*?)<\/agent-message>\s*$/.exec(text)
  return m === null ? text : (m[1] ?? '').trim()
}

function pendingKinds(pending: PendingState | undefined): 'approval' | 'question' | null {
  if (pending === undefined) return null
  if (pending.approvals.length > 0) return 'approval'
  if (pending.clientTools.some((c) => c.result === undefined)) return 'question'
  return null
}

function pendingPreview(pending: PendingState | undefined): string {
  if (pending === undefined) return ''
  if (pending.approvals.length > 0) return 'Waiting for your approval'
  if (pending.clientTools.length > 0) return 'Waiting for your answer'
  if ((pending.externals?.length ?? 0) > 0) return 'Waiting for a delegated task'
  return ''
}

export function taskIndex(options: TaskIndexOptions): HarnessPlugin<'task-index'> {
  const { store } = options
  const now = options.now ?? (() => Date.now())

  const guard =
    <A extends unknown[]>(name: string, fn: (ctx: HarnessContext, ...args: A) => void) =>
    (ctx: HarnessContext, ...args: A): void => {
      try {
        fn(ctx, ...args)
      } catch (error) {
        ctx.log.warn(
          `taskIndex ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

  const isTaskSession = (ctx: HarnessContext): boolean =>
    ctx.session.parent !== undefined || ctx.session.id.startsWith('routine:')

  return definePlugin({
    name: 'task-index',
    setup: () => ({
      hooks: {
        'turn.start': guard('turn.start', (ctx, e: { input?: Message }) => {
          const agent = options.agentOf(ctx.agent.id)
          const agentId = agent?.id ?? ctx.agent.id
          const t = now()
          if (isDmSession(ctx.session.id) && !isTaskSession(ctx)) {
            const text = textOf(e.input)
            if (text !== '') {
              store.appendEvent(
                {
                  type: 'message-added',
                  agentId,
                  sessionId: ctx.session.id,
                  payload: { role: 'user', preview: previewOf(unframe(text)) },
                },
                t,
              )
            }
            return
          }
          if (!isTaskSession(ctx)) return
          const before = store.getBySession(ctx.session.id)
          const row = store.ensure({
            agentId,
            sessionId: ctx.session.id,
            parentSessionId: ctx.session.parent?.sessionId ?? null,
            origin: ctx.session.id.startsWith('routine:') ? 'routine' : 'lead',
            title: titleFromText(unframe(textOf(e.input))),
            startedAt: t,
          })
          const next = store.update(ctx.session.id, {
            status: 'running',
            pendingKind: null,
            now: t,
          })
          if (before === undefined || before.status !== 'running') {
            store.appendEvent(
              {
                type: 'task-changed',
                agentId,
                sessionId: ctx.session.id,
                payload: {
                  taskId: row.id,
                  status: 'running',
                  pendingKind: null,
                  title: next?.title ?? row.title,
                  parentSessionId: row.parentSessionId,
                  created: before === undefined,
                },
              },
              t,
            )
          }
        }),

        'turn.end': guard(
          'turn.end',
          (
            ctx,
            e: {
              stop: string
              pending?: PendingState
              messages: Message[]
              messageId?: string
              usage: { totalTokens: number; costUsd?: number }
            },
          ) => {
            const agent = options.agentOf(ctx.agent.id)
            const agentId = agent?.id ?? ctx.agent.id
            const t = now()
            const assistantText = textOf(e.messages.findLast((m) => m.role === 'assistant'))

            if (isDmSession(ctx.session.id) && !isTaskSession(ctx)) {
              store.appendEvent(
                {
                  type: 'message-added',
                  agentId,
                  sessionId: ctx.session.id,
                  payload: {
                    role: 'assistant',
                    preview: previewOf(assistantText) || pendingPreview(e.pending) || `(${e.stop})`,
                    stop: e.stop,
                    ...(e.messageId === undefined ? {} : { messageId: e.messageId }),
                  },
                },
                t,
              )
            } else if (isTaskSession(ctx)) {
              const status = statusFromStop(e.stop)
              const kind = status === 'needs_action' ? pendingKinds(e.pending) : null
              // a `tool-pending` turn that waits on an external wait only (the task's own park)
              // is still running work, not a thing for a person
              const effective = status === 'needs_action' && kind === null ? 'running' : status
              const row = store.update(ctx.session.id, {
                status: effective,
                pendingKind: kind,
                now: t,
                summary: assistantText === '' ? null : previewOf(assistantText, 500),
                addCostUsd: e.usage.costUsd ?? 0,
                addTokens: e.usage.totalTokens,
              })
              if (row !== undefined) {
                store.appendEvent(
                  {
                    type: 'task-changed',
                    agentId: row.agentId,
                    sessionId: ctx.session.id,
                    payload: {
                      taskId: row.id,
                      status: row.status,
                      pendingKind: row.pendingKind,
                      title: row.title,
                      parentSessionId: row.parentSessionId,
                      stop: e.stop,
                    },
                  },
                  t,
                )
              }
            }

            if (e.stop === 'tool-pending' && e.pending !== undefined) {
              for (const a of e.pending.approvals) {
                store.appendEvent(
                  {
                    type: 'approval-needed',
                    agentId,
                    sessionId: ctx.session.id,
                    payload: { kind: 'approval', id: a.approvalId, toolName: a.toolName },
                  },
                  t,
                )
              }
              for (const c of e.pending.clientTools) {
                if (c.result !== undefined) continue
                store.appendEvent(
                  {
                    type: 'approval-needed',
                    agentId,
                    sessionId: ctx.session.id,
                    payload: { kind: 'question', id: c.toolCallId, toolName: c.toolName },
                  },
                  t,
                )
              }
            }
          },
        ),

        'approval.decided': guard(
          'approval.decided',
          (
            ctx,
            d: {
              toolName: string
              approved: boolean
              by: string
              approvalId?: string
              reason?: string
              actor?: { id: string }
            },
          ) => {
            if (d.by !== 'user' && d.approved) return
            const agent = options.agentOf(ctx.agent.id)
            store.appendEvent(
              {
                type: 'approval-decided',
                agentId: agent?.id ?? ctx.agent.id,
                sessionId: ctx.session.id,
                payload: {
                  toolName: d.toolName,
                  approved: d.approved,
                  by: d.by,
                  ...(d.approvalId === undefined ? {} : { id: d.approvalId }),
                  ...(d.actor === undefined ? {} : { actor: d.actor.id }),
                  ...(d.reason === undefined ? {} : { reason: d.reason }),
                },
              },
              now(),
            )
          },
        ),

        'tool.after': guard(
          'tool.after',
          (ctx, e: { toolName: string; input: unknown; output: unknown }) => {
            if (e.toolName !== 'send_message' || typeof e.output !== 'string') return
            if (e.output.startsWith('ERROR') || e.output.startsWith('Not sent')) return
            const input = e.input as { to?: unknown; message?: unknown }
            const agent = options.agentOf(ctx.agent.id)
            store.appendEvent(
              {
                type: 'agent-message',
                agentId: agent?.id ?? ctx.agent.id,
                sessionId: ctx.session.id,
                payload: {
                  from: ctx.agent.id,
                  to: typeof input.to === 'string' ? input.to : '',
                  preview: previewOf(typeof input.message === 'string' ? input.message : ''),
                },
              },
              now(),
            )
          },
        ),
      },
    }),
  })
}
