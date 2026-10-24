/**
 * The trigger engine: listens to the event stream and acts.
 *
 * Two feeds, one path. Channel events arrive from the gateway (`GatewayDeps.onEvent`, with the
 * message text in memory only); app events arrive from the activity store (`tapAppend`). Each event
 * becomes a `StreamEvent`, is matched against the enabled triggers (types, scope, filters), passes
 * the gates (the agent's own doing, Pause all, cooldown, the hourly cap) and runs the action:
 * wake an agent, run a program, notify the owner, or call a signed webhook. Every firing is a row of
 * `trigger_fires` (ok, skipped with a reason, or error) with its duration and the facts of the
 * outcome. Events older than 15 minutes (24 hours for join requests) are ignored: a restart's
 * catch-up must not replay the past.
 *
 * An event is handled on the instance that observed it. Skip rows for a cooldown, a pause, the cap
 * or a loop are written at most once a minute per trigger and reason (the rest are counted in the
 * next row); a filter that did not match is stored only for events that are not high volume.
 */

import { errorText, uuidv7 } from 'eharness'
import type { ActivityRecord, ActivityStore } from 'eharness/activity'
import type { SecretVault } from 'eharness/providers'
import { raiseSystemAlarm } from '../../app/alarms.ts'
import type { Deps, TriggerEnginePort } from '../../app/ports.ts'
import { runProgramNow } from '../../app/programs.ts'
import { createThread, listThreads, threadSessionOf } from '../../app/threads.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  APP_STREAM_TYPES,
  appEventId,
  freshMs,
  HIGH_VOLUME_TYPES,
  type StreamEvent,
  streamTypeOfFeed,
} from '../../domain/event-stream.ts'
import {
  describeEvent,
  GATE_TEXT,
  gateOf,
  type MatchContext,
  matchTrigger,
  type SkipReason,
  type Trigger,
  type TriggerAction,
  type TriggerFire,
  wakeText,
  webhookPayload,
} from '../../domain/triggers.ts'
import type { ChannelGateway } from '../channels/gateway.ts'
import type { SqliteTriggerStore } from '../db/triggers-repo.ts'
import type { createEventStream } from '../events/stream.ts'
import type { WebhookSender } from './webhook.ts'

type Stream = ReturnType<typeof createEventStream>

export interface TriggerEngineOptions {
  store: SqliteTriggerStore
  stream: Stream
  /** Late-bound: the app deps are built after the engine. */
  app: () => Deps | undefined
  /** Late-bound: the gateway is built after the engine. */
  gateway: () => ChannelGateway | undefined
  /** Put the message in the session's inbox and let its agent answer (`session.enqueue`). */
  wake: (input: { agentId: string; sessionId: string; text: string; id: string }) => Promise<void>
  vault: SecretVault
  webhook: WebhookSender
  /** The team timezone for the times in a wake text. */
  time: (at: number) => string
  now?: () => number
  log?: { warn(message: string): void }
}

export interface TriggerEngine extends TriggerEnginePort {
  /** A platform event the gateway handled (new, not a replay). Never throws, never awaited. */
  onChannelEvent(info: {
    connectionId: string
    event: { type: string; message?: { text?: string }; at: number }
    eventId: string
  }): void
  /** App events that were appended to the feed. */
  onAppRecords(records: readonly ActivityRecord[]): void
  /** Resolves when everything in flight has finished (tests, shutdown). */
  idle(): Promise<void>
  /** Delete old firing rows (the Settings retention). */
  prune(): number
}

const SKIP_ROW_EVERY_MS = 60_000
const HOUR_MS = 3_600_000
export const TRIGGERS_THREAD_TITLE = 'Triggers'

/** An `ActivityStore` that tells `onAppended` about what was appended (after it was stored). */
export function tapAppend(
  inner: ActivityStore,
  onAppended: (records: readonly ActivityRecord[]) => void,
): ActivityStore {
  return {
    ...inner,
    append: async (events) => {
      const records = await inner.append(events)
      try {
        onAppended(records)
      } catch {}
      return records
    },
    read: (q) => inner.read(q),
    lastSeq: () => inner.lastSeq(),
    prunedThrough: () => inner.prunedThrough(),
    prune: (o) => inner.prune(o),
  }
}

type Outcome = {
  result: 'ok' | 'error' | 'skipped'
  reason?: string
  detail: Record<string, unknown>
}

export function createTriggerEngine(o: TriggerEngineOptions): TriggerEngine {
  const now = o.now ?? Date.now
  const warn = o.log?.warn ?? ((m) => console.warn(`team: ${m}`))
  const inflight = new Set<Promise<unknown>>()
  /** When each trigger last claimed a firing (before its row is written): the cooldown must not race. */
  const claimed = new Map<string, number>()
  let reserved = 0
  /** Skip rows: last time one was written, and how many were held back since. */
  const skipRows = new Map<string, { at: number; held: number }>()
  const filtered = new Map<string, number>()

  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p)
    void p.then(
      () => inflight.delete(p),
      () => inflight.delete(p),
    )
    return p
  }

  function record(
    t: Trigger,
    ev: StreamEvent,
    startedAt: number,
    out: Outcome,
    id: string = uuidv7(),
  ): void {
    try {
      o.store.recordFire({
        id,
        triggerId: t.id,
        eventId: ev.id,
        eventType: ev.type,
        at: startedAt,
        result: out.result,
        reason: out.reason ?? null,
        actionKind: t.action.kind,
        durationMs: Math.max(0, now() - startedAt),
        detail: out.detail,
      } satisfies TriggerFire)
    } catch (error) {
      warn(`triggers: could not log a firing of ${t.id}: ${errorText(error)}`)
    }
  }

  /** A skip row, at most one a minute per trigger and reason; the held ones are counted in the next. */
  function recordSkip(
    t: Trigger,
    ev: StreamEvent,
    reason: SkipReason,
    extra: Record<string, unknown> = {},
  ): void {
    const key = `${t.id}|${reason}`
    const last = skipRows.get(key)
    const at = now()
    if (last !== undefined && at - last.at < SKIP_ROW_EVERY_MS) {
      last.held++
      return
    }
    skipRows.set(key, { at, held: 0 })
    record(t, ev, at, {
      result: 'skipped',
      reason,
      detail: {
        why: GATE_TEXT[reason],
        ...(last !== undefined && last.held > 0 ? { alsoSkipped: last.held } : {}),
        ...extra,
      },
    })
  }

  // --- actions ---------------------------------------------------------------------------------

  async function wake(
    app: Deps,
    t: Trigger,
    action: Extract<TriggerAction, { kind: 'wake' }>,
    ev: StreamEvent,
    ctx: MatchContext,
    fireId: string,
  ): Promise<Outcome> {
    const def = app.agents.get(action.agentId)
    if (def === undefined || def.archivedAt !== null)
      return {
        result: 'error',
        reason: 'agent',
        detail: { error: 'the agent to wake is gone or archived' },
      }
    let agentId = def.id
    let sessionId: string
    if (action.target === 'chat') {
      const gw = o.gateway()
      const node = ev.chat === undefined ? undefined : gw?.nodes.get(ev.chat.nodeId)
      if (gw === undefined || node === undefined || ev.connectionId === undefined)
        return {
          result: 'error',
          reason: 'target',
          detail: { error: 'this event has no chat, so there is no chat session to wake' },
        }
      const room = gw.roomOf(node)
      const row =
        gw.sessions.get(ev.connectionId, node.id) ??
        gw.sessions.get(ev.connectionId, room.id) ??
        gw.sessions.ensure(
          {
            connectionId: ev.connectionId,
            nodeId: room.id,
            agentId: def.id,
            label: room.title ?? null,
          },
          now(),
        )
      sessionId = row.sessionId
      agentId = row.agentId
    } else if (action.target === 'thread') {
      sessionId = threadSessionOf(app, def)
    } else {
      const own = listThreads(app, def.id).find(
        (x) => x.title === TRIGGERS_THREAD_TITLE && x.source === 'web',
      )
      sessionId = (own ?? createThread(app, def.id, { title: TRIGGERS_THREAD_TITLE })).sessionId
    }
    const text = wakeText(
      t,
      action,
      ev,
      { time: o.time },
      action.includeText === true ? { text: ctx.text } : {},
    )
    await o.wake({ agentId, sessionId, text, id: `trigger:${fireId}` })
    return { result: 'ok', detail: { sessionId, agentId } }
  }

  async function program(
    app: Deps,
    action: Extract<TriggerAction, { kind: 'program' }>,
    ev: StreamEvent,
  ): Promise<Outcome> {
    const p = app.programs.get(action.programId)
    if (p === undefined)
      return {
        result: 'error',
        reason: 'program',
        detail: { error: 'the program no longer exists' },
      }
    try {
      const run = await runProgramNow(app, p.id, {
        eventNote: describeEvent(ev, { time: o.time }),
      })
      if (run.idle)
        return { result: 'ok', detail: { note: 'the program had nothing to do', program: p.name } }
      return {
        result: 'ok',
        detail: {
          program: p.name,
          ...(run.sessionId === null ? {} : { sessionId: run.sessionId }),
          ...(run.taskId === null ? {} : { taskId: run.taskId }),
          ...(run.started ? {} : { note: 'that run already existed' }),
        },
      }
    } catch (error) {
      if (error instanceof DomainError && error.code === 'PROGRAM_BUSY')
        return {
          result: 'skipped',
          reason: 'busy',
          detail: { why: GATE_TEXT.busy, program: p.name },
        }
      return {
        result: 'error',
        reason: 'program',
        detail: { error: errorText(error).slice(0, 300) },
      }
    }
  }

  async function notify(
    app: Deps,
    t: Trigger,
    action: Extract<TriggerAction, { kind: 'notify' }>,
    ev: StreamEvent,
    fireId: string,
  ): Promise<Outcome> {
    const title = action.title ?? `Trigger: ${t.name}`
    const body = `${ev.summary} (${o.time(ev.at)})`
    app.notifications.insert({
      id: app.ids.next(),
      kind: 'alert',
      key: `trigger:${fireId}`,
      title,
      body,
      link: `/events?e=${encodeURIComponent(ev.id)}`,
      agentId: null,
      createdAt: now(),
    })
    app.events.append({ type: 'notification-changed', payload: { kind: 'alert' } })
    const detail: Record<string, unknown> = { bell: true }
    if (action.dm === true) {
      detail.dm = (await app.alarmPush?.push(`${title}: ${body}`)) ?? 'unavailable'
    }
    return { result: 'ok', detail }
  }

  async function webhook(
    t: Trigger,
    action: Extract<TriggerAction, { kind: 'webhook' }>,
    ev: StreamEvent,
    fireId: string,
    startedAt: number,
  ): Promise<Outcome> {
    const sealed = o.store.sealedSecret(t.id)
    if (sealed === null)
      return { result: 'error', reason: 'secret', detail: { error: 'the webhook has no secret' } }
    let secret: string
    try {
      secret = await o.vault.open(sealed, `trigger:${t.id}`)
    } catch {
      return {
        result: 'error',
        reason: 'secret',
        detail: {
          error: 'the webhook secret could not be opened (the server key changed): set it again',
        },
      }
    }
    const r = await o.webhook.send({
      url: action.url,
      secret,
      body: webhookPayload(t, ev, fireId, startedAt),
      deliveryId: fireId,
      eventType: ev.type,
    })
    const detail: Record<string, unknown> = {
      attempts: r.attempts,
      ...(r.status === undefined ? {} : { status: r.status }),
    }
    if (r.ok) return { result: 'ok', detail }
    return {
      result: 'error',
      reason: r.code ?? 'network',
      detail: { ...detail, ...(r.error === undefined ? {} : { error: r.error }) },
    }
  }

  async function execute(t: Trigger, ev: StreamEvent, ctx: MatchContext): Promise<void> {
    const app = o.app()
    const startedAt = now()
    const fireId = uuidv7()
    let out: Outcome
    try {
      if (app === undefined) throw new Error('the app is not ready')
      const a = t.action
      out =
        a.kind === 'wake'
          ? await wake(app, t, a, ev, ctx, fireId)
          : a.kind === 'program'
            ? await program(app, a, ev)
            : a.kind === 'notify'
              ? await notify(app, t, a, ev, fireId)
              : await webhook(t, a, ev, fireId, startedAt)
    } catch (error) {
      out = { result: 'error', reason: 'failed', detail: { error: errorText(error).slice(0, 300) } }
    }
    if (out.result === 'skipped') {
      // an action that declined (a program still running) is a skip: the cooldown does not start
      claimed.delete(t.id)
      recordSkip(t, ev, (out.reason ?? 'busy') as SkipReason, out.detail)
      return
    }
    record(t, ev, startedAt, out, fireId)
    // the stored time of the firing takes over from the claim
    claimed.delete(t.id)
    if (out.result === 'error' && app !== undefined) {
      // a trigger that keeps failing is something the owner should hear about once per day
      const trigger = o.store.get(t.id)
      if (trigger !== undefined && trigger.errorCount > 0 && trigger.errorCount % 10 === 0) {
        raiseSystemAlarm(
          app,
          `trigger:${t.id}`,
          new Error(
            `Trigger "${t.name}" failed ${trigger.errorCount} times: ${String(out.detail.error ?? out.reason)}`,
          ),
        )
      }
    }
  }

  // --- matching ----------------------------------------------------------------------------------

  async function consider(
    app: Deps,
    t: Trigger,
    ev: StreamEvent,
    ctx: MatchContext,
  ): Promise<void> {
    const m = matchTrigger(t, ev, ctx)
    if (!m.matched) {
      if (m.reason !== 'filtered') return
      if ((HIGH_VOLUME_TYPES as readonly string[]).includes(ev.type)) {
        filtered.set(t.id, (filtered.get(t.id) ?? 0) + 1)
        return
      }
      // a filter on a rare event type is a firing worth seeing: it explains why nothing happened
      recordSkip(t, ev, 'filtered', { why: m.why })
      return
    }
    if (m.error !== undefined) {
      record(t, ev, now(), { result: 'error', reason: 'filter', detail: { error: m.error } })
      return
    }
    const at = now()
    const reason = gateOf(t, ev, {
      now: at,
      paused: app.pause.get().pausedAt !== null,
      executedLastHour: o.store.executedSince(at - HOUR_MS) + reserved,
      hourlyCap: app.settings.get().triggersMaxPerHour,
      lastFiredAt: Math.max(t.lastFiredAt ?? 0, claimed.get(t.id) ?? 0) || null,
    })
    if (reason !== undefined) {
      // the agent's own messages and reactions are most of a busy chat: counted, not logged
      if (reason === 'loop' && (HIGH_VOLUME_TYPES as readonly string[]).includes(ev.type)) {
        filtered.set(t.id, (filtered.get(t.id) ?? 0) + 1)
        return
      }
      recordSkip(t, ev, reason)
      return
    }
    claimed.set(t.id, at)
    reserved++
    void track(
      execute(t, ev, ctx)
        .catch((error) => warn(`triggers: ${t.id} failed: ${errorText(error)}`))
        .finally(() => {
          reserved--
        }),
    )
  }

  async function process(ev: StreamEvent, ctx: MatchContext): Promise<void> {
    const app = o.app()
    if (app === undefined) return
    if (now() - ev.at > freshMs(ev.type)) return
    const triggers = o.store.list().filter((t) => t.enabled && t.eventTypes.includes(ev.type))
    for (const t of triggers) {
      try {
        await consider(app, t, ev, ctx)
      } catch (error) {
        warn(`triggers: ${t.id} could not be checked: ${errorText(error)}`)
      }
    }
  }

  return {
    allowPrivateWebhooks: o.webhook.allowPrivate,
    webhookBlocked: (url) => o.webhook.blocked(url),
    filteredCount: (id) => filtered.get(id) ?? 0,

    onChannelEvent(info) {
      // nothing to do without an enabled trigger of this type: skip the lookups
      const type = info.event.type
      if (!o.store.list().some((t) => t.enabled && (t.eventTypes as string[]).includes(type)))
        return
      void track(
        (async () => {
          const ev = await o.stream.channelRow(info.eventId)
          if (ev === undefined) return
          const text =
            ev.type === 'message.created' || ev.type === 'message.edited'
              ? info.event.message?.text
              : undefined
          await process(ev, { text })
        })().catch((error) => warn(`triggers: an event could not be handled: ${errorText(error)}`)),
      )
    },

    onAppRecords(records) {
      const wanted = records.filter((r) => {
        const t = streamTypeOfFeed(r.type)
        return t !== undefined && (APP_STREAM_TYPES as readonly string[]).includes(t)
      })
      if (wanted.length === 0) return
      if (!o.store.list().some((t) => t.enabled)) return
      for (const r of wanted) {
        void track(
          (async () => {
            const ev = await o.stream.get(appEventId(r.seq))
            if (ev !== undefined) await process(ev, {})
          })().catch((error) =>
            warn(`triggers: an app event could not be handled: ${errorText(error)}`),
          ),
        )
      }
    },

    async preflight(t, ev) {
      const app = o.app()
      const problems: string[] = []
      if (app === undefined) return ['the app is not ready']
      const a = t.action
      const gw = o.gateway()
      for (const id of t.scope.connectionIds)
        if (gw?.config(id) === undefined)
          problems.push(`there is no chat connection ${id}, so no chat event can match`)
      if (a.kind === 'wake') {
        const def = app.agents.get(a.agentId)
        if (def === undefined || def.archivedAt !== null)
          problems.push('the agent to wake is gone or archived')
        if (a.target === 'chat' && ev.chat === undefined)
          problems.push('this event has no chat, so there is no chat session to wake')
      } else if (a.kind === 'program') {
        const p = app.programs.get(a.programId)
        if (p === undefined) problems.push('the program no longer exists')
        else if (app.agents.get(p.agentId)?.archivedAt != null)
          problems.push('the program’s agent is archived')
      } else if (a.kind === 'webhook') {
        if (!t.hasSecret) problems.push('the webhook has no secret')
        const blocked = await o.webhook.blocked(a.url)
        if (blocked !== undefined) problems.push(blocked)
      }
      return problems
    },

    idle: async () => {
      while (inflight.size > 0) await Promise.allSettled([...inflight])
    },

    prune() {
      const days = o.app()?.settings.get().triggerLogRetentionDays ?? 0
      return days > 0 ? o.store.pruneFires(now() - days * 86_400_000) : 0
    },
  }
}
