/**
 * `decisions` plugin (docs/plans/P40-team-autonomous-operations.md, D5): the tools an agent uses
 * to ask the client for a decision, and the hook that turns a `needs_decision` report into one.
 *
 *  - `propose_plan`      DM chats and the heartbeat. An ordinary tool: it stores a proposal and
 *                        returns its id; the session is not parked.
 *  - `escalate`          every unattended or task session (program runs, routine runs, heartbeat).
 *                        An `externalTool()`: the turn parks on the external wait `w_<toolCallId>`
 *                        (spec 11 §4.2), `start` stores the decision (idempotent by wait id), and
 *                        deciding it calls `session.resolveWait(waitId, { output })` in whichever
 *                        instance, which continues the SAME assistant message with the decision as
 *                        the tool output.
 *  - `request_authority` program runs only: the same park, for an amendment.
 *
 * No `correlationId` is returned from `start` on purpose: the child side of the subagent plugin
 * (`reconcileSubagentWaits`, run when a session opens) reads the correlation id of ANY external
 * wait as the id of a child session and tries to settle it. The decision id rides in `payload`.
 *
 * Which tools a session gets depends on its origin (`domain/run-profiles.ts`), so the set is the
 * same for every turn of one session. Delegated children of the lead get none (their parent is
 * parked on them; they ask through the lead).
 */
import { tool } from 'ai'
import {
  definePlugin,
  errorText,
  externalTool,
  type HarnessContext,
  type HarnessPlugin,
} from 'eharness'
import { z } from 'zod'
import type { AmendInput, EscalateInput, ProposeInput } from '../../app/decisions.ts'
import { DomainError } from '../../app/errors.ts'
import {
  ESCALATE_DESCRIPTION,
  MAX_OPTION_CHARS,
  MAX_OPTIONS,
  PROPOSE_PLAN_DESCRIPTION,
  REQUEST_AUTHORITY_DESCRIPTION,
} from '../../domain/decisions.ts'
import { MAX_BRIEF_CHARS, parseProgramSession, parseReport } from '../../domain/programs.ts'
import { profileOfSession } from '../../domain/run-profiles.ts'
import type { TaskReport } from '../../domain/tasks.ts'

export const PROPOSE_PLAN_TOOL = 'propose_plan'
export const ESCALATE_TOOL = 'escalate'
export const REQUEST_AUTHORITY_TOOL = 'request_authority'
/** Rules that approve these tools: asking for a decision never needs a permission of its own. */
export const DECISION_TOOLS = [PROPOSE_PLAN_TOOL, ESCALATE_TOOL, REQUEST_AUTHORITY_TOOL] as const

/** What the plugin needs from the app (`app/decisions.ts` over the deps, built in `main.ts`). */
export interface DecisionIntake {
  propose(input: ProposeInput): { id: string }
  escalate(input: EscalateInput): { id: string }
  amend(input: AmendInput): { id: string }
  /** A run ended with `needs_decision` and did not escalate. */
  reportNeedsDecision(input: { agentId: string; sessionId: string; report: TaskReport }): void
}

export interface DecisionsPluginOptions {
  /** Late-bound: the plugin is built before the app deps. */
  intake: () => DecisionIntake | undefined
  /** The agent of a hook context (`ctx.agent.id` is the slug of the definition). */
  agentOf: (slug: string) => { id: string } | undefined
}

const list = z.array(z.string().min(1).max(500)).max(100)
const glob = z
  .string()
  .regex(/^\/[^\n]*$/, 'a library path glob starting with /')
  .max(500)
const rule = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]+(\([^\n]*\))?$/, 'a tool name or a rule like Tool(specifier)')
  .max(500)

const authoritySchema = z.object({
  tools: z
    .array(rule)
    .max(100)
    .optional()
    .describe('Tool names or rules, e.g. web_fetch or Bash(git status).'),
  connectors: list.optional().describe('Connector or connection ids: every tool of them.'),
  read: z
    .array(glob)
    .max(100)
    .optional()
    .describe('Library path globs to read, e.g. /library/data/**.'),
  write: z
    .array(glob)
    .max(100)
    .optional()
    .describe('Library path globs to read and write, e.g. /library/reports/**.'),
})

const proposeSchema = z.object({
  title: z.string().min(1).max(200).describe('One line: what the plan is.'),
  body: z
    .string()
    .max(MAX_BRIEF_CHARS)
    .optional()
    .describe('The pitch in markdown: goal, steps, why, links to the evidence (library paths).'),
  agent: z.string().optional().describe('Slug of the agent that will run it. Default: you.'),
  name: z.string().min(1).max(120).describe('Name of the program.'),
  brief: z
    .string()
    .min(1)
    .max(MAX_BRIEF_CHARS)
    .describe('What the agent does, step by step, and where it saves results.'),
  authority: authoritySchema
    .optional()
    .describe('Exactly what the run may use. Least authority that works.'),
  gates: list.optional().describe('Actions that must still ask the client first.'),
  escalation: z.string().max(MAX_BRIEF_CHARS).optional().describe('When the run stops and asks.'),
  forbidden: z.array(rule).max(100).optional().describe('Rules denied in every case.'),
  budget: z
    .object({
      perRunUsd: z.number().positive().nullable().optional(),
      perDayUsd: z.number().positive().nullable().optional(),
    })
    .optional(),
  schedule: z
    .union([
      z.object({ cron: z.string().min(1), timezone: z.string().optional() }),
      z.object({ everyMinutes: z.number().int().min(1) }),
    ])
    .optional()
    .describe('Standing programs only: when it runs. Absent: runs only when the client says.'),
  report: z.enum(['digest', 'task', 'silent']).optional(),
  runOnce: z
    .boolean()
    .optional()
    .describe('true: a one-off plan, run once when approved. false (default): a standing program.'),
})

const escalateSchema = z.object({
  title: z.string().min(1).max(200).describe('One line: what you need decided.'),
  question: z.string().min(1).max(2000).describe('The question for the client.'),
  details: z
    .string()
    .max(MAX_BRIEF_CHARS)
    .optional()
    .describe('What you found, in markdown, with library paths as evidence.'),
  options: z
    .array(z.string().min(1).max(MAX_OPTION_CHARS))
    .max(MAX_OPTIONS)
    .optional()
    .describe('Alternatives to pick from (short labels). Absent: approve or reject.'),
})

const authoritySchemaAsk = z.object({
  tools: authoritySchema.shape.tools,
  connectors: authoritySchema.shape.connectors,
  read: authoritySchema.shape.read,
  write: authoritySchema.shape.write,
  why: z.string().min(1).max(2000).describe('Why the run needs it.'),
})

const answerSchema = z.object({
  decision: z.string().describe('"approved", "rejected" or the option the client picked.'),
  note: z.string().describe('Note from the client (may be empty).'),
})

const text = (error: unknown): string =>
  error instanceof DomainError ? error.message : errorText(error)

export function decisions(options: DecisionsPluginOptions): HarnessPlugin<'decisions'> {
  return definePlugin({
    name: 'decisions',
    session: (rawCtx) => {
      const ctx = rawCtx as HarnessContext
      const sessionId = ctx.session.id
      const origin = profileOfSession(sessionId, ctx.session.parent !== undefined).origin
      const self = (): { id: string } => {
        const agent = options.agentOf(ctx.agent.id)
        if (agent === undefined) throw new Error(`unknown agent ${ctx.agent.id}`)
        return agent
      }
      const intake = (): DecisionIntake => {
        const found = options.intake()
        if (found === undefined) throw new Error('the Decision Center is not ready')
        return found
      }

      const tools: Record<string, unknown> = {}
      if (origin === 'dm' || origin === 'heartbeat') {
        tools[PROPOSE_PLAN_TOOL] = tool({
          description: PROPOSE_PLAN_DESCRIPTION,
          inputSchema: proposeSchema,
          metadata: { risk: 'write', idempotent: false },
          execute: (input): string => {
            try {
              const { id } = intake().propose({
                agentId: self().id,
                sessionId,
                title: input.title,
                body: input.body,
                runner: input.agent,
                runOnce: input.runOnce ?? false,
                program: {
                  name: input.name,
                  brief: input.brief,
                  authority: input.authority,
                  gates: input.gates,
                  escalation: input.escalation,
                  forbidden: input.forbidden,
                  budget: input.budget,
                  report: input.report,
                  ...(input.schedule === undefined
                    ? {}
                    : {
                        trigger: {
                          kind: 'schedule' as const,
                          spec:
                            'cron' in input.schedule
                              ? {
                                  kind: 'cron' as const,
                                  expr: input.schedule.cron,
                                  tz: input.schedule.timezone ?? 'UTC',
                                }
                              : {
                                  kind: 'every' as const,
                                  everyMs: input.schedule.everyMinutes * 60_000,
                                },
                        },
                      }),
                },
              })
              return `Proposal ${id} is waiting for the client in the Decision Center. Nothing started and nothing is granted yet; do not act as if it were approved. Tell the client what you proposed and carry on with other work.`
            } catch (error) {
              return `ERROR: could not propose the plan: ${text(error)}`
            }
          },
        })
      }
      if (origin === 'program' || origin === 'routine' || origin === 'heartbeat') {
        tools[ESCALATE_TOOL] = externalTool({
          description: ESCALATE_DESCRIPTION,
          inputSchema: escalateSchema,
          outputSchema: answerSchema,
          metadata: { risk: 'write', idempotent: true },
          start: (input, { waitId }) => {
            const { id } = intake().escalate({
              agentId: self().id,
              sessionId,
              waitId,
              title: input.title,
              question: input.question,
              details: input.details,
              options: input.options,
            })
            return { payload: { decisionId: id } }
          },
        })
      }
      if (origin === 'program') {
        tools[REQUEST_AUTHORITY_TOOL] = externalTool({
          description: REQUEST_AUTHORITY_DESCRIPTION,
          inputSchema: authoritySchemaAsk,
          outputSchema: answerSchema,
          metadata: { risk: 'write', idempotent: true },
          start: (input, { waitId }) => {
            const { id } = intake().amend({
              agentId: self().id,
              sessionId,
              waitId,
              authority: {
                tools: input.tools ?? [],
                connectors: input.connectors ?? [],
                read: input.read ?? [],
                write: input.write ?? [],
              },
              why: input.why,
            })
            return { payload: { decisionId: id } }
          },
        })
      }

      return {
        tools: tools as never,
        hooks: {
          // a program run that ends `needs_decision` without having escalated: make it a decision
          'turn.end': (hookCtx: HarnessContext, e: { stop: string; output?: unknown }): void => {
            if (parseProgramSession(sessionId) === undefined || e.stop !== 'complete') return
            const report = parseReport(e.output)
            if (report?.status !== 'needs_decision') return
            try {
              intake().reportNeedsDecision({ agentId: self().id, sessionId, report })
            } catch (error) {
              hookCtx.log.warn(`decisions: could not record the report: ${errorText(error)}`)
            }
          },
        } as never,
      }
    },
  })
}
