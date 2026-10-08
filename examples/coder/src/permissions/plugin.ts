/**
 * The `permissions` plugin: maps the permission engine onto eharness hooks. `tool.approve`
 * decides every call, `step.prepare` hides tools a mode or rule removes, and `exit_plan_mode`
 * lets the model leave plan mode once the user approved its plan.
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { tool } from 'ai'
import { definePlugin } from 'eharness'
import { z } from 'zod/v4'
import { type PermissionEngine, TOOL } from '../contracts.ts'
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
  const { engine } = opts
  const allowed = opts.allowedTools === undefined ? undefined : new Set(expand(opts.allowedTools))
  const disallowed = new Set(expand(opts.disallowedTools ?? []))
  const auditFile = opts.auditFile

  return definePlugin({
    name: 'permissions',
    setup: () => ({
      tools: {
        [TOOL.exitPlan]: tool({
          description: EXIT_PLAN_DESCRIPTION,
          inputSchema: z.object({
            plan: z.string().describe('The complete implementation plan, in markdown'),
          }),
          metadata: { risk: 'external' },
          // runs only after the user approved the call
          execute: async (): Promise<string> => {
            engine.setMode('default')
            return 'The user approved the plan. Plan mode is off; start implementing it now.'
          },
        }),
      },
      hooks: {
        'tool.approve': (_ctx, e) => {
          const call: { toolName: string; input: unknown; agent?: string } = {
            toolName: e.toolName,
            input: e.input,
          }
          if (opts.agent !== undefined) call.agent = opts.agent
          const decision = engine.decide(call)
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
          const leavingPlan = engine.mode === 'plan' && endsWithApprovedPlan(e.messages)
          const inactive = new Set(engine.inactiveTools(leavingPlan ? 'default' : undefined))
          const active = e.toolNames.filter(
            (name) =>
              !inactive.has(name) &&
              !disallowed.has(name) &&
              (allowed === undefined || allowed.has(name)),
          )
          return active.length === e.toolNames.length ? undefined : { activeTools: active }
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
