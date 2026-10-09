/**
 * The `permissions` plugin: maps the permission engine onto eharness hooks (spec 18 §7).
 * `tool.approve` decides every call, `step.prepare` hides tools a mode or rule removes,
 * `tool.after` hides the paths a `Read` rule protects from listing outputs, and the plan-exit
 * tool lets the model leave plan mode once the user approved its plan.
 *
 * Built only with the public core API (ADR-0008).
 */
import { tool } from 'ai'
import { z } from 'zod/v4'
import {
  type ApprovalDecision,
  definePlugin,
  type HarnessContext,
  type HarnessPlugin,
} from '../index.ts'
import type { DecideOptions, PermissionEngine } from './engine.ts'
import type { ListingFormat, PermissionMode } from './types.ts'

/** The mode a plugin instance uses instead of the engine's: fixed, or computed per call. */
export type ModeSource =
  | PermissionMode
  | ((ctx: HarnessContext) => PermissionMode | undefined | Promise<PermissionMode | undefined>)

/** Options of {@link permissionsPlugin}. */
export interface PermissionsPluginOptions {
  engine: PermissionEngine
  /**
   * Mode of this plugin instance instead of the engine's global mode (spec 18 §7):
   * - a mode: fixed (`plan` makes a subagent's shell read-only whatever the main session runs
   *   in); the plugin registers no plan-exit tool then;
   * - a function: computed from the context at every decision (`ctx.session.id`), for a split
   *   web/server deployment where the mode lives in storage; it must be deterministic.
   * The engine's `dontAsk` mode still turns asks into denials and protected paths still ask.
   */
  mode?: ModeSource
  /** Only these tools (names or aliases like `Read`, `Edit`) are offered to the model. */
  allowedTools?: string[]
  /** These tools (names or aliases) are never offered to the model. */
  disallowedTools?: string[]
  /**
   * The plan-exit tool (`exit_plan_mode` by default): `false` to not register it. Its name must
   * be a tool of kind `plan-exit` in the engine's tool map. Default `true`.
   */
  planExitTool?: boolean | { name?: string; description?: string }
  /** Hide paths a `Read` deny/ask rule matches from `grep` / `list_files` / `glob` outputs. Default `true`. */
  filterOutputs?: boolean
  /** Every automatic approval decision and every answer (the core's `approval.decided` hook): an audit log. */
  onDecision?: (decision: ApprovalDecision) => void | Promise<void>
  /**
   * The user approved the plan and the plan-exit tool ran: the mode to continue in. The engine's
   * mode is switched already; store it here when the mode lives elsewhere (split web/server).
   */
  onPlanExit?: (mode: PermissionMode, ctx: HarnessContext) => void | Promise<void>
}

const GREP_LINE = /^(.*?):\d+: /
const LIST_LINE = /^(.*) \(\d+ bytes\)$/

/** Path of one output line of a listing tool (undefined for notes). */
function linePath(format: ListingFormat, line: string): string | undefined {
  if (format === 'grep') return GREP_LINE.exec(line)?.[1]
  if (format === 'list') return LIST_LINE.exec(line)?.[1]
  return line.startsWith('/') ? line : undefined
}

/**
 * Drop the lines of a listing output whose path a `Read` deny or ask rule (the built-in `.env*`
 * included) matches, and say how many were hidden.
 */
function filterListing(
  engine: PermissionEngine,
  format: ListingFormat,
  output: string,
): string | undefined {
  let hidden = 0
  const kept: string[] = []
  for (const line of output.split('\n')) {
    const path = linePath(format, line)
    if (path !== undefined && engine.readBlocked(path)) hidden++
    else kept.push(line)
  }
  if (hidden === 0) return undefined
  kept.push(`(${hidden} results hidden by permission rules)`)
  return kept.join('\n')
}

const EXIT_PLAN_DESCRIPTION =
  'Call this in plan mode, once you have explored enough, with the complete implementation plan ' +
  '(markdown). The user reviews it; when they approve, plan mode ends and you can edit files and ' +
  'run commands. If they reject it, revise the plan from their feedback and call this again.'

/**
 * Create the permissions plugin (name `permissions`).
 *
 * `turn.prepare` has no tool list in its event, so tool availability is applied in `step.prepare`
 * only (it runs before every model call, so a mode change takes effect at the next step).
 */
export function permissionsPlugin(opts: PermissionsPluginOptions): HarnessPlugin<'permissions'> {
  const { engine } = opts
  const modeOption = opts.mode
  const fixed = typeof modeOption === 'string'
  const expand = (names: readonly string[]): Set<string> =>
    new Set(names.flatMap((name) => [...engine.expandRuleTool(name)]))
  const allowed = opts.allowedTools === undefined ? undefined : expand(opts.allowedTools)
  const disallowed = expand(opts.disallowedTools ?? [])
  const filterOutputs = opts.filterOutputs !== false

  const exit =
    opts.planExitTool === false || fixed
      ? undefined
      : {
          name:
            (typeof opts.planExitTool === 'object' ? opts.planExitTool.name : undefined) ??
            engine.toolsOfKind('plan-exit')[0] ??
            'exit_plan_mode',
          description:
            (typeof opts.planExitTool === 'object' ? opts.planExitTool.description : undefined) ??
            EXIT_PLAN_DESCRIPTION,
        }

  /** The mode of this call: the plugin's, else `undefined` (the engine's own). */
  const modeOf = async (ctx: HarnessContext): Promise<PermissionMode | undefined> =>
    typeof modeOption === 'function' ? await modeOption(ctx) : modeOption

  return definePlugin({
    name: 'permissions',
    setup: () => ({
      hooks: {
        'tool.approve': async (ctx, e) => {
          const own = await modeOf(ctx as HarnessContext)
          const turn = (ctx as HarnessContext).turn
          const options: DecideOptions = { toolCallId: e.toolCallId, transcript: e.transcript }
          if (own !== undefined) options.mode = own
          if (turn?.abortSignal !== undefined) options.abortSignal = turn.abortSignal
          const decision = await engine.decideAsync(
            { toolName: e.toolName, input: e.input },
            options,
          )
          switch (decision.status) {
            case 'approved':
              return { type: 'approved' as const }
            case 'user-approval':
              return decision.reason === undefined
                ? { type: 'user-approval' as const }
                : { type: 'user-approval' as const, reason: decision.reason }
            case 'denied':
              return { type: 'denied' as const, reason: decision.reason }
          }
        },
        'step.prepare': async (ctx, e) => {
          const own = await modeOf(ctx as HarnessContext)
          const current = own ?? engine.mode
          const leavingPlan =
            !fixed &&
            exit !== undefined &&
            current === 'plan' &&
            (e.continuing?.approved.includes(exit.name) ?? false)
          const inactive = new Set(
            engine.inactiveTools(
              leavingPlan ? (engine.planExitMode() ?? engine.modeBeforePlan()) : own,
              e.toolNames,
            ),
          )
          const active = e.toolNames.filter(
            (name) =>
              !inactive.has(name) &&
              !disallowed.has(name) &&
              (allowed === undefined || allowed.has(name)),
          )
          return active.length === e.toolNames.length ? undefined : { activeTools: active }
        },
        'tool.after': (_ctx, e) => {
          if (!filterOutputs || typeof e.output !== 'string') return
          const format = engine.toolSpec(e.toolName)?.listing
          if (format === undefined) return
          const output = filterListing(engine, format, e.output)
          return output === undefined ? undefined : { output }
        },
        'approval.decided': async (_ctx, e) => {
          // a person approved something: a paused auto mode resumes
          if (e.by === 'user' && e.approved) engine.noteApproval()
          await opts.onDecision?.(e)
        },
      },
    }),
    session: (ctx) => {
      if (exit === undefined) return
      return {
        tools: {
          [exit.name]: tool({
            description: exit.description,
            inputSchema: z.object({
              plan: z.string().describe('The complete implementation plan, in markdown'),
            }),
            metadata: { risk: 'external' },
            // runs only after the user approved the call: to the mode the user chose when
            // approving the plan, else back to the mode before plan mode
            execute: async (): Promise<string> => {
              const target = engine.leavePlanMode()
              engine.setMode(target)
              await opts.onPlanExit?.(target, ctx as HarnessContext)
              return 'The user approved the plan. Plan mode is off; start implementing it now.'
            },
          }),
        },
      }
    },
  })
}
