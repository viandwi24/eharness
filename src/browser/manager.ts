/**
 * The browser manager (spec 35 §7): leases (one holder per profile), idle release, the controller
 * flag (agent or human), live view with takeover, runtime passthrough and resource usage. One per
 * process; the plugin and the app's routes share it.
 *
 * Runtime-neutral: timers and Web Streams only. Engines are started through the injected runtimes.
 */
import { errorText, HarnessError, type HarnessLogger } from '../index.ts'
import { scrub, secretValuesOf } from '../providers/form.ts'
import type { BrowserAdapter, BrowserMode, BrowserRegistry } from './adapter.ts'
import { checkUrl, type DomainRules } from './domains.ts'
import type { BrowserProfileStore } from './profiles.ts'
import type { BrowserRuntime, SystemMemory } from './runtime.ts'
import {
  type BrowserCapabilities,
  type BrowserConnection,
  type BrowserEvent,
  type BrowserLimits,
  type BrowserProfile,
  type BrowserUsage,
  type ControllerState,
  DEFAULT_BROWSER_LIMITS,
  type HandBackInfo,
  type Lease,
  type LeaseHolder,
  type LeaseRefusal,
  type LeaseStatus,
  type LiveChannel,
  type LiveFeed,
  type LiveFrame,
  type LiveInput,
  type PageInfo,
} from './types.ts'

/** Options of {@link createBrowserManager}. */
export interface BrowserManagerOptions {
  registry: BrowserRegistry
  profiles: BrowserProfileStore
  limits?: Partial<BrowserLimits>
  /** Memory of the machine the engines run on (`systemMemory` from `eharness/browser/node`). */
  systemMemory?: () => SystemMemory | Promise<SystemMemory>
  /** Clock, epoch ms. Default `Date.now`. */
  now?: () => number
  log?: HarnessLogger
}

/** A profile that is not stored yet (the form's "Test connection"). */
export interface BrowserProfileDraft {
  adapter: string
  mode: BrowserMode
  settings: Record<string, unknown>
}

/** Result of {@link BrowserManager.test}. */
export type BrowserTestResult = { ok: true; version: string } | { ok: false; error: string }

/** The manager. */
export interface BrowserManager {
  readonly registry: BrowserRegistry
  readonly limits: BrowserLimits
  /** A stored profile, or `null`. */
  profile(id: string): Promise<BrowserProfile | null>
  /** What the profile's adapter can do in its mode; `undefined` for an unknown adapter. */
  capabilities(profile: BrowserProfile): BrowserCapabilities | undefined
  /** The domain rules that apply to a profile (its `allowDomains` plus the manager's limits). */
  rules(profile: BrowserProfile): DomainRules
  /**
   * Take the profile's browser for `holder`, starting the engine when the profile is managed. The
   * same holder gets the same lease back. Another holder gets `BUSY:`, except that a session can
   * take a lease a person only opened for viewing while the agent controls it.
   */
  lease(profileId: string, holder: LeaseHolder): Promise<Lease | LeaseRefusal>
  /** The runtime of an adapter's managed mode, for install, status and uninstall UIs. */
  runtime(adapterId: string): BrowserRuntime | undefined
  /** Start a managed profile's engine without leasing it (it keeps running until `stop`). */
  start(profileId: string): Promise<{ ok: true } | { ok: false; error: string }>
  /** Release the profile's lease and stop its managed engine. */
  stop(profileId: string): Promise<void>
  /** Check that a profile (or an unsaved form) reaches a browser; returns its version. */
  test(profile: BrowserProfile | BrowserProfileDraft): Promise<BrowserTestResult>
  /** Attach a viewer to the profile's live view (opening the browser for a person when nobody holds it). */
  live(profileId: string, viewer: { id: string }): Promise<LiveChannel | LeaseRefusal>
  /** A person hands the browser back without a live channel (a decision card). Returns what the agent is told. */
  handBack(profileId: string, by: string): Promise<HandBackInfo | undefined>
  status(): Promise<LeaseStatus[]>
  /** Memory and CPU per running profile (needs runtimes with `usage`). */
  usage(): Promise<BrowserUsage>
  /** Listen to leases, releases, takeovers and hand-backs. Returns the unsubscribe function. */
  on(listener: (event: BrowserEvent) => void): () => void
  /** Release every lease and stop the engines this manager started. */
  close(): Promise<void>
}

interface Sub {
  latest?: LiveFrame
  wake?: () => void
  ended: boolean
}

interface Fan {
  feed: LiveFeed
  subs: Set<Sub>
  info: { width: number; height: number }
  reader: ReadableStreamDefaultReader<LiveFrame>
}

interface Entry {
  profileId: string
  profile?: BrowserProfile
  adapter?: BrowserAdapter
  caps?: BrowserCapabilities
  holder: LeaseHolder
  connection?: BrowserConnection
  controller: ControllerState
  since: number
  page?: PageInfo
  viewers: Set<string>
  timer?: ReturnType<typeof setTimeout>
  open: boolean
  fan?: Promise<Fan>
  offClose?: () => void
  ready: Promise<Lease | LeaseRefusal>
}

const same = (a: LeaseHolder, b: LeaseHolder): boolean => a.kind === b.kind && a.id === b.id

const busy = (profile: string): LeaseRefusal => ({
  refused: true,
  kind: 'busy',
  text: `BUSY: profile "${profile}" is used by another session.`,
})

/** Create the manager. */
export function createBrowserManager(options: BrowserManagerOptions): BrowserManager {
  const { registry, profiles } = options
  const limits: BrowserLimits = { ...DEFAULT_BROWSER_LIMITS, ...options.limits }
  const now = options.now ?? Date.now
  const entries = new Map<string, Entry>()
  /** Profiles whose engine this manager started: adapter id → profile ids. */
  const started = new Map<string, Set<string>>()
  /** Profiles started on purpose (`start()`): kept running when their lease ends. */
  const pinned = new Set<string>()
  const listeners = new Set<(event: BrowserEvent) => void>()

  const emit = (event: BrowserEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch (error) {
        options.log?.warn(`browser: a listener threw: ${errorText(error)}`)
      }
    }
  }

  const rules = (profile: BrowserProfile): DomainRules => ({
    allowDomains: profile.allowDomains ?? [],
    denyDomains: limits.denyDomains,
    allowPrivateHosts: limits.allowPrivateHosts,
  })

  const capabilitiesOf = (profile: BrowserProfile): BrowserCapabilities | undefined =>
    registry.get(profile.adapter)?.capabilities(profile.mode, profile.settings)

  const markStarted = (adapterId: string, profileId: string): void => {
    const set = started.get(adapterId) ?? new Set<string>()
    started.set(adapterId, set)
    set.add(profileId)
  }

  async function stopEngine(
    entryProfile: BrowserProfile | undefined,
    profileId: string,
  ): Promise<void> {
    if (entryProfile === undefined || entryProfile.mode !== 'managed') return
    const runtime = registry.get(entryProfile.adapter)?.runtime()
    started.get(entryProfile.adapter)?.delete(profileId)
    pinned.delete(profileId)
    if (runtime === undefined) return
    try {
      await runtime.stop(profileId)
    } catch (error) {
      options.log?.warn(`browser: stopping ${profileId} failed: ${errorText(error)}`)
    }
  }

  // --- live fan-out ---------------------------------------------------------------------------

  function ensureFan(entry: Entry): Promise<Fan> {
    if (entry.fan === undefined) {
      entry.fan = (async (): Promise<Fan> => {
        const connection = entry.connection as BrowserConnection
        if (connection.live === undefined)
          throw new HarnessError('EH_CONFIG_INVALID', 'browser: this browser has no live view')
        const feed = await connection.live()
        const reader = feed.frames.getReader()
        const fan: Fan = { feed, subs: new Set(), info: { ...feed.info }, reader }
        void (async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              fan.info = { width: value.width, height: value.height }
              for (const sub of fan.subs) {
                sub.latest = value
                sub.wake?.()
              }
            }
          } catch {
            // the feed ended with its connection
          } finally {
            for (const sub of fan.subs) {
              sub.ended = true
              sub.wake?.()
            }
          }
        })()
        return fan
      })()
      entry.fan.catch(() => {
        entry.fan = undefined
      })
    }
    return entry.fan
  }

  async function stopFan(entry: Entry): Promise<void> {
    const pending = entry.fan
    entry.fan = undefined
    if (pending === undefined) return
    try {
      const fan = await pending
      for (const sub of fan.subs) {
        sub.ended = true
        sub.wake?.()
      }
      await fan.reader.cancel().catch(() => {})
      await fan.feed.close().catch(() => {})
    } catch {
      // never started
    }
  }

  // --- leases ---------------------------------------------------------------------------------

  const clearTimer = (entry: Entry): void => {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    delete entry.timer
  }

  function arm(entry: Entry): void {
    clearTimer(entry)
    if (!entry.open || !(limits.idleMs > 0) || !Number.isFinite(limits.idleMs)) return
    entry.timer = setTimeout(() => {
      if (!entry.open) return
      if (entry.viewers.size > 0 || entry.controller.by === 'human') {
        arm(entry)
        return
      }
      void drop(entry, 'idle')
    }, limits.idleMs)
    ;(entry.timer as { unref?: () => void }).unref?.()
  }

  async function drop(
    entry: Entry,
    reason: Extract<BrowserEvent, { type: 'release' }>['reason'],
  ): Promise<void> {
    if (!entry.open) return
    entry.open = false
    clearTimer(entry)
    if (entries.get(entry.profileId) === entry) entries.delete(entry.profileId)
    entry.offClose?.()
    await stopFan(entry)
    try {
      await entry.connection?.close()
    } catch (error) {
      options.log?.debug(`browser: closing ${entry.profileId} failed: ${errorText(error)}`)
    }
    const stop =
      reason === 'lost' ||
      reason === 'closed' ||
      (reason === 'idle' && limits.stopOnIdle && !pinned.has(entry.profileId))
    if (stop) await stopEngine(entry.profile, entry.profileId)
    emit({ type: 'release', profileId: entry.profileId, reason })
  }

  function busyText(entry: Entry): string | undefined {
    if (entry.controller.by !== 'human') return undefined
    return `BUSY: a person is controlling the browser since ${new Date(entry.controller.since).toISOString()}. Wait, or call browser_request_human to ask for it.`
  }

  function handle(entry: Entry, holder: LeaseHolder): Lease {
    const mine = (): boolean => entry.open && same(entry.holder, holder)
    return {
      profileId: entry.profileId,
      profile: entry.profile as BrowserProfile,
      holder,
      capabilities: entry.caps as BrowserCapabilities,
      connection: entry.connection as BrowserConnection,
      controller: () => ({ ...entry.controller }),
      busyText: () => busyText(entry),
      touch: () => {
        if (mine()) arm(entry)
      },
      setPage: (page) => {
        entry.page = page
      },
      requestHuman: (reason) => {
        if (!mine()) return
        entry.controller = { by: 'human', since: now(), reason }
        emit({ type: 'request-human', profileId: entry.profileId, reason })
      },
      get open() {
        return mine()
      },
      release: async () => {
        if (mine()) await drop(entry, 'released')
      },
    }
  }

  async function connectEntry(entry: Entry): Promise<Lease | LeaseRefusal> {
    const fail = (text: string, kind: LeaseRefusal['kind'] = 'error'): LeaseRefusal => {
      entries.delete(entry.profileId)
      entry.open = false
      return { refused: true, kind, text }
    }
    const profile = await profiles.get(entry.profileId)
    if (profile === null)
      return fail(
        'ERROR: this browser profile does not exist (anymore): it was deleted. Retrying does not help and no other tool replaces the browser. Tell the person in one sentence; an admin chooses another profile for you.',
      )
    entry.profile = profile
    const adapter = registry.get(profile.adapter)
    if (adapter === undefined) {
      return fail(`ERROR: the browser adapter "${profile.adapter}" is not available.`)
    }
    entry.adapter = adapter
    let secrets: string[] = []
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), limits.startTimeoutMs)
    try {
      const schema = adapter.schema(profile.mode)
      if (schema === undefined) {
        return fail(`ERROR: the adapter "${adapter.id}" has no ${profile.mode} mode.`)
      }
      const settings = registry.validate(profile.adapter, profile.mode, profile.settings)
      secrets = secretValuesOf(schema, settings)
      entry.caps = adapter.capabilities(profile.mode, settings)
      const endpoint =
        profile.mode === 'manual'
          ? await adapter.manualEndpoint(settings)
          : adapter.managedEndpoint(
              await startManaged(adapter, profile, settings, controller.signal),
              settings,
            )
      if (!entry.open) return fail('ERROR: the browser was released while it started.')
      // an engine that has just started can refuse its first connection for a moment: retry a
      // managed one a few times within the start timeout
      const attempts = profile.mode === 'managed' ? 5 : 1
      let connection: BrowserConnection | undefined
      for (let attempt = 1; connection === undefined; attempt++) {
        try {
          connection = await raceAbort(
            adapter.connect(endpoint, {
              signal: controller.signal,
              limits,
              profile: { id: profile.id, name: profile.name },
            }),
            controller.signal,
            limits.startTimeoutMs,
          )
        } catch (error) {
          if (attempt >= attempts || controller.signal.aborted) throw error
          await new Promise((r) => setTimeout(r, 200 * attempt))
        }
      }
      if (!entry.open) {
        await connection.close().catch(() => {})
        return fail('ERROR: the browser was released while it started.')
      }
      entry.connection = connection
      entry.offClose = connection.onClose?.(() => {
        if (entry.open) void drop(entry, 'lost')
      })
      arm(entry)
      emit({ type: 'lease', profileId: entry.profileId, holder: entry.holder })
      return handle(entry, entry.holder)
    } catch (error) {
      const text = scrub(errorText(error), secrets)
      options.log?.warn(`browser: starting ${profile.name} failed: ${text}`)
      if (profile.mode === 'managed') await stopEngine(profile, profile.id)
      return fail(`ERROR: the browser could not start (${text}).`)
    } finally {
      clearTimeout(timeout)
    }
  }

  async function startManaged(
    adapter: BrowserAdapter,
    profile: BrowserProfile,
    settings: Record<string, unknown>,
    signal: AbortSignal,
  ): ReturnType<BrowserRuntime['start']> {
    const runtime = adapter.runtime()
    if (runtime === undefined) {
      throw new HarnessError(
        'EH_CONFIG_INVALID',
        'browser: managed mode is not available on this server',
      )
    }
    markStarted(adapter.id, profile.id)
    return raceAbort(
      runtime.start({ id: profile.id, name: profile.name }, adapter.runtimeSettings(settings)),
      signal,
      limits.startTimeoutMs,
    )
  }

  const manager: BrowserManager = {
    registry,
    limits,
    profile: (id) => profiles.get(id),
    capabilities: capabilitiesOf,
    rules,

    async lease(profileId, holder) {
      const existing = entries.get(profileId)
      if (existing !== undefined) {
        const taken =
          existing.holder.kind === 'person' &&
          holder.kind === 'session' &&
          existing.controller.by === 'agent'
        if (same(existing.holder, holder) || taken) {
          const result = await existing.ready
          if ('refused' in result) return result
          if (taken && existing.open) {
            existing.holder = holder
            emit({ type: 'lease', profileId, holder })
          }
          return existing.open ? handle(existing, holder) : manager.lease(profileId, holder)
        }
        return busy(existing.profile?.name ?? profileId)
      }
      if (entries.size >= limits.maxLeases) {
        return {
          refused: true,
          kind: 'limit',
          text: `BUSY: ${entries.size} browsers are open (the limit is ${limits.maxLeases}). Try again later.`,
        }
      }
      const entry: Entry = {
        profileId,
        holder,
        controller: { by: 'agent', since: now() },
        since: now(),
        viewers: new Set(),
        open: true,
        ready: undefined as unknown as Promise<Lease | LeaseRefusal>,
      }
      entries.set(profileId, entry)
      entry.ready = connectEntry(entry)
      return entry.ready
    },

    runtime: (adapterId) => registry.get(adapterId)?.runtime(),

    async start(profileId) {
      const profile = await profiles.get(profileId)
      if (profile === null) return { ok: false, error: 'This browser profile does not exist.' }
      const adapter = registry.get(profile.adapter)
      if (adapter === undefined || profile.mode !== 'managed') {
        return { ok: false, error: 'Only managed profiles can be started.' }
      }
      try {
        const settings = registry.validate(profile.adapter, profile.mode, profile.settings)
        const controller = new AbortController()
        await startManaged(adapter, profile, settings, controller.signal)
        pinned.add(profileId)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    },

    async stop(profileId) {
      const entry = entries.get(profileId)
      const profile = entry?.profile ?? (await profiles.get(profileId))
      if (entry !== undefined) await drop(entry, 'stopped')
      await stopEngine(profile ?? undefined, profileId)
    },

    async test(input) {
      let secrets: string[] = []
      try {
        const adapter = registry.get(input.adapter)
        if (adapter === undefined)
          return { ok: false, error: `Unknown adapter "${input.adapter}".` }
        const schema = adapter.schema(input.mode)
        if (schema === undefined) {
          return { ok: false, error: `${adapter.label} does not offer ${input.mode} mode.` }
        }
        const settings = registry.validate(input.adapter, input.mode, input.settings)
        secrets = secretValuesOf(schema, settings)
        if (input.mode === 'managed') {
          const runtime = adapter.runtime()
          if (runtime === undefined) {
            return { ok: false, error: 'Managed mode is not available on this server.' }
          }
          const status = await runtime.status()
          if (status.state === 'missing' || status.state === 'installing') {
            return { ok: false, error: 'The browser is not downloaded yet.' }
          }
          if (status.state === 'error') {
            return { ok: false, error: status.error ?? 'The browser runtime reports an error.' }
          }
          return { ok: true, version: status.version ?? 'unknown' }
        }
        const endpoint = await adapter.manualEndpoint(settings)
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), limits.startTimeoutMs)
        try {
          const result = await raceAbort(
            adapter.test(endpoint, {
              signal: controller.signal,
              limits,
              profile: { id: 'test', name: 'test' },
            }),
            controller.signal,
            limits.startTimeoutMs,
          )
          return { ok: true, version: result.version }
        } finally {
          clearTimeout(timeout)
        }
      } catch (error) {
        return { ok: false, error: scrub(errorText(error), secrets) }
      }
    },

    async live(profileId, viewer) {
      let entry = entries.get(profileId)
      if (entry === undefined) {
        const result = await manager.lease(profileId, { kind: 'person', id: viewer.id })
        if ('refused' in result) return result
        entry = entries.get(profileId)
      } else {
        const result = await entry.ready
        if ('refused' in result) return result
      }
      if (entry === undefined || !entry.open) {
        return { refused: true, kind: 'error', text: 'ERROR: the browser is not open.' }
      }
      const caps = entry.caps as BrowserCapabilities
      if (caps.liveView === 'none') {
        return { refused: true, kind: 'error', text: 'ERROR: this browser has no live view.' }
      }
      const e = entry
      const profile = e.profile as BrowserProfile
      e.viewers.add(viewer.id)
      let closed = false
      const sub: Sub = { ended: false }
      let fan: Fan | undefined
      let info = { width: 0, height: 0 }
      if (caps.liveView === 'screencast' || caps.liveView === 'poll') {
        try {
          fan = await ensureFan(e)
          info = { ...fan.info }
          fan.subs.add(sub)
        } catch (error) {
          e.viewers.delete(viewer.id)
          return {
            refused: true,
            kind: 'error',
            text: `ERROR: the live view could not start (${errorText(error)}).`,
          }
        }
      } else {
        sub.ended = true
      }
      const frames = new ReadableStream<LiveFrame>(
        {
          async pull(controller) {
            while (sub.latest === undefined && !sub.ended && !closed) {
              await new Promise<void>((resolve) => {
                sub.wake = resolve
              })
            }
            if (sub.latest !== undefined) {
              const frame = sub.latest
              sub.latest = undefined
              controller.enqueue(frame)
              return
            }
            controller.close()
          },
          cancel() {
            closed = true
            leave()
          },
        },
        { highWaterMark: 0 },
      )
      const liveUrl = (await adapterLiveUrl(e)) ?? undefined
      const leave = (): void => {
        if (!closed) closed = true
        sub.ended = true
        sub.wake?.()
        if (!e.viewers.delete(viewer.id)) return
        fan?.subs.delete(sub)
        if (e.controller.by === 'human' && e.controller.holder === viewer.id) {
          void doHandBack(e, viewer.id, 'viewer-left')
        }
        if (e.viewers.size === 0) {
          void stopFan(e)
          if (e.open && e.holder.kind === 'person') void drop(e, 'idle')
        }
      }
      const channel: LiveChannel = {
        info: {
          width: info.width,
          height: info.height,
          liveView: caps.liveView,
          ...(liveUrl === undefined ? {} : { liveUrl }),
        },
        frames,
        controller: () => ({ ...e.controller }),
        async takeOver() {
          if (closed || !e.open) return 'ERROR: this live view is closed.'
          if (!caps.takeover) return 'ERROR: this browser does not allow taking control.'
          const c = e.controller
          if (c.by === 'human' && c.holder !== undefined && c.holder !== viewer.id) {
            return `BUSY: ${c.holder} is already controlling this browser.`
          }
          e.controller = {
            by: 'human',
            holder: viewer.id,
            since: now(),
            ...(c.reason === undefined ? {} : { reason: c.reason }),
          }
          arm(e)
          emit({ type: 'takeover', profileId, by: viewer.id })
          return undefined
        },
        async handBack() {
          if (closed || !e.open) return 'ERROR: this live view is closed.'
          const c = e.controller
          if (c.by !== 'human' || (c.holder !== undefined && c.holder !== viewer.id)) {
            return 'ERROR: you are not controlling this browser.'
          }
          await doHandBack(e, viewer.id, 'handed-back')
          return undefined
        },
        async input(event: LiveInput) {
          if (closed || !e.open) return 'ERROR: this live view is closed.'
          const c = e.controller
          if (c.by !== 'human' || c.holder !== viewer.id) {
            return 'ERROR: take control before you send input.'
          }
          if (event.type === 'navigate') {
            const blocked = checkUrl(event.url, rules(profile))
            if (blocked !== undefined) return blocked
          }
          arm(e)
          if (fan === undefined) return 'ERROR: this live view takes no input.'
          return fan.feed.input(event)
        },
        close: leave,
      }
      return channel
    },

    async handBack(profileId, by) {
      const entry = entries.get(profileId)
      if (entry === undefined || !entry.open || entry.controller.by !== 'human') return undefined
      return doHandBack(entry, by, 'handed-back')
    },

    async status() {
      const out: LeaseStatus[] = []
      for (const entry of entries.values()) {
        if (!entry.open || entry.connection === undefined) continue
        out.push({
          profileId: entry.profileId,
          profileName: entry.profile?.name ?? entry.profileId,
          adapter: entry.profile?.adapter ?? '',
          holder: { ...entry.holder },
          controller: { ...entry.controller },
          since: entry.since,
          ...(entry.page === undefined ? {} : { page: { ...entry.page } }),
          viewers: entry.viewers.size,
        })
      }
      return out
    },

    async usage() {
      const out: BrowserUsage = { profiles: [], totals: { rssBytes: 0, cpuPercent: 0 } }
      for (const adapter of registry.list()) {
        const runtime = registry.get(adapter.id)?.runtime()
        if (runtime === undefined) continue
        let running: string[] = []
        try {
          running = (await runtime.status()).running ?? []
        } catch {
          continue
        }
        for (const profileId of running) {
          let usage: Awaited<ReturnType<NonNullable<BrowserRuntime['usage']>>> = null
          try {
            usage = (await runtime.usage?.(profileId)) ?? null
          } catch {
            usage = null
          }
          out.profiles.push({
            profileId,
            adapter: adapter.id,
            ...(usage === null ? {} : { rssBytes: usage.rssBytes, cpuPercent: usage.cpuPercent }),
          })
          if (usage !== null) {
            out.totals.rssBytes += usage.rssBytes
            out.totals.cpuPercent += usage.cpuPercent
          }
        }
      }
      if (options.systemMemory !== undefined) {
        try {
          out.system = await options.systemMemory()
        } catch {
          // memory of the machine is optional
        }
      }
      return out
    },

    on(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async close() {
      for (const entry of [...entries.values()]) await drop(entry, 'closed')
      for (const [adapterId, ids] of started) {
        const runtime = registry.get(adapterId)?.runtime()
        for (const id of [...ids]) {
          try {
            await runtime?.stop(id)
          } catch (error) {
            options.log?.warn(`browser: stopping ${id} failed: ${errorText(error)}`)
          }
        }
        ids.clear()
      }
      pinned.clear()
    },
  }

  async function adapterLiveUrl(entry: Entry): Promise<string | undefined> {
    const profile = entry.profile
    if (profile === undefined || entry.adapter === undefined) return undefined
    try {
      if (profile.mode === 'manual') {
        const settings = registry.validate(profile.adapter, 'manual', profile.settings)
        return (await entry.adapter.manualEndpoint(settings)).liveUrl
      }
    } catch {
      // no live url
    }
    return undefined
  }

  async function doHandBack(
    entry: Entry,
    by: string,
    reason: HandBackInfo['reason'],
  ): Promise<HandBackInfo> {
    entry.controller = { by: 'agent', since: now() }
    entry.connection?.clearRefs?.()
    let page: PageInfo | undefined
    try {
      const info = await entry.connection?.page?.()
      if (info !== undefined && info.url !== '') page = info
    } catch {
      // the page is only for the message
    }
    if (page !== undefined) entry.page = page
    arm(entry)
    const info: HandBackInfo = { by, at: now(), ...(page === undefined ? {} : { page }), reason }
    emit({ type: 'handback', profileId: entry.profileId, info })
    return info
  }

  return manager
}

/** Wait for `promise`, but give up when `signal` aborts (the timeout of an engine start). */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void =>
      reject(new Error(`the browser did not start within ${Math.round(ms / 1000)} s`))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}
