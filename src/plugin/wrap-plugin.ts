import { definePlugin } from './define-plugin.ts'
import type {
  AgentSetupContext,
  DataPartMap,
  HarnessContext,
  HarnessHooks,
  HarnessPlugin,
  HookName,
  KindMap,
  PluginContribution,
  SessionContribution,
} from './types.ts'

// biome-ignore lint/suspicious/noExplicitAny: generic function shape of a hook
type AnyFn = (...args: any[]) => any

/**
 * `next` of a hook override: calls the inner plugin's hook. Called without arguments it receives
 * the original arguments; pass arguments to replace them (e.g. a narrowed event). Resolves to the
 * inner hook's result, or `undefined` when the inner plugin has no such hook.
 */
export type WrapHookNext<H extends AnyFn> = (
  ...replacement: [] | Parameters<H>
) => Promise<Awaited<ReturnType<H>> | undefined>

/**
 * Override of one hook: same arguments as the hook itself (`ctx`, then the event if any), plus
 * `next` last.
 */
export type WrapHookOverride<H extends AnyFn> = (
  ...args: [...Parameters<H>, next: WrapHookNext<H>]
) => ReturnType<H>

/** Hook overrides of {@link WrapPluginOverrides}, keyed by hook name. */
export type WrapHookOverrides<DP extends DataPartMap = Record<never, never>> = {
  [K in HookName]?: WrapHookOverride<NonNullable<HarnessHooks<DP>[K]>>
}

/**
 * `next` of the session override. `next()` runs the inner plugin's session phase;
 * `next(ctx)` runs it with another context (e.g. a derived one); `next.using(other)` runs the
 * **session phase of another plugin** instead (for per-session configuration: build the other
 * plugin from `ctx.runtime`).
 */
export interface WrapSessionNext<DP extends DataPartMap = Record<never, never>> {
  (ctx?: HarnessContext<DP>): Promise<SessionContribution<DP> | undefined>
  using(
    // biome-ignore lint/suspicious/noExplicitAny: any plugin that exposes the same data parts
    other: HarnessPlugin<string, any, any>,
    ctx?: HarnessContext<DP>,
  ): Promise<SessionContribution<DP> | undefined>
}

/**
 * Overrides of {@link wrapPlugin}. Everything is optional; what is not overridden is delegated to
 * the inner plugin unchanged.
 */
export interface WrapPluginOverrides<
  DP extends DataPartMap = Record<never, never>,
  Name extends string = string,
> {
  /**
   * New plugin name (default: the inner plugin's name). Renaming changes the namespace of the
   * plugin's data parts, kinds and persisted state (`plugins[<name>]`), so keep the default for a
   * plugin that already has stored sessions.
   */
  name?: Name
  /**
   * Intercept the agent phase (sync, pure like `setup`). `next()` returns the inner contribution
   * (or `undefined`).
   */
  setup?(
    ctx: AgentSetupContext,
    next: (ctx?: AgentSetupContext) => PluginContribution<DP> | undefined,
  ): PluginContribution<DP> | undefined
  /**
   * Intercept the session phase. Return the (possibly modified) contribution; `services` must still
   * match the inner plugin's `provides`. `dispose` of the returned contribution is what runs on
   * close — wrap it yourself if you replace the inner contribution.
   */
  session?(
    ctx: HarnessContext<DP>,
    next: WrapSessionNext<DP>,
  ): Promise<SessionContribution<DP> | undefined> | SessionContribution<DP> | undefined
  /**
   * Intercept hooks. Each override wraps the inner registration of that hook, so hook order and
   * the plugin's own phases are unchanged. A hook the inner plugin does not register is added (in
   * the session phase) with a `next` that resolves to `undefined`. Overrides also apply to hooks
   * returned by a `setup` / `session` override.
   */
  hooks?: WrapHookOverrides<DP>
}

function wrapHooks(
  hooks: Record<string, AnyFn> | undefined,
  overrides: Record<string, AnyFn>,
): Record<string, AnyFn> | undefined {
  if (hooks === undefined && Object.keys(overrides).length === 0) return undefined
  const out: Record<string, AnyFn> = { ...hooks }
  for (const [name, override] of Object.entries(overrides)) {
    const inner = hooks?.[name]
    if (inner === undefined) continue
    out[name] = (...args: unknown[]) =>
      override(...args, (...replacement: unknown[]) =>
        Promise.resolve(inner(...(replacement.length > 0 ? replacement : args))),
      )
  }
  return out
}

/**
 * Wrap a plugin: a new plugin with the same name (or `overrides.name`), data parts, kinds,
 * services (`provides` / `requires`), version and contributions, whose setup phase, session phase
 * and hooks you can intercept. The way to add per-request configuration to a shipped plugin
 * (`approvalGuard`, `memory`, `todos`, `filesystem`) without reading its internals.
 *
 * Without overrides the wrapper delegates everything. Wrapping works on any plugin, including an
 * already wrapped one, and the result goes through the same boot validation as any plugin (names,
 * services, ordering). Hook order is unchanged: an override wraps the inner hook where it was
 * registered. For `tool.approve`, the wrapper decides how to combine its answer with the inner
 * one; to keep the guarantee that a plugin can only tighten, never return `'approved'`.
 *
 * @example
 * ```ts
 * import { wrapPlugin } from 'eharness'
 * import { approvalGuard } from 'eharness/guard'
 *
 * // the judge model comes from the request (`send(..., { runtime: { judge } })`)
 * const guard = wrapPlugin(approvalGuard({ model: defaultJudge }), {
 *   session: (ctx, next) =>
 *     ctx.runtime.judge === undefined
 *       ? next()
 *       : next.using(approvalGuard({ model: ctx.runtime.judge as LanguageModel })),
 *   hooks: {
 *     // skip review entirely for trusted requests
 *     'tool.approve': (ctx, e, next) => (ctx.runtime.trusted === true ? undefined : next()),
 *   },
 * })
 * ```
 * @throws {TypeError} when a hook override is not a function.
 * @throws {HarnessError} `EH_CONFIG_INVALID` for an invalid `overrides.name`.
 * @see docs/specs/01-agent-and-plugins.md#21-wrapping-a-plugin
 */
export function wrapPlugin<
  const Name extends string,
  const DP extends DataPartMap = Record<never, never>,
  const MK extends KindMap = Record<never, never>,
  const NewName extends string = Name,
>(
  plugin: HarnessPlugin<Name, DP, MK>,
  overrides: WrapPluginOverrides<DP, NewName> = {},
): HarnessPlugin<NewName, DP, MK> {
  const inner = plugin['~def']
  const hookOverrides = (overrides.hooks ?? {}) as Record<string, AnyFn>
  for (const [hook, fn] of Object.entries(hookOverrides)) {
    if (typeof fn !== 'function') {
      throw new TypeError(`wrapPlugin: hook override '${hook}' must be a function.`)
    }
  }
  // hooks the setup phase registered (the session phase adds only the missing ones)
  let setupHooks = new Set<string>()

  const setup =
    inner.setup === undefined && overrides.setup === undefined
      ? undefined
      : (ctx: AgentSetupContext): PluginContribution<DP> | undefined => {
          const next = (c: AgentSetupContext = ctx): PluginContribution<DP> | undefined =>
            (inner.setup?.call(inner, c) as PluginContribution<DP> | undefined) ?? undefined
          const contribution = overrides.setup === undefined ? next() : overrides.setup(ctx, next)
          setupHooks = new Set(Object.keys(contribution?.hooks ?? {}))
          if (contribution === undefined || contribution === null) return undefined
          const hooks = wrapHooks(contribution.hooks as Record<string, AnyFn>, hookOverrides)
          return hooks === undefined
            ? contribution
            : { ...contribution, hooks: hooks as HarnessHooks<DP> }
        }

  const needsSession =
    inner.session !== undefined ||
    overrides.session !== undefined ||
    Object.keys(hookOverrides).length > 0
  const session = !needsSession
    ? undefined
    : async (ctx: HarnessContext<DP>): Promise<SessionContribution<DP> | undefined> => {
        const run = async (
          def: { session?: unknown },
          c: HarnessContext<DP>,
        ): Promise<SessionContribution<DP> | undefined> => {
          const fn = def.session as ((ctx: HarnessContext<DP>) => unknown) | undefined
          if (fn === undefined) return undefined
          return ((await fn.call(def, c)) as SessionContribution<DP> | undefined) ?? undefined
        }
        const next = Object.assign((c: HarnessContext<DP> = ctx) => run(inner, c), {
          // biome-ignore lint/suspicious/noExplicitAny: any plugin with the same data parts
          using: (other: HarnessPlugin<string, any, any>, c: HarnessContext<DP> = ctx) =>
            run(other['~def'], c),
        }) as WrapSessionNext<DP>
        const contribution =
          overrides.session === undefined
            ? await next()
            : ((await overrides.session(ctx, next)) ?? undefined)
        const base: SessionContribution<DP> = contribution ?? {}
        const hooks: Record<string, AnyFn> = {
          ...wrapHooks(base.hooks as Record<string, AnyFn> | undefined, hookOverrides),
        }
        // overrides of hooks nobody registered: add them with an empty `next`
        for (const [name, override] of Object.entries(hookOverrides)) {
          if (name in hooks || setupHooks.has(name)) continue
          hooks[name] = (...args: unknown[]) => override(...args, () => Promise.resolve(undefined))
        }
        if (Object.keys(hooks).length === 0) return contribution
        return { ...base, hooks: hooks as HarnessHooks<DP> }
      }

  return definePlugin({
    name: (overrides.name ?? plugin.name) as NewName,
    ...(inner.version === undefined ? {} : { version: inner.version }),
    ...(inner.provides === undefined ? {} : { provides: inner.provides }),
    ...(inner.requires === undefined ? {} : { requires: inner.requires }),
    ...(inner.dataParts === undefined ? {} : { dataParts: inner.dataParts }),
    ...(inner.messageKinds === undefined ? {} : { messageKinds: inner.messageKinds }),
    ...(setup === undefined ? {} : { setup }),
    ...(session === undefined ? {} : { session }),
  } as never) as unknown as HarnessPlugin<NewName, DP, MK>
}
