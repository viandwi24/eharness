/**
 * The `subagent()` plugin (spec 20): the `agent` tool, which runs a subagent as a child session.
 *
 * Built only with the public core API (ADR-0008). Three approval strategies for the child
 * (ADR-0034, ADR-0035): `'inline'` (answered in process), `'park'` (the parent parks as an
 * external wait; the answer arrives through the child session, from any instance) and `'policy'`
 * (answered automatically).
 *
 * This file only assembles a session's contribution; the phases live in their own modules over
 * the explicit `Env` (configuration) and `Scope` (one session's state): `entries.ts` (directory),
 * `routing.ts` (messages and their tools), `modes.ts` + `lifecycle.ts` (the execution modes),
 * `park-hook.ts` (park mode), `child-run.ts` (driving a child turn).
 *
 * @see docs/specs/20-subagent-plugin.md
 */
import { z } from 'zod/v4'
import {
  definePlugin,
  errorText,
  type HarnessPlugin,
  type SessionContribution,
  type ToolInput,
} from '../index.ts'
import { reconcileBackgroundChildren } from './background.ts'
import { closeChild, resolveCatalog, sleep } from './child-run.ts'
import {
  BACKGROUND_DEFAULT_FIELD,
  BACKGROUND_FIELD,
  NAME_FIELD,
  toolDescription,
} from './descriptions.ts'
import { rebuildEntries } from './entries.ts'
import { createEnv, type Env, type Scope } from './env.ts'
import { FILES_FIELD } from './files.ts'
import {
  AGENT_NAME_PATTERN,
  type AgentDirectory,
  createDirectory,
  DIRECTORY_RUNTIME_KEY,
  dropDirectory,
  rosterText,
} from './messaging.ts'
import { parkMarkers, parkTool, resumeEntry, runTool } from './modes.ts'
import {
  createParkHook,
  DEFAULT_BACKGROUND_TIMEOUT_MS,
  reconcileSubagentWaits,
} from './park-hook.ts'
import { messageTool, outputTool, route, stopTool } from './routing.ts'
import { createSubagentTaskRegistry, type SubagentTasks } from './tasks.ts'
import {
  type AnySession,
  type Ctx,
  runPart,
  type SubagentDefinition,
  type SubagentOptions,
} from './types.ts'

export {
  pendingSubagentApprovals,
  reconcileSubagentWaits,
  type SubagentReconcileEntry,
  subagentChild,
  subagentWaitId,
} from './park-hook.ts'
export {
  AGENT_OUTPUT_PAGE_CHARS,
  AGENT_OUTPUT_TOOL,
  AGENT_REPORT_MAX_CHARS,
  AGENT_TOOL,
  SUBAGENT_DENIED,
  SUBAGENT_NO_CLIENT,
  SUBAGENT_NO_USER,
  type SubagentApprovalAnswer,
  type SubagentApprovalRequest,
  type SubagentCatalog,
  type SubagentChildInfo,
  type SubagentDataParts,
  type SubagentDefinition,
  type SubagentFile,
  type SubagentFilesOptions,
  type SubagentOptions,
  type SubagentProgress,
  type SubagentRunData,
} from './types.ts'

declare module '../index.ts' {
  interface HarnessServices {
    /** Provided by `subagent()`: the background subagents this session started. */
    subagentTasks: SubagentTasks
  }
}

/** The directory of a session: its own children (park), or the root's shared one (ADR-0038). */
function directoryFor(env: Env, ctx: Ctx): AgentDirectory | undefined {
  if (!env.messaging) return undefined
  // park: the directory holds this session's own children, rebuilt from storage; messages
  // travel over the durable inbox (ADR-0041)
  if (env.park) return createDirectory(ctx.session.id, undefined)
  if (ctx.session.parent !== undefined) {
    return (
      (ctx.runtime[DIRECTORY_RUNTIME_KEY] as AgentDirectory | undefined) ??
      createDirectory(ctx.session.id, undefined)
    )
  }
  return createDirectory(ctx.session.id, async (text, data) => {
    await ctx.session.inject(
      'eh.event',
      { name: 'agent-message', text, data },
      { deliver: 'next-step', wake: true },
    )
  })
}

/** Open a child of `scope`'s session on the agent of `info.agent` (catalog key). */
function openChildOf(
  scope: Scope,
  catalog: Record<string, SubagentDefinition>,
): (id: string, info: { agent?: string }) => AnySession {
  return (id, info) => {
    const key =
      info.agent !== undefined && catalog[info.agent] !== undefined
        ? info.agent
        : (Object.keys(catalog)[0] as string)
    return (catalog[key] as SubagentDefinition).agent.session(
      id,
      scope.env.childOptions({
        parentSessionId: scope.ctx.session.id,
        agent: key,
        depth: scope.depth + 1,
      }),
    ) as AnySession
  }
}

/**
 * `session.start` of a `'park'` session: reconcile the waits of children that finished while no
 * instance ran, and (root, `background`) the background children, then keep doing the latter on a
 * timer. Detached: opening the session must not wait for (or fail on) it.
 */
function reconcileOnOpen(
  scope: Scope,
  self: () => ReturnType<NonNullable<SubagentOptions['selfAgent']>>,
): void {
  const { env, ctx } = scope
  const { options } = env
  void (async () => {
    await sleep(0)
    if (ctx.signal.aborted) return
    const parentSession = self().session(
      ctx.session.id,
      env.parentOptions(ctx.session.id),
    ) as AnySession
    const catalog = resolveCatalog(options.agents)
    const openChild = openChildOf(scope, catalog)
    await reconcileSubagentWaits(parentSession, {
      openChild,
      ...(options.onParentRun === undefined ? {} : { onParentRun: options.onParentRun }),
      log: ctx.log,
    })
    if (!env.backgroundOn || !scope.isRoot) return
    const bg = typeof options.background === 'object' ? options.background : {}
    const bgTimeoutMs = bg.timeoutMs ?? DEFAULT_BACKGROUND_TIMEOUT_MS
    const runBackground = async (): Promise<void> => {
      if (ctx.signal.aborted) return
      await reconcileBackgroundChildren(parentSession, {
        openChild,
        ...(Number.isFinite(bgTimeoutMs) ? { timeoutMs: bgTimeoutMs } : {}),
        stopOnTimeout: bg.stopOnTimeout ?? true,
        ...(bg.startGraceMs === undefined ? {} : { startGraceMs: bg.startGraceMs }),
        ...(bg.waitingReminderMs === undefined ? {} : { waitingReminderMs: bg.waitingReminderMs }),
        ...(options.maxReportChars === undefined ? {} : { maxReportChars: options.maxReportChars }),
        ...(env.outputEnabled ? { outputToolName: env.outputToolName } : {}),
        ...(env.messaging ? { messageToolName: env.messageToolName } : {}),
        log: ctx.log,
      })
    }
    await runBackground()
    const everyMs =
      bg.reconcileEveryMs ??
      (Number.isFinite(bgTimeoutMs)
        ? Math.min(60_000, Math.max(1_000, Math.floor(bgTimeoutMs / 4)))
        : 0)
    if (everyMs > 0) {
      const timer = setInterval(() => {
        runBackground().catch((error) =>
          ctx.log.warn('subagent: background reconcile failed', { error: errorText(error) }),
        )
      }, everyMs)
      ;(timer as { unref?: () => void }).unref?.()
      ctx.signal.addEventListener('abort', () => clearInterval(timer), { once: true })
    }
  })().catch((error) =>
    ctx.log.warn('subagent: reconcile on open failed', { error: errorText(error) }),
  )
}

/**
 * The subagent plugin: contributes the `agent` tool and the `data-subagent.run` part.
 *
 * @see docs/specs/20-subagent-plugin.md
 */
export function subagent(options: SubagentOptions): HarnessPlugin<'subagent'> {
  const env = createEnv(options)
  const parkHook = createParkHook({
    parentAgent: options.parentAgent,
    onParentRun: options.onParentRun,
    parentSession: options.parentSession,
    reportResumes: env.park,
    maxReportChars: env.reportMax,
    ...(env.outputEnabled ? { outputToolName: env.outputToolName } : {}),
  })

  return definePlugin({
    name: 'subagent',
    provides: ['subagentTasks'],
    dataParts: { run: runPart },
    session: (ctx) => {
      const depth = ctx.session.parent?.depth ?? 0
      const isRoot = ctx.session.parent === undefined
      const dir = directoryFor(env, ctx)
      let defsCache: Record<string, SubagentDefinition> | undefined
      const getDefs = (): Record<string, SubagentDefinition> => {
        defsCache ??= resolveCatalog(options.agents)
        return defsCache
      }
      let scope: Scope | undefined
      const registry = createSubagentTaskRegistry({
        foreign: async (childSessionId) => {
          // not a task of this process: ask the child session to abort, wherever it runs
          for (const [agentKey, def] of Object.entries(resolveCatalog(options.agents))) {
            const child = def.agent.session(
              childSessionId,
              env.childOptions({
                parentSessionId: ctx.session.id,
                agent: agentKey,
                depth: depth + 1,
              }),
            ) as AnySession
            try {
              const out = await child.abort('stopped')
              if (out.target !== 'idle') return
            } catch {
              // try the next agent
            } finally {
              await closeChild(def, childSessionId)
            }
          }
        },
        send: async (to, message) => {
          if (scope === undefined) return { ok: false, error: 'ERROR: the session is not ready.' }
          const text = message.trim()
          if (text === '') return { ok: false, error: 'ERROR: the message is empty.' }
          const routed = await route(scope, { kind: 'user' }, to, text)
          return routed.kind === 'error' || routed.kind === 'dropped'
            ? { ok: false, error: routed.text }
            : {
                ok: true,
                status: routed.kind === 'resumed' ? 'resumed' : 'delivered',
                id: routed.id,
              }
        },
      })
      const current: Scope = {
        env,
        ctx,
        registry,
        dir,
        depth,
        defs: getDefs,
        rebuilt: false,
        isRoot,
        rebuiltAt: 0,
        resume: (entry, text, sender) => resumeEntry(current, entry, text, sender),
      }
      scope = current
      const hooks: Record<string, unknown> = {
        'turn.start': parkHook.start,
        'turn.end': parkHook.end,
      }
      if (env.park && options.selfAgent !== undefined) {
        const self = options.selfAgent
        hooks['session.start'] = () => reconcileOnOpen(current, self)
      }
      const tools: Record<string, ToolInput> = {}
      if (depth < env.maxDepth && Object.keys(getDefs()).length > 0) {
        const defs = getDefs()
        // resolved once per session so the description (and the prompt-cache prefix) stays stable
        const description = toolDescription(defs, env.messaging ? env.messageToolName : undefined)
        const canBackground =
          env.backgroundOn && (ctx.session.parent === undefined || env.backgroundInChildren)
        const inputSchema = z.object({
          subagent_type: z
            .enum(Object.keys(defs) as [string, ...string[]])
            .describe('The subagent type to use'),
          description: z.string().describe('A short (3-5 words) label for the task'),
          prompt: z.string().describe('The complete task for the subagent'),
          ...(options.files === undefined
            ? {}
            : { files: z.array(z.string()).optional().describe(FILES_FIELD) }),
          ...(canBackground
            ? {
                run_in_background: z
                  .boolean()
                  .optional()
                  .describe(env.backgroundDefault ? BACKGROUND_DEFAULT_FIELD : BACKGROUND_FIELD),
              }
            : {}),
          ...(env.messaging
            ? { name: z.string().regex(AGENT_NAME_PATTERN).optional().describe(NAME_FIELD) }
            : {}),
        })
        if (env.park) {
          // the run marker of every call, written while the step still streams: the park tool
          // starts its child after the step ended, when nothing can be written to the message
          hooks['step.end'] = parkMarkers(current, defs, canBackground)
        }
        tools[env.toolName] = env.park
          ? parkTool(current, description, inputSchema, canBackground)
          : runTool(current, description, inputSchema)
      }
      if (env.messaging) tools[env.messageToolName] = messageTool(current, env.messageToolName)
      if (env.outputEnabled) tools[env.outputToolName] = outputTool(current, env.outputToolName)
      if (env.stopEnabled) tools[env.stopToolName] = stopTool(current)
      if (dir !== undefined) {
        hooks['step.prepare'] = async () => {
          const self = dir.entries.get(ctx.session.id)
          if (self !== undefined) self.queued.length = 0
          if (isRoot) dir.mainQueued.length = 0
          await rebuildEntries(current)
          const text = rosterText(dir, ctx.session.id, isRoot, env.messageToolName)
          return text === undefined ? undefined : { reminder: text }
        }
      }
      const dispose = (): void => {
        void registry.stopAll()
        if (dir !== undefined && isRoot) dropDirectory(dir)
      }
      return {
        tools,
        hooks,
        services: { subagentTasks: registry as SubagentTasks },
        dispose,
      } as SessionContribution
    },
  }) as unknown as HarnessPlugin<'subagent'>
}
