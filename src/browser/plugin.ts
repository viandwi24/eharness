/**
 * The `browser()` plugin (spec 35 §5): browser tools over a managed lease, page text framed as
 * untrusted content, screenshots as media references the model sees in its next step, and
 * `browser_request_human` that parks the turn until a person hands the browser back.
 *
 * Built only with the public core API (ADR-0008); runtime-neutral (Web APIs only).
 *
 * @see docs/specs/35-browser.md
 */
import { type ModelMessage, tool } from 'ai'
import { z } from 'zod/v4'
import {
  definePlugin,
  errorText,
  externalTool,
  type HarnessContext,
  type HarnessPlugin,
  type SessionContribution,
  type ToolRisk,
  untrustedContent,
  type WaitStart,
} from '../index.ts'
import { checkUrl, type DomainRules } from './domains.ts'
import type { BrowserManager } from './manager.ts'
import {
  ACT_DESCRIPTION,
  EVAL_DESCRIPTION,
  OPEN_DESCRIPTION,
  READ_DESCRIPTION,
  REQUEST_HUMAN_DESCRIPTION,
  SCREENSHOT_DESCRIPTION,
  SCREENSHOT_FOR_PERSON_DESCRIPTION,
  SCREENSHOT_FOR_PERSON_TEXT,
  SCROLL_DESCRIPTION,
  SNAPSHOT_DESCRIPTION,
  TABS_DESCRIPTION,
} from './texts.ts'
import type { BrowserProfile, Lease, LeaseStatus, PageInfo, Shot, TabInfo } from './types.ts'

/** Names of the browser tools, in registration order. */
export type BrowserToolName =
  | 'browser_open'
  | 'browser_snapshot'
  | 'browser_act'
  | 'browser_screenshot'
  | 'browser_read'
  | 'browser_tabs'
  | 'browser_request_human'
  | 'browser_eval'
  | 'browser_profiles'
  | 'browser_use'
  | 'browser_scroll'

/** The `browser` service (spec 35 §5.3). */
export interface BrowserService {
  /** The profile this session uses, if any. */
  profileId(): string | undefined
  /** The session's lease (adapter, page, controller), when it holds one. */
  status(): Promise<LeaseStatus | undefined>
  /** Release the session's browser now (it is released when idle anyway). */
  release(): Promise<void>
}

declare module '../index.ts' {
  interface HarnessServices {
    /** Provided by `browser()`: the session's browser lease. */
    browser: BrowserService
  }
}

/** Extra domain rules of one plugin instance (spec 35 §8), added to the profile's and the manager's. */
export interface BrowserPluginLimits {
  /** Hosts that are never opened (patterns like `*.example.com`). */
  denyDomains?: string[]
  /** Overrides the manager's `allowPrivateHosts` for this plugin. */
  allowPrivateHosts?: boolean
}

/** One profile the agent may pick (`BrowserOptions.choose`). */
export interface BrowserProfileChoice {
  id: string
  name: string
  adapter: string
  mode?: string
  running?: boolean
  trusted?: boolean
}

/** Options of {@link browser}. */
export interface BrowserOptions {
  /**
   * Let the agent list profiles and pick one for its session (`browser_profiles`, `browser_use`).
   * `list` returns the profiles this agent may use. The pick is kept in session state and wins
   * over `profile`, which stays the default.
   */
  choose?: { list: (ctx: HarnessContext) => Promise<BrowserProfileChoice[]> }
  manager: BrowserManager
  /** Which profile this session uses; `undefined` registers no tools. */
  profile: string | ((ctx: HarnessContext) => string | undefined | Promise<string | undefined>)
  screenshots?: {
    /** Needs the filesystem plugin (service `fs`). Default `/.browser/shots/`. */
    folder?: string
    /** Attach a screenshot to open/act results: when the image changed, always, or never. Default `'changed'`. */
    auto?: 'changed' | 'always' | 'off'
    /** Newest screenshots sent to the model as images; older ones become a text line. Default 3. */
    inModel?: number
    /** Screenshot files kept per session. Default 50. */
    keep?: number
  }
  /** Attach a fresh snapshot to open/act results when the page changed. Default `'changed'`. */
  autoSnapshot?: 'changed' | 'off'
  /** Registers `browser_eval`. Default `false`. */
  allowEval?: boolean
  /**
   * Called when the model asks for a person (`browser_request_human`): create a handoff, notify.
   * Return what `externalTool().start` may return (`correlationId`, `payload`). Without it the tool
   * is not registered.
   */
  requestHuman?: (
    input: {
      reason: string
      profileId: string
      sessionId: string
      /** The external wait this call parks on (what `session.resolveWait` takes). */
      waitId: string
      toolCallId: string
      ctx: HarnessContext
    },
    ctx: HarnessContext,
  ) => Promise<WaitStart | undefined> | WaitStart | undefined
  /**
   * Whether the model accepts images (spec 12 `inputModalities`). Without images there is no
   * screenshot tool and no auto screenshots. Default `true`.
   */
  images?: boolean | ((ctx: HarnessContext) => boolean | Promise<boolean>)
  /** `metadata.risk` per tool. Defaults: `browser_act` and `browser_eval` `external` (`write` for a trusted profile), the rest (including `browser_scroll`) `read`. */
  risk?: Partial<Record<BrowserToolName, ToolRisk>>
  limits?: BrowserPluginLimits
  /** Rename tools. */
  toolNames?: Partial<Record<BrowserToolName, string>>
}

/** What a tool returns when a screenshot comes with it (the shape of the filesystem's media reference, spec 08 §12). */
export interface BrowserShotRef {
  type: 'media-ref'
  path: string
  version: string
  mediaType: string
  bytes: number
  /** The text the model reads next to the image. */
  text: string
  /** Position in the session's screenshot sequence (the newest `inModel` are sent as images). */
  seq: number
}

/** True for a tool output that carries a screenshot. */
export function isBrowserShotRef(value: unknown): value is BrowserShotRef {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<BrowserShotRef>
  return (
    v.type === 'media-ref' &&
    typeof v.path === 'string' &&
    typeof v.version === 'string' &&
    typeof v.mediaType === 'string' &&
    typeof v.text === 'string' &&
    typeof v.seq === 'number'
  )
}

/** Default folder of screenshots. */
export const BROWSER_SHOTS_FOLDER = '/.browser/shots/'

/** Line the model reads in place of a screenshot that left the `inModel` window. */
export const OLDER_SCREENSHOT_TEXT = '[older screenshot omitted]'

/** The text `browser_request_human` resolves with when a person hands the browser back. */
export function formatHandBack(state: { by: string; page?: PageInfo }): string {
  const clean = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 200)
  const where =
    state.page === undefined
      ? ''
      : ` · page "${clean(state.page.title)}" ${state.page.url.slice(0, 300)}`
  return `${state.by} handed the browser back${where}. Take a new snapshot before you continue.`
}

/** The part of the `fs` service the plugin uses (the file system plugin provides it). */
interface ShotFs {
  writeBytes?(
    path: string,
    bytes: Uint8Array,
    opts?: { ifVersion?: string | null; mediaType?: string; author?: string },
  ): Promise<{ ok: true; version: string } | { ok: false; reason: string }>
  readBytes?(path: string): Promise<{ bytes: Uint8Array; meta: { version: string } } | null>
  delete?(path: string): Promise<unknown>
  list?(prefix?: string): Promise<Array<{ path: string }>>
}

function toBase64(bytes: Uint8Array): string {
  let out = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(out)
}

const slug = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)
const pad = (n: number): string => String(n).padStart(5, '0')

const actInput = z.object({
  kind: z
    .enum([
      'click',
      'double_click',
      'hover',
      'fill',
      'type',
      'press',
      'select',
      'check',
      'uncheck',
      'scroll',
      'wait',
    ])
    .describe('What to do'),
  ref: z.string().optional().describe('Ref of the element from the latest snapshot, e.g. e5'),
  text: z.string().optional().describe('Text for fill and type'),
  key: z.string().optional().describe('Key for press, e.g. Enter, Tab or Control+a'),
  values: z.array(z.string()).optional().describe('Option values for select'),
  direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('Direction for scroll'),
  amount: z.number().optional().describe('Scroll distance in pixels'),
  ms: z.number().optional().describe('Milliseconds for wait (at most 10000)'),
  untilText: z.string().optional().describe('Text to wait for'),
})

type ActToolInput = z.infer<typeof actInput>

const scrollInput = z.object({
  direction: z
    .enum(['up', 'down', 'left', 'right'])
    .optional()
    .describe('Direction (default down)'),
  amount: z.number().optional().describe('Distance in pixels (default 600)'),
  pages: z.number().optional().describe('Distance in screens of about 800 px (instead of amount)'),
  ref: z
    .string()
    .optional()
    .describe('Ref of an element: alone it scrolls to it; with a direction it scrolls inside it'),
  waitMs: z.number().optional().describe('Then wait this long for content to load (at most 10000)'),
})

type ScrollToolInput = z.infer<typeof scrollInput>

function formatTabs(tabs: TabInfo[]): string {
  if (tabs.length === 0) return 'No tabs are open.'
  return tabs
    .map((t) => `${t.active ? '*' : '-'} ${t.id} "${t.title.replace(/\s+/g, ' ')}" ${t.url}`)
    .join('\n')
}

/**
 * The browser tools (spec 35). The tool list is fixed when the session opens and follows the
 * profile's adapter: no screenshot support, no model image input or no filesystem plugin means no
 * `browser_screenshot`; no `tabs` capability means no `browser_tabs`; no `requestHuman` option or no
 * `takeover` capability means no `browser_request_human`; `browser_eval` only with `allowEval`.
 *
 * The browser lease is taken on the first tool call and stays with the session until it has been
 * idle for `limits.idleMs` of the manager. It is not released at the end of a turn, so a long job
 * keeps its logged-in browser across checkpoints; after a restart the first call re-opens the
 * browser and the agent starts from a fresh snapshot (old refs answer `STALE:`).
 *
 * @example
 * ```ts
 * defineHarnessAgent({
 *   model,
 *   plugins: [filesystem({ fs }), browser({ manager, profile: 'work-chrome' })],
 * })
 * ```
 * @see docs/specs/35-browser.md#5-the-plugin
 */
export function browser(options: BrowserOptions): HarnessPlugin<'browser'> {
  const { manager } = options
  const shotsOptions = options.screenshots ?? {}
  const folder = (() => {
    const f = shotsOptions.folder ?? BROWSER_SHOTS_FOLDER
    return f.endsWith('/') ? f : `${f}/`
  })()
  const autoShots = shotsOptions.auto ?? 'changed'
  const inModel = Math.max(1, shotsOptions.inModel ?? 3)
  const keep = Math.max(1, shotsOptions.keep ?? 50)
  const autoSnapshot = options.autoSnapshot ?? 'changed'
  const names = (n: BrowserToolName): string => options.toolNames?.[n] ?? n

  return definePlugin({
    name: 'browser',
    provides: ['browser'],
    session: async (ctx): Promise<SessionContribution> => {
      const context = ctx as unknown as HarnessContext
      const sessionId = ctx.session.id
      const chosen = (): string | undefined => {
        if (options.choose === undefined) return undefined
        const v = ctx.state.get<string>('profile')
        return typeof v === 'string' && v !== '' ? v : undefined
      }
      const pick = async (): Promise<string | undefined> =>
        chosen() ??
        (typeof options.profile === 'function' ? await options.profile(context) : options.profile)
      const dynamic = options.choose !== undefined || typeof options.profile === 'function'
      let profileId = await pick()
      // with a chooser the tools exist even before a pick: their capabilities come from a profile
      // the agent may use (the first one), and calls ask it to pick when it must
      if ((profileId === undefined || profileId === '') && options.choose !== undefined) {
        const first = (await options.choose.list(context).catch(() => []))[0]
        if (first !== undefined) profileId = first.id
      }
      let lease: Lease | undefined
      const service: BrowserService = {
        profileId: () => (profileId === '' ? undefined : profileId),
        status: async () => {
          if (profileId === undefined) return undefined
          return (await manager.status()).find(
            (s) => s.profileId === profileId && s.holder.id === sessionId,
          )
        },
        release: async () => {
          await lease?.release()
          lease = undefined
        },
      }
      if (profileId === undefined || profileId === '') return { services: { browser: service } }
      const profile = await manager.profile(profileId)
      const caps = profile === null ? undefined : manager.capabilities(profile)
      if (profile === null || caps === undefined) {
        ctx.log.warn(`browser: profile "${profileId}" or its adapter is not available`)
        return { services: { browser: service } }
      }

      // --- screenshots: need the file system, image input and an engine that can take them ---
      let fs: ShotFs | undefined
      try {
        fs = (ctx.services as unknown as { fs?: ShotFs }).fs
      } catch {
        fs = undefined
      }
      const fsOk =
        fs !== undefined &&
        typeof fs.writeBytes === 'function' &&
        typeof fs.readBytes === 'function'
      const imagesOk =
        typeof options.images === 'function'
          ? await options.images(context)
          : (options.images ?? true)
      // screenshots the model sees (and the automatic ones after open/act) need image input; a
      // screenshot for the person (shown in the chat, stored in the file system) needs only fs
      const shots = caps.snapshot && caps.screenshot && fsOk && imagesOk
      const personShots = caps.screenshot && fsOk
      let seq = 0
      let lastHash: string | undefined
      const cache = new Map<number, { bytes: Uint8Array; version: string }>()
      if (personShots && fs?.list !== undefined) {
        try {
          const prefix = `${slug(sessionId)}-`
          for (const f of await fs.list(folder)) {
            const base = f.path.slice(f.path.lastIndexOf('/') + 1)
            if (!base.startsWith(prefix)) continue
            const n = Number(/-(\d+)\./.exec(base.slice(prefix.length - 1))?.[1])
            if (Number.isFinite(n) && n > seq) seq = n
          }
        } catch {
          // a new sequence is fine
        }
      }

      // a profile given as a function is looked up again on every call: it can be replaced or
      // deleted while the session is open (the tool list stays the one of the session's start)
      let current = profile
      const rules = (): DomainRules => {
        const base = manager.rules(current)
        return {
          allowDomains: base.allowDomains ?? [],
          denyDomains: [...(base.denyDomains ?? []), ...(options.limits?.denyDomains ?? [])],
          allowPrivateHosts: options.limits?.allowPrivateHosts ?? base.allowPrivateHosts === true,
        }
      }

      const acquire = async (): Promise<Lease | string> => {
        if (dynamic) {
          const next = await pick()
          if (next === undefined || next === '') {
            return options.choose !== undefined
              ? `ERROR: no browser profile is picked for this session. Call ${names('browser_profiles')} and pick one with ${names('browser_use')}.`
              : 'ERROR: no browser profile is available right now. Retrying does not help; tell the person in one sentence so an admin creates or chooses one.'
          }
          if (next !== profileId) {
            const p = await manager.profile(next)
            if (p === null) {
              return 'ERROR: this browser profile does not exist (anymore): it was deleted. Retrying does not help and no other tool replaces the browser. Tell the person in one sentence; an admin chooses another profile for you.'
            }
            await lease?.release().catch(() => undefined)
            lease = undefined
            profileId = next
            current = p
          }
        }
        if (lease?.open) return lease
        const result = await manager.lease(profileId as string, { kind: 'session', id: sessionId })
        if ('refused' in result) return result.text
        lease = result
        return result
      }

      /** Take the lease, refuse acting tools while a person controls the browser, run, never throw. */
      const guarded = async <T>(
        acting: boolean,
        run: (l: Lease) => Promise<T | string>,
      ): Promise<T | string> => {
        const l = await acquire()
        if (typeof l === 'string') return l
        if (acting) {
          const busy = l.busyText()
          if (busy !== undefined) return busy
        }
        l.touch()
        try {
          return await run(l)
        } catch (error) {
          return `ERROR: ${errorText(error)}`
        }
      }

      const block = (page: PageInfo, body?: string): string =>
        untrustedContent(
          `Page: ${page.title}\nURL: ${page.url}${body === undefined ? '' : `\n\n${body}`}`,
          {
            source: 'browser',
            url: page.url,
          },
        )

      /** After an action: a page that ended on a blocked host is replaced by about:blank. */
      const enforce = async (
        l: Lease,
        page: PageInfo,
        signal?: AbortSignal,
      ): Promise<string | undefined> => {
        const blocked = checkUrl(page.url, rules())
        if (blocked === undefined) return undefined
        await l.connection.navigate({ url: 'about:blank' }, signal).catch(() => undefined)
        l.setPage({ url: 'about:blank', title: '' })
        return `${blocked} The page was closed; the browser is on about:blank now.`
      }

      const snapshotText = async (l: Lease, signal?: AbortSignal): Promise<string> => {
        const snap = await l.connection.snapshot({}, signal)
        if (typeof snap === 'string') return snap
        l.setPage(snap.page)
        const more =
          snap.nextOffset === undefined
            ? ''
            : `\n… truncated; call browser_snapshot with offset ${snap.nextOffset} for more`
        return `Snapshot ${snap.id}:\n${block(snap.page, `${snap.text}${more}`)}`
      }

      // --- screenshots ---
      const storeShot = async (shot: Shot, page: PageInfo): Promise<BrowserShotRef | string> => {
        const n = seq + 1
        const ext = shot.mediaType === 'image/png' ? 'png' : 'jpg'
        const path = `${folder}${slug(sessionId)}-${pad(n)}.${ext}`
        const written = await (fs as ShotFs).writeBytes?.(path, shot.bytes, {
          mediaType: shot.mediaType,
          author: 'browser',
        })
        if (written === undefined || !written.ok) {
          return `ERROR: the screenshot could not be saved to ${path}.`
        }
        seq = n
        lastHash = shot.hash
        cache.set(n, { bytes: shot.bytes, version: written.version })
        for (const key of cache.keys()) if (key <= n - inModel) cache.delete(key)
        const old = n - keep
        if (old > 0 && fs?.delete !== undefined) {
          const prefix = `${folder}${slug(sessionId)}-${pad(old)}.`
          void Promise.resolve(fs.delete(`${prefix}jpg`))
            .catch(() => undefined)
            .then(() => fs?.delete?.(`${prefix}png`))
            .catch(() => undefined)
        }
        return {
          type: 'media-ref',
          path,
          version: written.version,
          mediaType: shot.mediaType,
          bytes: shot.bytes.length,
          text: `Screenshot of ${page.url} (${shot.width}x${shot.height}, ${shot.bytes.length} bytes, ${shot.mediaType}) saved as ${path}`,
          seq: n,
        }
      }

      /** Look at the page and attach the screenshot to `text` when it changed (or always). */
      const withShot = async (
        l: Lease,
        text: string,
        page: PageInfo,
        wanted: boolean,
        signal?: AbortSignal,
      ): Promise<string | BrowserShotRef> => {
        if (!shots || autoShots === 'off' || !wanted) return text
        const shot = await l.connection.screenshot({}, signal)
        if (typeof shot === 'string') return `${text}\n${shot}`
        if (autoShots === 'changed' && shot.hash === lastHash) return text
        const ref = await storeShot(shot, page)
        if (typeof ref === 'string') return `${text}\n${ref}`
        return { ...ref, text: `${text}\n${ref.text}` }
      }

      const modelOutput = async ({
        output,
      }: {
        output: unknown
      }): Promise<
        | { type: 'text'; value: string }
        | {
            type: 'content'
            value: Array<
              | { type: 'text'; text: string }
              | { type: 'file'; mediaType: string; data: { type: 'data'; data: string } }
            >
          }
      > => {
        if (!isBrowserShotRef(output)) {
          return {
            type: 'text',
            value: typeof output === 'string' ? output : JSON.stringify(output),
          }
        }
        if (!imagesOk) {
          return { type: 'text', value: `${output.text}\n${SCREENSHOT_FOR_PERSON_TEXT}` }
        }
        if (output.seq <= seq - inModel) {
          return { type: 'text', value: `${output.text}\n${OLDER_SCREENSHOT_TEXT}` }
        }
        const unavailable = {
          type: 'text' as const,
          value: `${output.text}\n[The screenshot is no longer available.]`,
        }
        try {
          let hit = cache.get(output.seq)
          if (hit === undefined || hit.version !== output.version) {
            const file = await fs?.readBytes?.(output.path)
            if (file === null || file === undefined || file.meta.version !== output.version) {
              return unavailable
            }
            hit = { bytes: file.bytes, version: file.meta.version }
            cache.set(output.seq, hit)
          }
          return {
            type: 'content',
            value: [
              { type: 'text', text: output.text },
              {
                type: 'file',
                mediaType: output.mediaType,
                data: { type: 'data', data: toBase64(hit.bytes) },
              },
            ],
          }
        } catch {
          return unavailable
        }
      }

      const risk = (name: BrowserToolName, fallback: ToolRisk): ToolRisk =>
        options.risk?.[name] ?? fallback
      const actingRisk: ToolRisk =
        (profile as BrowserProfile).trusted === true ? 'write' : 'external'

      const tools: Record<string, unknown> = {}

      tools[names('browser_open')] = tool({
        description: OPEN_DESCRIPTION,
        inputSchema: z.object({
          url: z.string().optional().describe('Full http(s) address to open'),
          action: z.enum(['back', 'forward', 'reload']).optional(),
        }),
        metadata: { risk: risk('browser_open', 'read') },
        toModelOutput: modelOutput,
        execute: async (
          input: { url?: string; action?: 'back' | 'forward' | 'reload' },
          { abortSignal }: { abortSignal?: AbortSignal },
        ): Promise<string | BrowserShotRef> => {
          if (input.url !== undefined) {
            const blocked = checkUrl(input.url, rules())
            if (blocked !== undefined) return blocked
          }
          return guarded<string | BrowserShotRef>(true, async (l) => {
            const nav = await l.connection.navigate(
              {
                ...(input.url === undefined ? {} : { url: input.url }),
                ...(input.action === undefined ? {} : { action: input.action }),
              },
              abortSignal,
            )
            if (nav.error !== undefined) return nav.error
            const page = { url: nav.url, title: nav.title }
            l.setPage(page)
            const stopped = await enforce(l, page, abortSignal)
            if (stopped !== undefined) return stopped
            const head = `Opened "${page.title.replace(/\s+/g, ' ').slice(0, 120)}" ${page.url}`
            const body = autoSnapshot === 'off' ? block(page) : await snapshotText(l, abortSignal)
            return withShot(l, `${head}\n${body}`, page, true, abortSignal)
          })
        },
      } as never)

      tools[names('browser_snapshot')] = tool({
        description: SNAPSHOT_DESCRIPTION,
        inputSchema: z.object({
          scope: z.string().optional().describe('Ref of an element to limit the outline to'),
          interactive: z
            .boolean()
            .optional()
            .describe('false: also list headings and items with refs'),
          offset: z.number().optional().describe('Continue a truncated snapshot at this offset'),
        }),
        metadata: { risk: risk('browser_snapshot', 'read') },
        execute: async (
          input: { scope?: string; interactive?: boolean; offset?: number },
          { abortSignal }: { abortSignal?: AbortSignal },
        ): Promise<string> =>
          guarded<string>(false, async (l) => {
            const snap = await l.connection.snapshot(input, abortSignal)
            if (typeof snap === 'string') return snap
            l.setPage(snap.page)
            const more =
              snap.nextOffset === undefined
                ? ''
                : `\n… truncated; call browser_snapshot with offset ${snap.nextOffset} for more`
            return `Snapshot ${snap.id} (${snap.refCount} refs):\n${block(snap.page, `${snap.text}${more}`)}`
          }),
      } as never)

      const runAct = (
        input: ActToolInput,
        abortSignal: AbortSignal | undefined,
        after?: ActToolInput,
      ): Promise<string | BrowserShotRef> =>
        guarded<string | BrowserShotRef>(true, async (l) => {
          const res = await l.connection.act(input, abortSignal)
          if (res.error !== undefined) return res.error
          let page = res.page
          let changed = res.changed || res.navigated
          let note = res.note
          if (after !== undefined) {
            const waited = await l.connection.act(after, abortSignal)
            if (waited.error === undefined) {
              page = waited.page
              changed = changed || waited.changed || waited.navigated
              note = note ?? waited.note
            }
          }
          l.setPage(page)
          const stopped = await enforce(l, page, abortSignal)
          if (stopped !== undefined) return stopped
          let text = res.summary
          if (note !== undefined && note !== '') text += `\n${note}`
          text +=
            autoSnapshot !== 'off' && changed
              ? `\n${await snapshotText(l, abortSignal)}`
              : `\n${block(page)}`
          return withShot(l, text, page, changed || autoShots === 'always', abortSignal)
        })

      tools[names('browser_act')] = tool({
        description: ACT_DESCRIPTION,
        inputSchema: actInput,
        metadata: { risk: risk('browser_act', actingRisk) },
        toModelOutput: modelOutput,
        execute: async (
          input: ActToolInput,
          { abortSignal }: { abortSignal?: AbortSignal },
        ): Promise<string | BrowserShotRef> => runAct(input, abortSignal),
      } as never)

      if (personShots) {
        tools[names('browser_screenshot')] = tool({
          description: imagesOk ? SCREENSHOT_DESCRIPTION : SCREENSHOT_FOR_PERSON_DESCRIPTION,
          inputSchema: z.object({
            fullPage: z.boolean().optional().describe('The whole page instead of the visible part'),
            ref: z.string().optional().describe('Ref of one element to capture'),
          }),
          metadata: { risk: risk('browser_screenshot', 'read') },
          toModelOutput: modelOutput,
          execute: async (
            input: { fullPage?: boolean; ref?: string },
            { abortSignal }: { abortSignal?: AbortSignal },
          ): Promise<string | BrowserShotRef> =>
            guarded<string | BrowserShotRef>(false, async (l) => {
              const shot = await l.connection.screenshot(input, abortSignal)
              if (typeof shot === 'string') return shot
              const info = (await l.connection.page?.(abortSignal)) ?? { url: '', title: '' }
              if (info.url !== '') l.setPage(info)
              return storeShot(shot, info)
            }),
        } as never)
      }

      tools[names('browser_read')] = tool({
        description: READ_DESCRIPTION,
        inputSchema: z.object({
          offset: z.number().optional().describe('Continue a truncated read at this offset'),
        }),
        metadata: { risk: risk('browser_read', 'read') },
        execute: async (
          input: { offset?: number },
          { abortSignal }: { abortSignal?: AbortSignal },
        ): Promise<string> =>
          guarded<string>(false, async (l) => {
            const read = await l.connection.read(
              input.offset === undefined ? {} : { offset: input.offset },
              abortSignal,
            )
            if (typeof read === 'string') return read
            l.setPage(read.page)
            const more =
              read.nextOffset === undefined
                ? ''
                : `\n… truncated; call browser_read with offset ${read.nextOffset} for more`
            return block(read.page, `${read.text}${more}`)
          }),
      } as never)

      if (caps.tabs) {
        tools[names('browser_tabs')] = tool({
          description: TABS_DESCRIPTION,
          inputSchema: z.object({
            action: z.enum(['list', 'open', 'switch', 'close']),
            tab: z.string().optional().describe('Tab id such as t2 (switch, close)'),
            url: z.string().optional().describe('Address to open in a new tab'),
          }),
          metadata: { risk: risk('browser_tabs', 'read') },
          execute: async (
            input: { action: 'list' | 'open' | 'switch' | 'close'; tab?: string; url?: string },
            { abortSignal }: { abortSignal?: AbortSignal },
          ): Promise<string> => {
            if (input.action === 'open' && input.url !== undefined) {
              const blocked = checkUrl(input.url, rules())
              if (blocked !== undefined) return blocked
            }
            return guarded<string>(input.action !== 'list', async (l) => {
              if (l.connection.tabs === undefined) return 'ERROR: this browser has no tabs.'
              const out = await l.connection.tabs(input, abortSignal)
              if (typeof out === 'string') return out
              const active = out.find((t) => t.active)
              if (active !== undefined) {
                const stopped = await enforce(
                  l,
                  { url: active.url, title: active.title },
                  abortSignal,
                )
                if (stopped !== undefined) return stopped
              }
              return untrustedContent(formatTabs(out), { source: 'browser', name: 'tabs' })
            })
          },
        } as never)
      }

      if (caps.takeover && options.requestHuman !== undefined) {
        const ask = options.requestHuman
        tools[names('browser_request_human')] = externalTool({
          description: REQUEST_HUMAN_DESCRIPTION,
          inputSchema: z.object({
            reason: z.string().min(1).describe('What the person needs to do in the browser'),
          }),
          outputSchema: z.string(),
          metadata: { risk: risk('browser_request_human', 'read'), idempotent: true },
          start: async (input, event): Promise<WaitStart> => {
            const l = await acquire()
            if (typeof l === 'string') {
              ctx.log.warn(`browser: request_human without a browser: ${l}`)
              return { timeoutAt: Date.now(), onTimeout: { output: l } }
            }
            l.touch()
            l.requestHuman(input.reason)
            const started = await ask(
              {
                reason: input.reason,
                // acquire() succeeded, so the current profile is set
                profileId: profileId as string,
                sessionId: event.ctx.session.id,
                waitId: event.waitId,
                toolCallId: event.toolCallId,
                ctx: event.ctx,
              },
              event.ctx,
            )
            return {
              ...(started ?? {}),
              payload: {
                kind: 'browser-takeover',
                profileId,
                ...(started?.payload as object | undefined),
              },
            } as WaitStart
          },
        })
      }

      if (options.allowEval === true) {
        tools[names('browser_eval')] = tool({
          description: EVAL_DESCRIPTION,
          inputSchema: z.object({
            expression: z.string().min(1).describe('JavaScript expression'),
          }),
          metadata: { risk: risk('browser_eval', actingRisk) },
          execute: async (
            input: { expression: string },
            { abortSignal }: { abortSignal?: AbortSignal },
          ): Promise<string> =>
            guarded<string>(true, async (l) => {
              if (l.connection.eval === undefined) return 'ERROR: this browser cannot run scripts.'
              const text = await l.connection.eval(input.expression, abortSignal)
              const info = await l.connection.page?.(abortSignal)
              if (info !== undefined && info.url !== '') {
                l.setPage(info)
                const stopped = await enforce(l, info, abortSignal)
                if (stopped !== undefined) return stopped
              }
              return text.startsWith('ERROR:')
                ? text
                : untrustedContent(text, { source: 'browser', name: 'eval' })
            }),
        } as never)
      }

      if (options.choose !== undefined) {
        const choose = options.choose
        const describe = (p: BrowserProfileChoice, active: string | undefined): string =>
          [
            `- ${p.name}`,
            `(${p.adapter}${p.mode === undefined ? '' : `, ${p.mode === 'managed' ? 'runs on this server' : 'existing browser'}`})`,
            p.running === undefined ? undefined : p.running ? 'running' : 'stopped',
            p.trusted === true ? 'trusted' : undefined,
            p.id === active ? '← in use by this session' : undefined,
          ]
            .filter((x) => x !== undefined)
            .join(' ')
        tools[names('browser_profiles')] = tool({
          description:
            'List the browser profiles you may use (name, engine, whether it runs, which one this session uses). Pick one with browser_use. Read-only.',
          inputSchema: z.object({}),
          metadata: { risk: risk('browser_profiles', 'read') },
          execute: async (): Promise<string> => {
            try {
              const list = await choose.list(context)
              if (list.length === 0) {
                return 'There is no browser profile you may use. Tell the person in one sentence: an admin creates one on the Browser page.'
              }
              const active = chosen() ?? profileId
              return `Browser profiles (${list.length}):\n${list.map((p) => describe(p, active)).join('\n')}`
            } catch (error) {
              return `ERROR: could not list the browser profiles (${errorText(error)}).`
            }
          },
        } as never)
        tools[names('browser_use')] = tool({
          description:
            'Use another browser profile for the rest of this session (by its name from browser_profiles). Its logins and cookies come with it.',
          inputSchema: z.object({
            profile: z.string().min(1).describe('Name (or id) of the profile'),
          }),
          metadata: { risk: risk('browser_use', 'write') },
          execute: async (input: { profile: string }): Promise<string> => {
            try {
              const list = await choose.list(context)
              const wanted = input.profile.trim().toLowerCase()
              const byId = list.find((p) => p.id === input.profile.trim())
              const byName = list.filter((p) => p.name.toLowerCase() === wanted)
              const found = byId ?? (byName.length === 1 ? byName[0] : undefined)
              if (found === undefined) {
                return byName.length > 1
                  ? `ERROR: several profiles are named "${input.profile}"; use its id from browser_profiles.`
                  : `ERROR: there is no profile "${input.profile}" you may use. Call browser_profiles for the list.`
              }
              ctx.state.set('profile', found.id)
              return `Now using the browser profile "${found.name}" (${found.adapter}) for this session.`
            } catch (error) {
              return `ERROR: could not switch the browser profile (${errorText(error)}).`
            }
          },
        } as never)
      }

      /**
       * Wire-only: within a turn the loop keeps each step's tool results as they were produced, so
       * older screenshots still carry their image. Keep the newest `inModel` images, replace the
       * rest by their text line (the same rule `toModelOutput` applies to a stored history).
       */
      const shotTools = new Set([
        names('browser_open'),
        names('browser_act'),
        names('browser_scroll'),
        names('browser_screenshot'),
      ])
      const windowImages = (messages: ModelMessage[]): ModelMessage[] | undefined => {
        const hasImage = (part: unknown): boolean => {
          const out = (part as { output?: { type?: string; value?: unknown } }).output
          return (
            out?.type === 'content' &&
            Array.isArray(out.value) &&
            out.value.some(
              (v: { type?: string; mediaType?: string }) =>
                v.type === 'file' && v.mediaType?.startsWith('image/'),
            )
          )
        }
        const where: Array<[number, number]> = []
        messages.forEach((m, i) => {
          if (m.role !== 'tool') return
          m.content.forEach((part, j) => {
            if (part.type === 'tool-result' && shotTools.has(part.toolName) && hasImage(part)) {
              where.push([i, j])
            }
          })
        })
        const drop = where.slice(0, Math.max(0, where.length - inModel))
        if (drop.length === 0) return undefined
        const next = [...messages]
        for (const [i, j] of drop) {
          const message = messages[i] as Extract<ModelMessage, { role: 'tool' }>
          const part = message.content[j] as Extract<
            (typeof message.content)[number],
            { type: 'tool-result' }
          >
          const texts = (part.output as { value: Array<{ type: string; text?: string }> }).value
            .filter((v) => v.type === 'text')
            .map((v) => v.text)
            .join('\n')
          const content = [...(next[i] as typeof message).content]
          content[j] = {
            ...part,
            output: { type: 'text', value: `${texts}\n${OLDER_SCREENSHOT_TEXT}` },
          }
          next[i] = { ...message, content }
        }
        return next
      }

      // appended last: the order of the tools before it never changes (prompt-cache prefix)
      tools[names('browser_scroll')] = tool({
        description: SCROLL_DESCRIPTION,
        inputSchema: scrollInput,
        metadata: { risk: risk('browser_scroll', 'read') },
        toModelOutput: modelOutput,
        execute: async (
          input: ScrollToolInput,
          { abortSignal }: { abortSignal?: AbortSignal },
        ): Promise<string | BrowserShotRef> => {
          const amount =
            input.pages !== undefined && input.amount === undefined
              ? Math.round(Math.max(0.1, Math.min(25, input.pages)) * 800)
              : input.amount
          const ms = Math.max(0, Math.min(10_000, Math.floor(input.waitMs ?? 0)))
          return runAct(
            {
              kind: 'scroll',
              ...(input.ref === undefined ? {} : { ref: input.ref }),
              // a ref without a direction means "scroll to it"
              ...(input.direction === undefined && input.ref !== undefined
                ? {}
                : { direction: input.direction ?? 'down' }),
              ...(amount === undefined ? {} : { amount }),
            },
            abortSignal,
            ms > 0 ? { kind: 'wait', ms } : undefined,
          )
        },
      } as never)

      return {
        tools: tools as never,
        services: { browser: service },
        ...(shots
          ? {
              hooks: {
                'step.prepare': (_c: unknown, e: { messages: ModelMessage[] }) => {
                  const messages = windowImages(e.messages)
                  return messages === undefined ? undefined : { messages }
                },
              },
            }
          : {}),
      }
    },
  })
}
