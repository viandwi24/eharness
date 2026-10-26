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
import { raiseAlarm } from '../../app/alarms.ts'
import type { Deps, ScriptRunnerPort } from '../../app/ports.ts'
import { getRow } from '../../app/tables.ts'
import {
  CHANNEL_EVENT_TYPES,
  type ChannelEventType,
  channelMismatch,
  gateOf,
  MAX_CONSECUTIVE_FAILURES,
  parseManifest,
  type Role,
  type ScriptChannelEvent,
  type ScriptManifest,
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
import type { ChannelGateway } from '../channels/gateway.ts'
import type { RemoteEvent } from '../channels/types.ts'
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
  /** Runs at once across scripts. Default 4. */
  concurrency?: number
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
  /** Resolves when every queued run has finished (tests, shutdown). */
  idle(): Promise<void>
  /** Shutdown: no new automatic runs; waits up to `ms` for the running ones. */
  stop(ms?: number): Promise<void>
}

const MAX_WAITING = 20
const SKIP_LOG_MS = 60_000
const TABLE_EVENT_ROWS = 20

/** The event as the trace keeps it: no message text (only its length). */
function storedEvent(event: unknown): unknown {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return event
  const e = event as Record<string, unknown>
  if (typeof e.text !== 'string') return event
  const { text, ...rest } = e
  return { ...rest, textLength: (text as string).length }
}

export function createScriptEngine(o: ScriptEngineOptions): ScriptEngine {
  const log = o.log ?? { warn: (m: string) => console.warn(m) }
  const manifests = new Map<string, ScriptManifest>()
  const queues = new Map<string, { tail: Promise<void>; waiting: number }>()
  const skipLogged = new Map<string, number>()
  const all = new Set<Promise<unknown>>()
  let running = 0
  let stopped = false
  const slots: Array<() => void> = []
  const limit = Math.max(1, o.concurrency ?? 4)

  const acquire = async (): Promise<void> => {
    if (running < limit) {
      running++
      return
    }
    await new Promise<void>((resolve) => slots.push(resolve))
    running++
  }
  const release = (): void => {
    running--
    slots.shift()?.()
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
      ...(msg?.nativeId !== undefined
        ? { messageId: msg.nativeId }
        : 'messageNativeId' in e
          ? { messageId: String((e as { messageNativeId: string }).messageNativeId) }
          : {}),
      ...('emoji' in e ? { emoji: String((e as { emoji: string }).emoji) } : {}),
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
    methods: (): readonly HostMethodDoc[] => HOST_METHODS,

    onChannelEvent(info) {
      if (stopped) return
      try {
        const scripts = active().filter((a) =>
          a.manifest.triggers.some((t) => t.kind === 'channel'),
        )
        if (scripts.length === 0) return
        const ev = toChannelEvent(info)
        if (ev === undefined) return
        for (const a of scripts) {
          const matched = a.manifest.triggers.some(
            (t) => t.kind === 'channel' && channelMismatch(t, ev) === undefined,
          )
          if (!matched) continue
          const selfCaused =
            ev.actor?.isSelf === true ||
            ('message' in info.event &&
              (info.event.message as { direction?: string }).direction === 'out')
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

    async idle() {
      while (all.size > 0) await Promise.allSettled([...all])
    },

    async stop(ms = 10_000) {
      stopped = true
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
