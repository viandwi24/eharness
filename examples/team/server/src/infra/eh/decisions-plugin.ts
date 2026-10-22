/**
 * `decisions` plugin (docs/plans/P40-team-autonomous-operations.md, D5): the tools an agent uses
 * to ask the client for a decision, and the hook that turns a `needs_decision` report into one.
 *
 *  - `propose_plan`      DM chats and the heartbeat. An ordinary tool: it stores a proposal and
 *                        returns its id; the session is not parked.
 *  - `escalate`          program runs and routine runs (the heartbeat never parks).
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
import type { ProgramNoteInput } from '../../app/programs.ts'
import {
  ESCALATE_DESCRIPTION,
  ESCALATE_WAIT_DESCRIPTION,
  MAX_OPTION_CHARS,
  MAX_OPTIONS,
  PROGRAM_NOTE_DESCRIPTION,
  PROPOSE_PLAN_DESCRIPTION,
  REQUEST_AUTHORITY_DESCRIPTION,
} from '../../domain/decisions.ts'
import { MAX_BRIEF_CHARS, parseProgramSession, parseReport } from '../../domain/programs.ts'
import { profileOfSession } from '../../domain/run-profiles.ts'
import type { TaskReport } from '../../domain/tasks.ts'

export const PROPOSE_PLAN_TOOL = 'propose_plan'
export const ESCALATE_TOOL = 'escalate'
/** `escalate` with the run parked until the client answers (the default `escalate` does not wait). */
export const ESCALATE_WAIT_TOOL = 'escalate_wait'
export const REQUEST_AUTHORITY_TOOL = 'request_authority'
/** Chat tool: the standing agreements of a program (never authority, gates, schedule or budget). */
export const PROGRAM_NOTE_TOOL = 'program_note'
/** Rules that approve these tools: asking for a decision never needs a permission of its own. */
export const DECISION_TOOLS = [
  PROPOSE_PLAN_TOOL,
  ESCALATE_TOOL,
  ESCALATE_WAIT_TOOL,
  REQUEST_AUTHORITY_TOOL,
] as const

/** What the plugin needs from the app (`app/decisions.ts` over the deps, built in `main.ts`). */
export interface DecisionIntake {
  propose(input: ProposeInput): { id: string; duplicate?: boolean; merged?: string[] }
  escalate(input: EscalateInput): { id: string }
  /** `program_note`: text for the model, errors thrown as DomainError. */
  programNote(input: ProgramNoteInput): string | Promise<string>
  amend(input: AmendInput): { id: string }
  /** A run ended with `needs_decision` and did not escalate. */
  reportNeedsDecision(input: { agentId: string; sessionId: string; report: TaskReport }): void
}

export interface DecisionsPluginOptions {
  /** Late-bound: the plugin is built before the app deps. */
  intake: () => DecisionIntake | undefined
  /** The agent of a hook context (`ctx.agent.id` is the slug of the definition). */
  agentOf: (slug: string) => { id: string } | undefined
  /**
   * Why a `request_authority` for these tools can never help (the tool does not exist for this
   * agent), or undefined. The call is then refused with that text instead of parking the run.
   */
  unavailable?: (
    sessionId: string,
    asked: { tools?: string[]; read?: string[]; write?: string[] },
  ) => string | undefined
  /** The team timezone: the zone of a plan's cron when the model names none (default UTC). */
  timezone?: () => string
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
  agent: z
    .string()
    .optional()
    .describe('Required: slug of the agent that will run the plan (see your team).'),
  program: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'CHANGE an existing program of the agent: its id or exact name. Then every other field is a patch: give only what changes, never `name`. Absent: a new program (`name` and `brief` required).',
    ),
  name: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe('Name of the NEW program (required unless `program` is set).'),
  brief: z
    .string()
    .min(1)
    .max(MAX_BRIEF_CHARS)
    .optional()
    .describe(
      'What the agent does, step by step, and where it saves results (required for a new program; with `program`, the new brief).',
    ),
  addAuthority: authoritySchema
    .optional()
    .describe('Change only: authority to ADD to the program (kept as is otherwise).'),
  removeAuthority: authoritySchema
    .optional()
    .describe('Change only: exact authority entries to REMOVE from the program.'),
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
      z.object({
        cron: z.string().min(1),
        timezone: z
          .string()
          .optional()
          .describe('IANA zone of the cron. Leave it out to use the team timezone.'),
      }),
      z.object({ everyMinutes: z.number().int().min(1) }),
      z.literal('manual').describe('Change only: stop the schedule; run only by hand.'),
    ])
    .optional()
    .describe(
      'Standing programs only: when it runs. Absent: runs only when the client says (a new program) or stays as is (a change).',
    ),
  report: z.enum(['digest', 'task', 'silent']).optional(),
  deliverables: z
    .array(
      z.object({
        path: z
          .string()
          .min(1)
          .max(500)
          .describe(
            'Library file the run must leave. Tokens: {date}, {slug}, {runId}, {program}. Example: /library/reports/{slug}/{date}.md',
          ),
        kind: z.enum(['markdown', 'json', 'any']),
        requiredSections: z
          .array(z.string().min(1).max(200))
          .max(30)
          .optional()
          .describe('Markdown only: headings the file must have.'),
        schema: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('JSON only: a JSON Schema the file must match.'),
        minChars: z.number().int().min(1).optional(),
      }),
    )
    .max(20)
    .optional()
    .describe(
      'Files each run must leave in the library. The server checks them when the run ends (exists, headings, JSON schema) and gives the agent one turn to fix what fails.',
    ),
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
  standDown: z
    .array(z.string().min(1).max(MAX_OPTION_CHARS))
    .max(MAX_OPTIONS)
    .optional()
    .describe(
      'The options (exact labels from `options`) that only mean "leave it for now" (keep waiting, skip): if the client picks one, you are not asked about the same record again for a week. Never flag an option that does something.',
    ),
})

const escalateInputSchema = escalateSchema.extend({
  wait: z
    .boolean()
    .optional()
    .describe(
      'Default false: the question goes to the client and you carry on. true: pause this run until the client answers (use `escalate_wait`).',
    ),
})

const noteSchema = z.object({
  action: z.enum(['list', 'add', 'remove']),
  program: z
    .string()
    .optional()
    .describe('Program name or id. `list` without it shows every program.'),
  text: z
    .string()
    .max(1000)
    .optional()
    .describe('add: the agreement, one short sentence. remove: the note text or its number.'),
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
  answeredBy: z.string().optional().describe('Who answered and where.'),
  attribution: z.string().optional().describe('How to attribute the decision when you mention it.'),
})

const NOT_WAITING_TEXT =
  'The question is with the client now. Do not act on it and do not wait for it: finish the rest ' +
  'of your job and end this run normally (final report). When the client answers, this run ' +
  'continues as a new message with the answer, and only then you act on it.'
const WAIT_REDIRECT_TEXT =
  'To pause this run until the client answers, call `escalate_wait` with the same input. Nothing ' +
  'was asked yet. If something else can still be done, call `escalate` without `wait` instead.'

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
              const { id, duplicate, merged } = intake().propose({
                agentId: self().id,
                sessionId,
                title: input.title,
                body: input.body,
                runner: input.agent,
                runOnce: input.runOnce ?? false,
                target: input.program,
                addAuthority: input.addAuthority,
                removeAuthority: input.removeAuthority,
                program: {
                  name: input.name,
                  brief: input.brief,
                  authority: input.authority,
                  gates: input.gates,
                  escalation: input.escalation,
                  forbidden: input.forbidden,
                  budget: input.budget,
                  report: input.report,
                  deliverables: input.deliverables,
                  ...(input.schedule === undefined
                    ? {}
                    : input.schedule === 'manual'
                      ? { trigger: { kind: 'manual' as const } }
                      : {
                          trigger: {
                            kind: 'schedule' as const,
                            spec:
                              'cron' in input.schedule
                                ? {
                                    kind: 'cron' as const,
                                    expr: input.schedule.cron,
                                    tz: input.schedule.timezone ?? options.timezone?.() ?? 'UTC',
                                  }
                                : {
                                    kind: 'every' as const,
                                    everyMs: input.schedule.everyMinutes * 60_000,
                                  },
                          },
                        }),
                },
              })
              if (duplicate === true) {
                return `A proposal like this is already open: ${id}. It was not created again; it waits for the client in the Decision Center. Do not propose it again: tell the client it is there, and carry on with other work.`
              }
              if (input.program !== undefined && merged !== undefined) {
                return `Change proposal ${id} is waiting for the client in the Decision Center. It carries the earlier open change to this program too (${merged.join(', ')}, now closed as merged), so the client sees one card with the whole change. The program is unchanged until the client approves. Tell the client there is one change to approve, and carry on with other work.`
              }
              if (input.program !== undefined) {
                return `Change proposal ${id} is waiting for the client in the Decision Center. The program is unchanged until the client approves; do not act as if it were changed. Tell the client what you proposed and carry on with other work.`
              }
              return `Proposal ${id} is waiting for the client in the Decision Center. Nothing started and nothing is granted yet; do not act as if it were approved. Tell the client what you proposed and carry on with other work.`
            } catch (error) {
              return `ERROR: could not propose the plan: ${text(error)}`
            }
          },
        })
      }
      if (origin === 'dm') {
        // agreements about a program: who may call it is the channel role check (risk 'write':
        // members are refused in a channel chat); in the web chat it is the client
        tools[PROGRAM_NOTE_TOOL] = tool({
          description: PROGRAM_NOTE_DESCRIPTION,
          inputSchema: noteSchema,
          metadata: { risk: 'write', idempotent: false },
          execute: async (input): Promise<string> => {
            try {
              return await intake().programNote(input)
            } catch (error) {
              return `ERROR: ${text(error)}`
            }
          },
        })
      }
      if (origin === 'program' || origin === 'routine' || origin === 'task') {
        // not parked by default: the question is stored without a wait and the run carries on;
        // the answer continues the session as a new message (like a report-made escalation)
        tools[ESCALATE_TOOL] = tool({
          description: ESCALATE_DESCRIPTION,
          inputSchema: escalateInputSchema,
          metadata: { risk: 'write', idempotent: true },
          execute: (input): string => {
            if (input.wait === true) return WAIT_REDIRECT_TEXT
            try {
              intake().escalate({
                agentId: self().id,
                sessionId,
                waitId: null,
                title: input.title,
                question: input.question,
                details: input.details,
                options: input.options,
                standDown: input.standDown,
              })
              return NOT_WAITING_TEXT
            } catch (error) {
              return `ERROR: could not ask the client: ${text(error)}`
            }
          },
        })
        // for the rare run that can do nothing else: parks until the client answers
        tools[ESCALATE_WAIT_TOOL] = externalTool({
          description: ESCALATE_WAIT_DESCRIPTION,
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
              standDown: input.standDown,
            })
            return { payload: { decisionId: id } }
          },
        })
      }
      if (origin === 'program') {
        tools[REQUEST_AUTHORITY_TOOL] = externalTool({
          description: REQUEST_AUTHORITY_DESCRIPTION,
          // an input that fails here is answered to the model as an error, the run does not park
          inputSchema: authoritySchemaAsk.superRefine((value, refinement) => {
            const why = options.unavailable?.(sessionId, value)
            if (why !== undefined) refinement.addIssue({ code: 'custom', message: why })
          }),
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
            if (e.stop !== 'complete') return
            const report = parseReport(e.output)
            if (report?.status !== 'needs_decision') return
            if (parseProgramSession(sessionId) === undefined) return
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
