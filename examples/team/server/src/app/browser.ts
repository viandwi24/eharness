/**
 * Browser use cases (plan P48; the routes in `http/routes/browser.ts` call these): adapters and
 * their forms, profiles with secrets redacted, runtimes (download, remove), start and stop,
 * resource usage, screenshots, and what a person's hand-back does to the parked agent.
 */
import { type BrowserRuntimeView, type BrowserSystemMemory, viewerName } from '../domain/browser.ts'
import type { ConnectionView } from '../domain/connectors.ts'
import { conflict, inUse, invalid, notFound } from '../domain/errors.ts'
import { approveDecision } from './decisions.ts'
import type {
  BrowserCapabilitiesView,
  BrowserFormSpecView,
  BrowserHandBackInfo,
  BrowserMode,
  BrowserPort,
  BrowserProfileRecord,
  BrowserPublicProfileRecord,
  BrowserRuntimeControl,
  BrowserTestOutcome,
  BrowserUsageData,
  Deps,
  BrowserLeaseView as LeaseStatus,
} from './ports.ts'

// the route names the viewer through this module (http may not import domain)
export { viewerName }

/** Runtime id of an adapter's engine on the Remote sandbox: `<adapter>@remote`. */
export const REMOTE_SUFFIX = '@remote'

/** Where a managed profile runs (`metadata.runtime`; a profile made before the choice runs here). */
export const runsOn = (p: {
  mode: Mode
  metadata?: Record<string, unknown>
}): 'local' | 'remote' =>
  p.mode === 'managed' && p.metadata?.runtime === 'remote' ? 'remote' : 'local'

/** The definition id of the Browser connector (`infra/browser/connector.ts`). */
export const BROWSER_CONNECTOR_ID = 'browser'
/** Where the library holds the screenshots of the agents (`eharness/browser` default folder). */
export const SHOTS_PREFIX = '/.browser/shots/'

type Mode = BrowserMode

const need = (deps: Deps): BrowserPort => {
  if (deps.browser === undefined) throw conflict('the browser is not set up', 'BROWSER_OFF')
  return deps.browser
}

/** `EH_CONFIG_INVALID` of the library is a bad request here (no secret value is ever echoed). */
async function readable<T>(run: () => Promise<T> | T): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'EH_CONFIG_INVALID') {
      throw invalid(error instanceof Error ? error.message : 'invalid browser settings')
    }
    throw error
  }
}

// --- adapters ---------------------------------------------------------------------------------

export interface BrowserAdapterView {
  id: string
  label: string
  description?: string
  modes: Mode[]
  capabilities: Partial<Record<Mode, BrowserCapabilitiesView>>
  forms: { manual?: BrowserFormSpecView; managed?: BrowserFormSpecView }
  /** The managed runtime of this adapter; null when managed mode is off or the adapter has none. */
  runtime: BrowserRuntimeView | null
  /** The same engine on the connected Remote sandbox (`<adapter>@remote`); null when none is connected. */
  remote: BrowserRuntimeView | null
  /** Why a mode is not offered ("managed mode is off on this server"). */
  unavailable: Partial<Record<Mode, string>>
}

export interface BrowserOverview {
  driver: 'off' | 'local'
  max: number
  system: BrowserSystemMemory | null
  adapters: BrowserAdapterView[]
}

export async function describeBrowser(deps: Deps): Promise<BrowserOverview> {
  const b = need(deps)
  const info = await b.info()
  const adapters: BrowserAdapterView[] = b.adapters().map((a) => {
    const runtime = info.runtimes.find((r) => r.adapter === a.id) ?? null
    const unavailable: Partial<Record<Mode, string>> = {}
    if (!a.modes.includes('managed')) {
      unavailable.managed =
        b.driver === 'off'
          ? 'Managed mode is off on this server (TEAM_BROWSER_DRIVER=off).'
          : `${a.label} has no managed mode.`
    } else if (runtime?.state === 'error' && runtime.version === undefined) {
      unavailable.managed = runtime.error ?? `${a.label} is not available here.`
    }
    return {
      id: a.id,
      label: a.label,
      ...(a.description === undefined ? {} : { description: a.description }),
      modes: [...a.modes] as Mode[],
      capabilities: a.capabilities,
      forms: b.forms(a.id),
      runtime,
      remote: a.modes.includes('managed')
        ? (info.runtimes.find((r) => r.adapter === `${a.id}${REMOTE_SUFFIX}`) ?? null)
        : null,
      unavailable,
    }
  })
  return { driver: b.driver, max: b.max, system: info.system, adapters }
}

// --- profiles ---------------------------------------------------------------------------------

export type BrowserProfileState =
  | 'missing'
  | 'installing'
  | 'ready'
  | 'running'
  | 'in-use'
  | 'controlled'
  | 'error'

export interface BrowserProfileView extends BrowserPublicProfileRecord {
  capabilities: BrowserCapabilitiesView | null
  state: BrowserProfileState
  /** Where a managed profile runs: this server or the Remote sandbox (`runtime.host`). */
  runsOn?: 'local' | 'remote'
  /** The managed runtime state, for a managed profile. */
  runtime?: { state: string; version?: string; error?: string; host?: string }
  /** Set while an agent or a person holds the browser. */
  lease?: {
    holder: { kind: 'session' | 'person'; id: string }
    heldBy?: { agentId: string; name: string }
    controller: { by: 'agent' | 'human'; holder?: string; since: number; reason?: string }
    viewers: number
    since: number
    page?: { url: string; title: string }
  }
  /** Agents whose Browser connection names this profile. */
  agents: Array<{ id: string; slug: string; name: string }>
  /** A provider's own live view (iframe) when the profile has one. */
  liveUrl?: string
}

async function browserConnections(deps: Deps): Promise<ConnectionView[]> {
  return (await deps.connectors.connections()).filter(
    (c) => c.definitionId === BROWSER_CONNECTOR_ID,
  )
}

const profileOf = (c: ConnectionView): string | undefined =>
  typeof c.settings.profileId === 'string' ? c.settings.profileId : undefined

/** Agents that use a connection (the connection's access list, or its own agent). */
function agentsOf(c: ConnectionView): string[] {
  if (c.access !== undefined) return c.access.agentIds
  return c.scope === 'agent' && c.scopeId !== undefined ? [c.scopeId] : []
}

async function agentsByProfile(deps: Deps): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  for (const c of await browserConnections(deps)) {
    const pid = profileOf(c)
    if (pid === undefined || !c.enabled) continue
    const set = out.get(pid) ?? new Set<string>()
    for (const a of agentsOf(c)) set.add(a)
    out.set(pid, set)
  }
  return out
}

function heldBy(deps: Deps, holderId: string): { agentId: string; name: string } | undefined {
  const agent = deps.agents.list().find((a) => holderId.includes(a.id))
  return agent === undefined ? undefined : { agentId: agent.id, name: agent.name }
}

async function viewOf(
  deps: Deps,
  profile: BrowserProfileRecord,
  ctx: {
    runtimes: BrowserRuntimeView[]
    leases: LeaseStatus[]
    assigned: Map<string, Set<string>>
  },
): Promise<BrowserProfileView> {
  const b = need(deps)
  const pub = b.publicProfile(profile)
  const where = runsOn(profile)
  const runtime = ctx.runtimes.find(
    (r) =>
      r.adapter === (where === 'remote' ? `${profile.adapter}${REMOTE_SUFFIX}` : profile.adapter),
  )
  const lease = ctx.leases.find((l) => l.profileId === profile.id)
  const running = runtime?.running.includes(profile.id) === true
  let state: BrowserProfileState = 'ready'
  if (profile.mode === 'managed') {
    if (runtime === undefined) state = 'error'
    else if (runtime.state === 'missing') state = 'missing'
    else if (runtime.state === 'installing') state = 'installing'
    else if (runtime.state === 'error' && runtime.version === undefined) state = 'error'
    else if (running) state = 'running'
  }
  // a person watching (the live view opened it) is not an agent using it
  if (lease !== undefined)
    state =
      lease.controller.by === 'human'
        ? 'controlled'
        : lease.holder.kind === 'session'
          ? 'in-use'
          : state === 'ready'
            ? 'running'
            : state
  const liveUrl =
    profile.mode === 'manual' && typeof profile.settings.liveUrl === 'string'
      ? profile.settings.liveUrl
      : undefined
  const agents = [...(ctx.assigned.get(profile.id) ?? [])]
    .map((id) => deps.agents.get(id))
    .filter((a): a is NonNullable<typeof a> => a !== undefined && a.archivedAt === null)
    .map((a) => ({ id: a.id, slug: a.slug, name: a.name }))
  const held = lease === undefined ? undefined : heldBy(deps, lease.holder.id)
  return {
    ...pub,
    capabilities: b.capabilities(profile) ?? null,
    state,
    ...(profile.mode === 'managed' ? { runsOn: where } : {}),
    ...(runtime === undefined
      ? {}
      : {
          runtime: {
            state: runtime.state,
            ...(runtime.version === undefined ? {} : { version: runtime.version }),
            ...(runtime.error === undefined ? {} : { error: runtime.error }),
            ...(runtime.host === undefined ? {} : { host: runtime.host }),
          },
        }),
    ...(lease === undefined
      ? {}
      : {
          lease: {
            holder: lease.holder,
            ...(held === undefined ? {} : { heldBy: held }),
            controller: lease.controller,
            viewers: lease.viewers,
            since: lease.since,
            ...(lease.page === undefined
              ? {}
              : { page: { url: lease.page.url, title: lease.page.title } }),
          },
        }),
    agents,
    ...(liveUrl === undefined ? {} : { liveUrl }),
  }
}

async function context(deps: Deps) {
  const b = need(deps)
  return {
    runtimes: await b.runtimes(),
    leases: await b.leases(),
    assigned: await agentsByProfile(deps),
  }
}

export async function listBrowserProfiles(deps: Deps): Promise<BrowserProfileView[]> {
  const b = need(deps)
  const ctx = await context(deps)
  const all: BrowserProfileRecord[] = []
  let cursor: string | undefined
  do {
    const page = await b.profiles.list({ limit: 100, ...(cursor === undefined ? {} : { cursor }) })
    all.push(...page.items)
    cursor = page.nextCursor
  } while (cursor !== undefined)
  return Promise.all(all.map((p) => viewOf(deps, p, ctx)))
}

async function stored(deps: Deps, id: string): Promise<BrowserProfileRecord> {
  const profile = await need(deps).profiles.get(id)
  if (profile === null) throw notFound('browser profile', id)
  return profile
}

export async function getBrowserProfile(deps: Deps, id: string): Promise<BrowserProfileView> {
  return viewOf(deps, await stored(deps, id), await context(deps))
}

const cleanDomains = (list: readonly string[] | undefined): string[] | undefined => {
  if (list === undefined) return undefined
  const out = [...new Set(list.map((d) => d.trim().toLowerCase()).filter((d) => d !== ''))]
  if (out.length > 100) throw invalid('allowDomains lists at most 100 hosts')
  return out
}

export interface BrowserProfileCreate {
  name: string
  adapter: string
  mode: Mode
  settings?: Record<string, unknown> | undefined
  allowDomains?: string[] | undefined
  trusted?: boolean | undefined
  /** Managed only: run it on this server (default) or on the connected Remote sandbox. */
  runtime?: 'local' | 'remote' | undefined
}

function adapterOf(deps: Deps, id: string, mode: Mode) {
  const adapter = need(deps).adapter(id)
  if (adapter === undefined) throw invalid(`unknown browser adapter: ${id}`, 'UNKNOWN_ADAPTER')
  if (!adapter.modes.includes(mode)) {
    throw invalid(
      mode === 'managed'
        ? 'Managed mode is off on this server: connect to an existing browser instead.'
        : `${adapter.label} has no ${mode} mode.`,
      'MODE_UNAVAILABLE',
    )
  }
  return adapter
}

/**
 * A managed Chrome here with "Headless" off needs a window: a Linux server without a display would
 * fail at every start ("headed Chrome on Linux needs a display"), so the profile is refused now.
 */
function checkWindow(
  b: BrowserPort,
  adapter: string,
  mode: Mode,
  settings: Record<string, unknown>,
) {
  if (adapter !== 'chrome' || mode !== 'managed' || settings.headless !== false || b.windows) return
  throw invalid(
    'This server has no display, so Chrome can not run with a window. Turn Headless on (the live view works without a window), or start the server with TEAM_BROWSER_XVFB=1.',
    'NO_DISPLAY',
  )
}

export async function createBrowserProfile(
  deps: Deps,
  input: BrowserProfileCreate,
): Promise<BrowserProfileView> {
  const b = need(deps)
  adapterOf(deps, input.adapter, input.mode)
  const settings = await readable(() => b.validate(input.adapter, input.mode, input.settings ?? {}))
  const remote = input.runtime === 'remote'
  if (!remote) checkWindow(b, input.adapter, input.mode, settings)
  if (remote) {
    if (input.mode !== 'managed')
      throw invalid('Only a managed profile can run on the Remote sandbox.')
    if (input.adapter !== 'chrome') throw invalid('Only Chrome can run on the Remote sandbox.')
    if ((await b.remoteRuntime()) === undefined) {
      throw invalid(
        'The Remote sandbox is not connected. Connect it in Connectors first.',
        'REMOTE_UNAVAILABLE',
      )
    }
  }
  const allow = cleanDomains(input.allowDomains)
  const profile = await readable(() =>
    b.profiles.create({
      name: input.name,
      adapter: input.adapter,
      mode: input.mode,
      settings,
      ...(allow === undefined || allow.length === 0 ? {} : { allowDomains: allow }),
      ...(input.trusted === true ? { trusted: true } : {}),
      metadata: { createdBy: 'web', ...(remote ? { runtime: 'remote' } : {}) },
    }),
  )
  return viewOf(deps, profile, await context(deps))
}

export interface BrowserProfilePatch {
  name?: string | undefined
  settings?: Record<string, unknown> | undefined
  allowDomains?: string[] | undefined
  trusted?: boolean | undefined
}

export async function updateBrowserProfile(
  deps: Deps,
  id: string,
  patch: BrowserProfilePatch,
): Promise<BrowserProfileView> {
  const b = need(deps)
  const current = await stored(deps, id)
  const allow = cleanDomains(patch.allowDomains)
  const settings =
    patch.settings === undefined
      ? undefined
      : await readable(() =>
          b.merge(
            current.adapter,
            current.mode,
            current.settings,
            patch.settings as Record<string, unknown>,
          ),
        )
  if (settings !== undefined && runsOn(current) === 'local') {
    checkWindow(b, current.adapter, current.mode, settings)
  }
  const result = await readable(() =>
    b.profiles.update(id, {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(settings === undefined ? {} : { settings }),
      ...(allow === undefined ? {} : { allowDomains: allow }),
      ...(patch.trusted === undefined ? {} : { trusted: patch.trusted }),
    }),
  )
  if (!result.ok) throw notFound('browser profile', id)
  // a running engine keeps the settings it started with: the next start uses the new ones
  return viewOf(deps, result.profile, await context(deps))
}

export async function deleteBrowserProfile(deps: Deps, id: string): Promise<void> {
  const b = need(deps)
  const profile = await stored(deps, id)
  const users = (await browserConnections(deps)).filter((c) => profileOf(c) === id)
  if (users.length > 0) {
    throw inUse(
      'browser profile',
      id,
      users.map((c) => c.label),
      'PROFILE_IN_USE',
      { connections: users.map((c) => c.id) },
    )
  }
  await b.stop(id)
  await b.adapter(profile.adapter)?.runtime()?.removeProfileData?.(id)
  await b.profiles.delete(id)
}

export async function testBrowserProfile(deps: Deps, id: string): Promise<BrowserTestOutcome> {
  return need(deps).test(await stored(deps, id))
}

/** "Test connection" of the wizard: settings that are not saved yet. */
export async function testBrowserDraft(
  deps: Deps,
  input: { adapter: string; mode: Mode; settings?: Record<string, unknown> | undefined },
): Promise<BrowserTestOutcome> {
  const b = need(deps)
  adapterOf(deps, input.adapter, input.mode)
  const draft = {
    adapter: input.adapter,
    mode: input.mode,
    settings: await readable(() => b.validate(input.adapter, input.mode, input.settings ?? {})),
  }
  return b.test(draft)
}

export async function startBrowserProfile(deps: Deps, id: string): Promise<BrowserProfileView> {
  const b = need(deps)
  await stored(deps, id)
  const result = await b.start(id)
  if (!result.ok) throw conflict(result.error, 'BROWSER_START_FAILED')
  return getBrowserProfile(deps, id)
}

export async function stopBrowserProfile(deps: Deps, id: string): Promise<BrowserProfileView> {
  await stored(deps, id)
  await need(deps).stop(id)
  return getBrowserProfile(deps, id)
}

// --- runtimes ---------------------------------------------------------------------------------

async function runtimeOf(
  deps: Deps,
  adapterId: string,
): Promise<{ runtime: BrowserRuntimeControl; label: string }> {
  const remote = adapterId.endsWith(REMOTE_SUFFIX)
  const adapter = need(deps).adapter(remote ? adapterId.slice(0, -REMOTE_SUFFIX.length) : adapterId)
  if (adapter === undefined) throw notFound('browser adapter', adapterId)
  if (remote) {
    const runtime = await need(deps).remoteRuntime()
    if (runtime === undefined) {
      throw invalid('The Remote sandbox is not connected.', 'REMOTE_UNAVAILABLE')
    }
    return { runtime, label: `${adapter.label} on the Remote sandbox` }
  }
  const runtime = adapter.runtime()
  if (runtime === undefined) {
    throw invalid(
      'Managed mode is off on this server (TEAM_BROWSER_DRIVER=off).',
      'MODE_UNAVAILABLE',
    )
  }
  return { runtime, label: adapter.label }
}

async function runtimeView(deps: Deps, adapterId: string): Promise<BrowserRuntimeView> {
  const found = (await need(deps).runtimes()).find((r) => r.adapter === adapterId)
  if (found === undefined) throw notFound('browser runtime', adapterId)
  return found
}

export async function getBrowserRuntime(
  deps: Deps,
  adapterId: string,
): Promise<BrowserRuntimeView> {
  await runtimeOf(deps, adapterId)
  return runtimeView(deps, adapterId)
}

/**
 * Start the download in the background and answer with the state at once: the page polls
 * `GET /browser/runtimes/{adapter}` for the progress, version and size (a failure stays in `error`).
 */
export async function installBrowserRuntime(
  deps: Deps,
  adapterId: string,
): Promise<BrowserRuntimeView> {
  const { runtime } = await runtimeOf(deps, adapterId)
  const now = await runtime.status()
  if (now.state !== 'installing') {
    runtime.install().catch(() => undefined)
    await new Promise((r) => setTimeout(r, 0))
  }
  return runtimeView(deps, adapterId)
}

export async function uninstallBrowserRuntime(
  deps: Deps,
  adapterId: string,
): Promise<BrowserRuntimeView> {
  const { runtime, label } = await runtimeOf(deps, adapterId)
  const now = await runtime.status()
  if (now.state === 'installing')
    throw conflict(`${label} is downloading right now`, 'RUNTIME_BUSY')
  if ((now.running ?? []).length > 0) {
    throw conflict(`Stop the running ${label} profiles first.`, 'RUNTIME_BUSY')
  }
  await runtime.uninstall?.()
  return runtimeView(deps, adapterId)
}

// --- usage and screenshots --------------------------------------------------------------------

export interface BrowserUsageView extends Omit<BrowserUsageData, 'profiles'> {
  profiles: Array<BrowserUsageData['profiles'][number] & { name: string }>
}

export async function browserUsage(deps: Deps): Promise<BrowserUsageView> {
  const b = need(deps)
  const usage = await b.usage()
  const names = new Map<string, string>()
  for (const p of usage.profiles) {
    names.set(p.profileId, (await b.profiles.get(p.profileId))?.name ?? p.profileId)
  }
  return {
    ...usage,
    profiles: usage.profiles.map((p) => ({ ...p, name: names.get(p.profileId) as string })),
  }
}

export interface BrowserShotView {
  path: string
  mediaType: string | null
  size: number
  updatedAt: number
  agent: { id: string; name: string } | null
  /** A signed URL of the image (the library's raw view). */
  url: string
  expiresAt: number
}

/** The newest screenshots of the agents that use the profile (the library's `/.browser/shots/`). */
export async function browserShots(deps: Deps, id: string, limit = 12): Promise<BrowserShotView[]> {
  await stored(deps, id)
  const agents = (await agentsByProfile(deps)).get(id) ?? new Set<string>()
  if (agents.size === 0) return []
  const files = deps.library
    .list({ prefix: SHOTS_PREFIX, newestFirst: true, limit: 200 })
    .filter((f) => f.createdByAgentId !== null && agents.has(f.createdByAgentId))
    .slice(0, limit)
  const out: BrowserShotView[] = []
  for (const f of files) {
    const signed = await deps.artifacts.libraryViewUrl(f.path)
    const agent = f.createdByAgentId === null ? undefined : deps.agents.get(f.createdByAgentId)
    out.push({
      path: f.path,
      mediaType: f.mediaType,
      size: f.size,
      updatedAt: f.updatedAt,
      agent: agent === undefined ? null : { id: agent.id, name: agent.name },
      url: signed.url,
      expiresAt: signed.expiresAt,
    })
  }
  return out
}

// --- takeover ---------------------------------------------------------------------------------

/**
 * A person handed the browser back (the page's "Give back", or the viewer left): the agent's
 * parked `browser_request_human` of this profile is answered with what `formatHandBack` says.
 */
export async function settleTakeovers(
  deps: Deps,
  profileId: string,
  info: BrowserHandBackInfo,
): Promise<void> {
  const open = deps.decisions
    .list({ kind: 'escalation', status: 'open', limit: 200 })
    .filter((d) => d.kind === 'escalation' && d.payload.takeover?.profileId === profileId)
  for (const d of open) {
    try {
      await approveDecision(deps, d.id, {
        note: need(deps).formatHandBack({
          by: viewerName(info.by),
          ...(info.page === undefined ? {} : { page: info.page }),
        }),
      })
    } catch (error) {
      // answered meanwhile (a decision card): nothing to do
      if ((error as { code?: unknown }).code !== 'DECISION_CLOSED') {
        console.warn(`team: takeover of ${profileId} was not settled: ${String(error)}`)
      }
    }
  }
}
