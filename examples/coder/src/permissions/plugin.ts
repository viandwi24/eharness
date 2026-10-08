/**
 * The `permissions` plugin: maps the permission engine onto eharness hooks. `tool.approve`
 * decides every call, `step.prepare` hides tools a mode or rule removes, `tool.after` hides the
 * paths a `Read` rule protects from `grep`/`list_files`/`glob` output, and `exit_plan_mode` lets
 * the model leave plan mode (back to the mode it came from) once the user approved its plan.
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { tool } from 'ai'
import { definePlugin } from 'eharness'
import { z } from 'zod/v4'
import { type PermissionEngine, type PermissionMode, TOOL } from '../contracts.ts'
import type { PermissionEngineExtras } from './engine.ts'
import { toolsForRuleTool } from './rules.ts'

/** Options of {@link permissionsPlugin}. */
export interface PermissionsPluginOptions {
  engine: PermissionEngine
  /** Subagent name, recorded in the audit log and passed to the engine. */
  agent?: string
  /** Only these tools (names or aliases like `Read`, `Edit`) are offered to the model. */
  allowedTools?: string[]
  /** These tools (names or aliases) are never offered to the model. */
  disallowedTools?: string[]
  /** JSON-lines audit log of every approval decision. */
  auditFile?: string
  /**
   * Per-agent mode: every `decide` and `inactiveTools` call of this plugin instance uses it
   * instead of the engine's global mode (`plan` makes a subagent's bash read-only whatever the
   * main session runs in). The global `dontAsk` still turns asks into denials and protected paths
   * still ask. The plugin registers no `exit_plan_mode` tool then: only the main session leaves
   * plan mode.
   */
  mode?: PermissionMode
}

/** Tools whose output lists paths (and so can leak the names/lines of files a rule hides). */
const LISTING_TOOLS = new Set<string>([TOOL.grep, TOOL.list, TOOL.glob])

const GREP_LINE = /^(.*?):\d+: /
const LIST_LINE = /^(.*) \(\d+ bytes\)$/

function isExtras(engine: PermissionEngine): engine is PermissionEngineExtras {
  return typeof (engine as Partial<PermissionEngineExtras>).readBlocked === 'function'
}

/** Path of one output line of `grep`, `list_files` or `glob` (undefined for notes). */
function linePath(toolName: string, line: string): string | undefined {
  if (toolName === TOOL.grep) return GREP_LINE.exec(line)?.[1]
  if (toolName === TOOL.list) return LIST_LINE.exec(line)?.[1]
  return line.startsWith('/') ? line : undefined
}

/**
 * Drop the lines of a `grep` / `list_files` / `glob` output whose path a `Read` deny or ask rule
 * (the built-in `.env*` included) matches, and say how many were hidden.
 */
function filterListing(
  engine: PermissionEngineExtras,
  toolName: string,
  output: string,
): string | undefined {
  let hidden = 0
  const kept: string[] = []
  for (const line of output.split('\n')) {
    const path = linePath(toolName, line)
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

interface WirePart {
  type?: string
  approvalId?: string
  toolCallId?: string
  toolName?: string
  approved?: boolean
}

/**
 * True when the wire ends with the user's approval of an `exit_plan_mode` call: the first step of a
 * `respond()` continuation is prepared before the approved tool runs, so the tool list must
 * already follow the mode that the call is about to switch to.
 */
function endsWithApprovedPlan(
  messages: ReadonlyArray<{ role?: string; content?: unknown }>,
): boolean {
  const last = messages.at(-1)
  const before = messages.at(-2)
  if (last?.role !== 'tool' || before?.role !== 'assistant') return false
  if (!Array.isArray(last.content) || !Array.isArray(before.content)) return false
  const calls = new Map<string, string>()
  const requests = new Map<string, string>()
  for (const part of before.content as WirePart[]) {
    if (part.type === 'tool-call' && part.toolCallId !== undefined && part.toolName !== undefined) {
      calls.set(part.toolCallId, part.toolName)
    } else if (
      part.type === 'tool-approval-request' &&
      part.approvalId !== undefined &&
      part.toolCallId !== undefined
    ) {
      requests.set(part.approvalId, part.toolCallId)
    }
  }
  return (last.content as WirePart[]).some((part) => {
    if (part.type !== 'tool-approval-response' || part.approved !== true) return false
    const callId = requests.get(part.approvalId ?? '')
    return callId !== undefined && calls.get(callId) === TOOL.exitPlan
  })
}

function expand(names: readonly string[]): string[] {
  return names.flatMap((name) => [...toolsForRuleTool(name)])
}

/**
 * Create the permissions plugin (name `permissions`).
 *
 * `turn.prepare` has no tool list in its event, so tool availability is applied in
 * `step.prepare` only (it runs before every model call, so a mode change takes effect at the
 * next step).
 */
export function permissionsPlugin(opts: PermissionsPluginOptions): ReturnType<typeof definePlugin> {
  const { engine, mode } = opts
  const allowed = opts.allowedTools === undefined ? undefined : new Set(expand(opts.allowedTools))
  const disallowed = new Set(expand(opts.disallowedTools ?? []))
  const auditFile = opts.auditFile

  const exitPlanTools =
    mode !== undefined
      ? undefined
      : {
          [TOOL.exitPlan]: tool({
            description: EXIT_PLAN_DESCRIPTION,
            inputSchema: z.object({
              plan: z.string().describe('The complete implementation plan, in markdown'),
            }),
            metadata: { risk: 'external' },
            // runs only after the user approved the call: to the mode the user chose when
            // approving the plan, else back to the mode before plan mode
            execute: async (): Promise<string> => {
              engine.setMode(isExtras(engine) ? engine.leavePlanMode() : 'default')
              return 'The user approved the plan. Plan mode is off; start implementing it now.'
            },
          }),
        }

  return definePlugin({
    name: 'permissions',
    setup: () => ({
      tools: exitPlanTools,
      hooks: {
        'tool.approve': (_ctx, e) => {
          const call: { toolName: string; input: unknown; agent?: string } = {
            toolName: e.toolName,
            input: e.input,
          }
          if (opts.agent !== undefined) call.agent = opts.agent
          const decision = engine.decide(call, mode)
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
        'step.prepare': (_ctx, e) => {
          const leavingPlan =
            mode === undefined && engine.mode === 'plan' && endsWithApprovedPlan(e.messages)
          const inactive = new Set(
            engine.inactiveTools(
              leavingPlan
                ? isExtras(engine)
                  ? (engine.planExitMode() ?? engine.modeBeforePlan())
                  : 'default'
                : mode,
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
          if (!LISTING_TOOLS.has(e.toolName) || typeof e.output !== 'string') return
          if (!isExtras(engine)) return
          const output = filterListing(engine, e.toolName, e.output)
          return output === undefined ? undefined : { output }
        },
        'approval.decided': async (_ctx, e) => {
          if (auditFile === undefined) return
          try {
            const line = JSON.stringify({
              at: new Date().toISOString(),
              agent: opts.agent,
              toolName: e.toolName,
              approved: e.approved,
              by: e.by,
              reason: e.reason,
              input: e.input,
            })
            await mkdir(dirname(auditFile), { recursive: true })
            await appendFile(auditFile, `${line}\n`)
          } catch {
            // the audit log must never break a turn
          }
        },
      },
    }),
  })
}
