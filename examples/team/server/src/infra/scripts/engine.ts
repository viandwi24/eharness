/**
 * The scripts engine (P59 W4–W5, ADR-0065): runs scripts and listens for what starts them.
 *
 *  - Runs: the executor (`executor.ts`) with the host of `host.ts`; every run (real or dry) leaves a
 *    trace in `script_runs` with the message text removed. At most `concurrency` runs at once, one
 *    queue per script (at most 20 waiting; more are skipped as `busy`).
 *  - Channel events: the gateway's `onEvent` hook, matched against the channel triggers of active
 *    scripts. Table changes: the `onTableRows` hook of the tables use cases. Schedules: the routine
 *    service calls `fireSchedule` for `sys:script:<id>` routines.
 *  - Gates before an automatic run: Pause all, the loop guard (events the script or the agent
 *    itself caused), freshness, cooldown, runs per hour. A skip is logged at most once a minute per
 *    script and reason. Failing `MAX_CONSECUTIVE_FAILURES` runs in a row switches the script off and
 *    raises an alarm.
 *
 * Each event reaches only the instance that observed it (the instance running the chat transport,
 * the one that changed the table, the one that claimed the routine slot), so nothing runs twice
 * across instances.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { ActivityRecord, ActivityStore } from 'eharness/activity'
import { raiseAlarm } from '../../app/alarms.ts'
import type { Deps, ScriptRunnerPort } from '../../app/ports.ts'
import { getRow } from '../../app/tables.ts'
import {
  APP_TRIGGER_TYPES,
  appMismatch,
  CHANNEL_EVENT_TYPES,
  type ChannelEventType,
  channelMismatch,
  gateOf,
  MAX_CONSECUTIVE_FAILURES,
  parseManifest,
  type Role,
  type ScriptAppEvent,
  type ScriptAttachment,
  type ScriptChannelEvent,
  type ScriptEntity,
  type ScriptForward,
  type ScriptManifest,
  type ScriptStructured,
  type SkipReason,
} from '../../domain/script-manifest.ts'
import {
  type HostMethodDoc,
  type RunTrigger,
  type Script,
  type ScriptRun,
  type ScriptVersion,
  scriptTypes,
} from '../../domain/scripts.ts'
import type { TableRowsChange } from '../../domain/tables.ts'
import type { HandleResult } from '../channels/gateway/types.ts'
import { type ChannelGateway, OWN_TYPED } from '../channels/gateway.ts'
import type { RemoteEvent } from '../channels/types.ts'
import { checkScript } from './check.ts'
import { runScript } from './executor.ts'
import { buildHost, HOST_METHODS, type HostContext, SIDE_EFFECTS } from './host.ts'
import { prepareScript } from './prepare.ts'

export interface ScriptEngineOptions {
  /** Late-bound app deps. */
  app: () => Deps | undefined
  gateway: () => ChannelGateway | undefined
  wake: HostContext['wake']
  /** Pause all. */
  paused: () => boolean
  /** Development only: `http.*` may call plain http and private hosts (`TEAM_SCRIPTS_ALLOW_PRIVATE_FETCH=1`). */
  allowPrivateFetch?: boolean
  fetch?: typeof fetch
  resolveHost?: (host: string) => Promise<string[]>
  /** Signs webhook URLs (stable across restarts when TEAM_SECRET_KEY or the vault key is set). */
  webhookSecret?: string
  /** The team API in-process for `ctx.api` (main.ts). */
  callApi?: HostContext['callApi']
  /** Runs at once across scripts (read for every run, so Settings apply at once). Default 4. */
  concurrency?: () => number
  /** How long to wait for the rest of an album before one event goes out (ms). Default 1500. */
  albumWaitMs?: number
  log?: { warn(message: string): void }
}

export interface ChannelEventInfo {
  connectionId: string
  event: RemoteEvent
  eventId: string
  nodeId: string | null
  result: HandleResult
}

export interface ScriptEngine extends ScriptRunnerPort {
  onChannelEvent(info: ChannelEventInfo): void
  onTableRows(change: TableRowsChange): void
  fireSchedule(scriptId: string, slot: number): Promise<{ ran: boolean; reason?: string }>
  /** An app event was appended on this instance (main.ts wraps the event appender). */
  onAppEvent(event: ScriptAppEvent): void
  /** A POST to the script's webhook: a real run of the active version, awaited (the caller gets the result). */
  fireWebhook(
    scriptId: string,
    event: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }>
  /** The secret webhook URL path of a script (`/hooks/scripts/<id>/<token>`). */
  webhookPath(scriptId: string): Promise<string>
  /** Whether a token belongs to the script. */
  webhookOk(scriptId: string, token: string): Promise<boolean>
  /** Resolves when every queued run has finished (tests, shutdown). */
  idle(): Promise<void>
  /** Shutdown: no new automatic runs; waits up to `ms` for the running ones. */
  stop(ms?: number): Promise<void>
}

const MAX_WAITING = 20
const SKIP_LOG_MS = 60_000
const TABLE_EVENT_ROWS = 20
const ALBUM_WAIT_MS = 1500
/** Telegram albums hold at most 10 items. */
const MAX_ALBUM = 10

/** The event as the trace keeps it: no message text (only its length), album captions too. */
function storedEvent(event: unknown): unknown {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return event
  const e = event as Record<string, unknown>
  const album = Array.isArray(e.album) ? { album: e.album.map(storedEvent) } : {}
  if (typeof e.text !== 'string') return { ...e, ...album }
  const { text, ...rest } = e
  return { ...rest, ...album, textLength: (text as string).length }
}

type RawAttachment = Omit<ScriptAttachment, 'fetch'> & { fetch?: unknown }

/** A transport attachment as scripts see it (no functions, no absent fields). */
function scriptAttachmentOf(a: RawAttachment): ScriptAttachment {
  const out: ScriptAttachment = { id: a.id, kind: a.kind }
  for (const k of [
    'media',
    'name',
    'mediaType',
    'size',
    'width',
    'height',
    'duration',
    'ref',
  ] as const) {
    const v = a[k]
    if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v
  }
  if (a.sticker !== undefined) out.sticker = { ...a.sticker }
  return out
}

function scriptForwardOf(f: Record<string, unknown>): ScriptForward {
  const out: ScriptForward = {}
  for (const k of ['name', 'chat', 'user', 'messageId'] as const)
    if (typeof f[k] === 'string') out[k] = f[k] as string
  if (typeof f.at === 'number') out.at = f.at
  return out
}

/** Messages of one album in one event: the first carries the caption, `album` lists each. */
export function mergeAlbum(events: ScriptChannelEvent[]): ScriptChannelEvent {
  const sorted = [...events].sort(
    (a, b) =>
      a.at - b.at ||
      Number(a.messageId ?? 0) - Number(b.messageId ?? 0) ||
      (a.messageId ?? '').localeCompare(b.messageId ?? ''),
  )
  const first = sorted[0] as ScriptChannelEvent
  const captioned = sorted.find((e) => e.text !== undefined && e.text !== '')
  const attachments = sorted.flatMap((e) => e.attachments ?? [])
  const entities = captioned?.entities
  const { text: _t, entities: _e, attachments: _a, ...base } = first
  return {
    ...base,
    ...(captioned?.text === undefined ? {} : { text: captioned.text }),
    ...(entities === undefined ? {} : { entities }),
    ...(attachments.length === 0 ? {} : { attachments }),
    album: sorted.map((e) => ({
      messageId: e.messageId ?? '',
      ...(e.text === undefined || e.text === '' ? {} : { text: e.text }),
      ...(e.attachments === undefined ? {} : { attachments: e.attachments }),
      ...(e.entities === undefined ? {} : { entities: e.entities }),
    })),
  }
}

export function createScriptEngine(o: ScriptEngineOptions): ScriptEngine {
  const log = o.log ?? { warn: (m: string) => console.warn(m) }
  const manifests = new Map<string, ScriptManifest>()
  const queues = new Map<string, { tail: Promise<void>; waiting: number }>()
  const skipLogged = new Map<string, number>()
  const all = new Set<Promise<unknown>>()
  let running = 0
  let stopped = false
  /** The script whose `ctx.api` call is running (events it causes do not start it again). */
  const apiCaller = new AsyncLocalStorage<string>()
  const hookKey = crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`scripts-webhook|${o.webhookSecret ?? crypto.randomUUID()}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const hookToken = async (scriptId: string): Promise<string> => {
    const sig = new Uint8Array(
      await crypto.subtle.sign('HMAC', await hookKey, new TextEncoder().encode(scriptId)),
    )
    return btoa(String.fromCharCode(...sig.slice(0, 24)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  }
  const slots: Array<() => void> = []
  const limit = (): number => Math.max(1, o.concurrency?.() ?? 4)

  const acquire = async (): Promise<void> => {
    if (running < limit()) {
      running++
      return
    }
    // release() counts the run before it wakes the waiter
    await new Promise<void>((resolve) => slots.push(resolve))
  }
  const release = (): void => {
    running--
    while (running < limit() && slots.length > 0) {
      running++
      slots.shift()?.()
    }
  }
  const track = <T>(p: Promise<T>): Promise<T> => {
    all.add(p)
    void p.finally(() => all.delete(p)).catch(() => undefined)
    return p
  }

  const app = (): Deps => {
    const d = o.app()
    if (d === undefined) throw new Error('the app is not ready')
    return d
  }

  const manifestOf = (v: ScriptVersion): ScriptManifest | undefined => {
    const key = `${v.scriptId}:${v.version}`
    let m = manifests.get(key)
    if (m === undefined) {
      const parsed = parseManifest(v.manifest)
      if (!parsed.ok) return undefined
      m = parsed.value
      manifests.set(key, m)
    }
    return m
  }

  /** Active scripts with their running version and manifest. */
  const active = (): Array<{
    script: Script
    version: ScriptVersion
    manifest: ScriptManifest
  }> => {
    const d = o.app()
    if (d === undefined) return []
    const out: Array<{ script: Script; version: ScriptVersion; manifest: ScriptManifest }> = []
    for (const s of d.scripts.list()) {
      if (s.status !== 'active' || s.activeVersion === null) continue
      const v = d.scripts.version(s.id, s.activeVersion)
      if (v === undefined) continue
      const m = manifestOf(v)
      if (m !== undefined) out.push({ script: s, version: v, manifest: m })
    }
    return out
  }

  const recordSkip = (
    script: Script,
    version: number,
    trigger: RunTrigger,
    reason: SkipReason | 'busy',
    event: unknown,
  ): void => {
    const key = `${script.id}:${reason}`
    const now = Date.now()
    if (now - (skipLogged.get(key) ?? 0) < SKIP_LOG_MS) return
    skipLogged.set(key, now)
    const d = o.app()
    d?.scripts.recordRun({
      id: d.ids.next(),
      scriptId: script.id,
      version,
      trigger,
      dryRun: false,
      outcome: 'skipped',
      reason,
      error: null,
      event: storedEvent(event),
      result: null,
      logs: [],
      calls: [],
      durationMs: 0,
      cpuMs: 0,
      startedBy: trigger,
      startedAt: now,
    })
  }

  async function execute(input: {
    script: Script
    version: ScriptVersion
    trigger: RunTrigger
    event: unknown
    dryRun: boolean
    startedBy: string
    channelEvent?: ScriptChannelEvent
  }): Promise<ScriptRun> {
    const d = app()
    const runId = d.ids.next()
    const startedAt = d.clock.now()
    const manifest = manifestOf(input.version)
    const base = {
      id: runId,
      scriptId: input.script.id,
      version: input.version.version,
      trigger: input.trigger,
      dryRun: input.dryRun,
      event: storedEvent(input.event),
      startedBy: input.startedBy,
      startedAt,
    }
    if (manifest === undefined) {
      const run: ScriptRun = {
        ...base,
        outcome: 'error',
        reason: null,
        error: 'the manifest of this version is not valid',
        result: null,
        logs: [],
        calls: [],
        durationMs: 0,
        cpuMs: 0,
      }
      d.scripts.recordRun(run)
      return run
    }
    await acquire()
    let run: ScriptRun
    try {
      const host = buildHost({
        deps: d,
        script: input.script,
        manifest,
        channelEvent: input.channelEvent,
        event: input.event,
        runId,
        gateway: o.gateway,
        wake: o.wake,
        ...(o.allowPrivateFetch === undefined ? {} : { allowPrivateFetch: o.allowPrivateFetch }),
        ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
        ...(o.resolveHost === undefined ? {} : { resolveHost: o.resolveHost }),
        ...(o.callApi === undefined
          ? {}
          : { callApi: (req) => apiCaller.run(input.script.id, () => o.callApi!(req)) }),
      })
      const r = await runScript({
        source: input.version.source,
        event: input.event,
        host,
        limits: manifest.limits,
        ...(input.dryRun ? { dryRun: { sideEffects: SIDE_EFFECTS } } : {}),
      })
      run = {
        ...base,
        outcome: r.outcome,
        reason: null,
        error: r.error ?? null,
        result: r.result ?? null,
        logs: r.logs,
        calls: r.calls,
        durationMs: r.durationMs,
        cpuMs: r.cpuMs,
      }
    } catch (error) {
      run = {
        ...base,
        outcome: 'error',
        reason: null,
        error: error instanceof Error ? error.message : String(error),
        result: null,
        logs: [],
        calls: [],
        durationMs: 0,
        cpuMs: 0,
      }
    } finally {
      release()
    }
    d.scripts.recordRun(run)
    d.events.append({
      type: 'scripts-changed',
      payload: {
        script: input.script.name,
        scriptId: input.script.id,
        change: input.dryRun ? 'dry-run' : 'ran',
        outcome: run.outcome,
      },
    })
    if (!input.dryRun && run.outcome !== 'ok') afterFailure(d, input.script.id, run)
    return run
  }

  /** A script failing too many runs in a row is switched off; the owner hears about it. */
  function afterFailure(d: Deps, scriptId: string, run: ScriptRun): void {
    const s = d.scripts.get(scriptId)
    if (
      s === undefined ||
      s.status !== 'active' ||
      s.consecutiveFailures < MAX_CONSECUTIVE_FAILURES
    )
      return
    d.scripts.update(s.id, { status: 'disabled', disabledReason: 'failures' }, d.clock.now())
    if (s.routineId !== null) {
      d.routines.delete(s.routineId)
      d.scripts.update(s.id, { routineId: null }, d.clock.now())
    }
    raiseAlarm(d, {
      kind: 'run-failed',
      key: `script:${s.id}:${run.id}`,
      subject: `script:${s.name}`,
      agentId: s.agentId,
      text: `Script "${s.name}" failed ${s.consecutiveFailures} runs in a row and was switched off. Last error: ${run.error ?? run.outcome}. Fix it on the Scripts page, then turn it on again.`,
    })
    d.events.append({
      type: 'scripts-changed',
      payload: { script: s.name, scriptId: s.id, change: 'disabled', reason: 'failures' },
    })
  }

  /** Queue an automatic run behind the script's earlier runs. */
  function enqueue(input: Parameters<typeof execute>[0]): void {
    const q = queues.get(input.script.id) ?? { tail: Promise.resolve(), waiting: 0 }
    queues.set(input.script.id, q)
    if (q.waiting >= MAX_WAITING) {
      recordSkip(input.script, input.version.version, input.trigger, 'busy', input.event)
      return
    }
    q.waiting++
    const next = q.tail.then(async () => {
      q.waiting--
      try {
        await execute(input)
      } catch (error) {
        log.warn(
          `scripts: a run of ${input.script.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    })
    q.tail = next
    track(next)
  }

  const gate = (
    script: Script,
    manifest: ScriptManifest,
    eventAt: number | null,
    selfCaused: boolean,
  ): SkipReason | undefined => {
    const d = o.app()
    if (d === undefined) return 'disabled'
    const now = d.clock.now()
    return gateOf(manifest, {
      now,
      paused: o.paused(),
      lastRunAt: script.lastRunAt,
      runsLastHour: d.scripts.runsSince(script.id, now - 3_600_000),
      eventAt,
      selfCaused,
    })
  }

  function toChannelEvent(info: ChannelEventInfo): ScriptChannelEvent | undefined {
    const e = info.event
    if (!(CHANNEL_EVENT_TYPES as readonly string[]).includes(e.type)) return undefined
    const gw = o.gateway()
    const node = info.nodeId === null ? undefined : gw?.nodes.get(info.nodeId)
    const room = node === undefined || gw === undefined ? undefined : gw.roomOf(node)
    const msg =
      'message' in e
        ? (e.message as {
            nativeId?: string
            text?: string
            sender?: { id: string; name?: string; username?: string; isSelf?: boolean }
            replyTo?: { messageId: string; senderId?: string; senderName?: string }
            attachments?: RawAttachment[]
            entities?: ScriptEntity[]
            forwardOf?: Record<string, unknown>
            groupId?: string
            content?: ScriptStructured
          })
        : undefined
    const actor = e.actor ?? msg?.sender
    const role =
      actor === undefined || gw === undefined
        ? undefined
        : gw.people.get(info.connectionId, actor.id, node?.id)?.role
    return {
      type: e.type as ChannelEventType,
      connectionId: info.connectionId,
      eventId: info.eventId,
      at: e.at,
      ...(node === undefined
        ? {}
        : {
            chat: {
              nodeId: node.id,
              nativeId: node.nativeId,
              title: node.title,
              rootNativeId: room?.nativeId ?? node.nativeId,
              rootTitle: room?.title ?? node.title,
            },
          }),
      ...(actor === undefined
        ? {}
        : {
            actor: {
              id: actor.id,
              ...(actor.name === undefined ? {} : { name: actor.name }),
              ...(actor.username === undefined ? {} : { username: actor.username }),
              ...(role === undefined ? {} : { role: role as Role }),
              ...(actor.isSelf ? { isSelf: true } : {}),
            },
          }),
      ...(msg?.text === undefined ? {} : { text: msg.text }),
      ...(msg?.attachments === undefined || msg.attachments.length === 0
        ? {}
        : {
            attachments: msg.attachments.map(scriptAttachmentOf),
          }),
      ...(msg?.entities === undefined || msg.entities.length === 0
        ? {}
        : { entities: msg.entities.map((x) => ({ ...x })) }),
      ...(msg?.forwardOf === undefined ? {} : { forward: scriptForwardOf(msg.forwardOf) }),
      ...(msg?.groupId === undefined ? {} : { groupId: msg.groupId }),
      ...(msg?.content === undefined ? {} : { content: structuredClone(msg.content) }),
      ...(msg?.replyTo === undefined
        ? {}
        : {
            replyTo: {
              messageId: msg.replyTo.messageId,
              ...(msg.replyTo.senderId === undefined ? {} : { senderId: msg.replyTo.senderId }),
              ...(msg.replyTo.senderName === undefined
                ? {}
                : { senderName: msg.replyTo.senderName }),
            },
          }),
      ...(msg?.nativeId !== undefined
        ? { messageId: msg.nativeId }
        : 'messageNativeId' in e
          ? { messageId: String((e as { messageNativeId: string }).messageNativeId) }
          : {}),
      ...('emoji' in e ? { emoji: String((e as { emoji: string }).emoji) } : {}),
    }
  }

  /** Albums waiting for their other items. */
  const albums = new Map<
    string,
    { events: ScriptChannelEvent[]; info: ChannelEventInfo; timer: ReturnType<typeof setTimeout> }
  >()
  function flushAlbum(key: string): void {
    const open = albums.get(key)
    if (open === undefined) return
    albums.delete(key)
    clearTimeout(open.timer)
    if (stopped) return
    try {
      dispatchChannel(mergeAlbum(open.events), open.info)
    } catch (error) {
      log.warn(
        `scripts: an album could not be handled: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  function dispatchChannel(ev: ScriptChannelEvent, info: ChannelEventInfo): void {
    const scripts = active().filter((a) => a.manifest.triggers.some((t) => t.kind === 'channel'))
    for (const a of scripts) {
      const matched = a.manifest.triggers.some(
        (t) => t.kind === 'channel' && channelMismatch(t, ev) === undefined,
      )
      if (!matched) continue
      // what the app itself sent never starts a script (loop guard); what a person typed on the
      // connected account from their phone does (a user account used by its owner too)
      const typedByPerson = info.result.action === 'drop' && info.result.reason === OWN_TYPED
      const selfCaused =
        !typedByPerson &&
        (ev.actor?.isSelf === true ||
          ('message' in info.event &&
            (info.event.message as { direction?: string }).direction === 'out'))
      const skip = gate(a.script, a.manifest, ev.at, selfCaused)
      if (skip !== undefined) {
        recordSkip(a.script, a.version.version, 'channel', skip, ev)
        continue
      }
      enqueue({
        script: a.script,
        version: a.version,
        trigger: 'channel',
        event: ev,
        dryRun: false,
        startedBy: 'channel',
        channelEvent: ev,
      })
    }
  }

  return {
    run: (input) =>
      track(
        execute(
          input.trigger === 'channel'
            ? { ...input, channelEvent: input.event as ScriptChannelEvent }
            : input,
        ),
      ),
    check(source) {
      const p = prepareScript(source)
      return p.ok ? undefined : p.error
    },
    types: () => scriptTypes(HOST_METHODS),
    checkCode: (source, manifest) =>
      checkScript({ source, manifest, types: scriptTypes(HOST_METHODS) }),
    methods: (): readonly HostMethodDoc[] => HOST_METHODS,

    onChannelEvent(info) {
      if (stopped) return
      try {
        if (!active().some((a) => a.manifest.triggers.some((t) => t.kind === 'channel'))) return
        const ev = toChannelEvent(info)
        if (ev === undefined) return
        // an album arrives as one message per item: wait a moment and start scripts once
        if (ev.type === 'message.created' && ev.groupId !== undefined) {
          const key = `${ev.connectionId}|${ev.chat?.nodeId ?? ''}|${ev.groupId}`
          const open = albums.get(key)
          if (open !== undefined) {
            open.events.push(ev)
            if (open.events.length >= MAX_ALBUM) flushAlbum(key)
            return
          }
          albums.set(key, {
            events: [ev],
            info,
            timer: setTimeout(() => flushAlbum(key), o.albumWaitMs ?? ALBUM_WAIT_MS),
          })
          return
        }
        dispatchChannel(ev, info)
      } catch (error) {
        log.warn(
          `scripts: a channel event could not be handled: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },

    onTableRows(change) {
      if (stopped) return
      try {
        const scripts = active().filter((a) =>
          a.manifest.triggers.some(
            (t) => t.kind === 'table' && t.table === change.table && t.events.includes(change.kind),
          ),
        )
        if (scripts.length === 0) return
        const d = app()
        const rows =
          change.kind === 'row.deleted'
            ? []
            : change.rowIds.slice(0, TABLE_EVENT_ROWS).flatMap((id) => {
                try {
                  const r = getRow(d, change.tableId, id)
                  return [{ id: r.id, version: r.version, data: r.data }]
                } catch {
                  return []
                }
              })
        const event = {
          type: change.kind,
          table: change.table,
          rowIds: change.rowIds,
          rows,
          by: change.by,
        }
        for (const a of scripts) {
          const skip = gate(
            a.script,
            a.manifest,
            Date.now(),
            change.by === `script:${a.script.name}`,
          )
          if (skip !== undefined) {
            recordSkip(a.script, a.version.version, 'table', skip, event)
            continue
          }
          enqueue({
            script: a.script,
            version: a.version,
            trigger: 'table',
            event,
            dryRun: false,
            startedBy: 'table',
          })
        }
      } catch (error) {
        log.warn(
          `scripts: a table change could not be handled: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },

    onAppEvent(event) {
      if (stopped) return
      try {
        const caller = apiCaller.getStore()
        for (const a of active()) {
          const matched = a.manifest.triggers.some(
            (t) => t.kind === 'app' && appMismatch(t, event) === undefined,
          )
          if (!matched) continue
          const skip = gate(a.script, a.manifest, event.at, caller === a.script.id)
          if (skip !== undefined) {
            recordSkip(a.script, a.version.version, 'app', skip, event)
            continue
          }
          enqueue({
            script: a.script,
            version: a.version,
            trigger: 'app',
            event,
            dryRun: false,
            startedBy: 'app',
          })
        }
      } catch (error) {
        log.warn(
          `scripts: an app event could not be handled: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },

    async fireWebhook(scriptId, event) {
      if (stopped) return { status: 503, body: { error: 'the server is stopping' } }
      const a = active().find((x) => x.script.id === scriptId)
      if (a === undefined || !a.manifest.triggers.some((t) => t.kind === 'webhook'))
        return { status: 404, body: { error: 'no such webhook' } }
      const skip = gate(a.script, a.manifest, null, false)
      if (skip !== undefined) {
        recordSkip(a.script, a.version.version, 'webhook', skip, event)
        return { status: skip === 'paused' ? 503 : 429, body: { error: `skipped: ${skip}` } }
      }
      const run = await track(
        execute({
          script: a.script,
          version: a.version,
          trigger: 'webhook',
          event,
          dryRun: false,
          startedBy: 'webhook',
        }),
      )
      return run.outcome === 'ok'
        ? { status: 200, body: { ok: true, result: run.result ?? null, runId: run.id } }
        : { status: 500, body: { ok: false, error: run.error ?? run.outcome, runId: run.id } }
    },

    async fireSchedule(scriptId, slot) {
      if (stopped) return { ran: false, reason: 'the server is stopping' }
      const a = active().find((x) => x.script.id === scriptId)
      if (a === undefined) return { ran: false, reason: 'the script is not active' }
      const skip = gate(a.script, a.manifest, null, false)
      if (skip !== undefined) {
        recordSkip(a.script, a.version.version, 'schedule', skip, { slot })
        return { ran: false, reason: skip }
      }
      const run = await track(
        execute({
          script: a.script,
          version: a.version,
          trigger: 'schedule',
          event: { type: 'schedule', slot, firedAt: Date.now() },
          dryRun: false,
          startedBy: 'schedule',
        }),
      )
      return { ran: true, ...(run.outcome === 'ok' ? {} : { reason: run.error ?? run.outcome }) }
    },

    async webhookPath(scriptId) {
      return `/hooks/scripts/${encodeURIComponent(scriptId)}/${await hookToken(scriptId)}`
    },

    async webhook(scriptId, token, event) {
      if (!(await this.webhookOk(scriptId, token)))
        return { status: 404, body: { error: 'no such webhook' } }
      return this.fireWebhook(scriptId, event)
    },

    async webhookOk(scriptId, token) {
      const want = await hookToken(scriptId)
      if (token.length !== want.length) return false
      let diff = 0
      for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ token.charCodeAt(i)
      return diff === 0
    },

    async idle() {
      while (all.size > 0) await Promise.allSettled([...all])
    },

    async stop(ms = 10_000) {
      stopped = true
      for (const a of albums.values()) clearTimeout(a.timer)
      albums.clear()
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        this.idle(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms)
        }),
      ])
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}

/** App event types scripts may start on, as a set (the activity watcher filters with it). */
export const APP_TRIGGER_SET: ReadonlySet<string> = new Set(APP_TRIGGER_TYPES)

/** An activity store that also hands every appended record to `onRecord` (never awaited, never throws). */
export function watchScriptEvents(
  inner: ActivityStore,
  onRecord: (record: ActivityRecord) => void,
): ActivityStore {
  return {
    ...inner,
    append: async (events) => {
      const records = await inner.append(events)
      for (const r of records) {
        try {
          onRecord(r)
        } catch {
          // a script problem never breaks the feed
        }
      }
      return records
    },
    read: (q) => inner.read(q),
    lastSeq: () => inner.lastSeq(),
    prunedThrough: () => inner.prunedThrough(),
    prune: (o) => inner.prune(o),
  }
}
