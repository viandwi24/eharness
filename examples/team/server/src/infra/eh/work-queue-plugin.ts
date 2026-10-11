/**
 * `workQueue` plugin (docs/plans/P40-team-autonomous-operations.md, D6): the tools of the work
 * queue.
 *
 *  - Manager tools `create_task`, `list_tasks`, `update_task`: the lead in its DM chat and the
 *    heartbeat, and any program run (a program that names them in its authority; the engine of a
 *    run is closed-world, so offering them there grants nothing).
 *  - Worker tool `complete_task`: program runs. Each task of a worker program runs in a session of
 *    its own (`program-service.ts`), so the tool needs no id: it completes the task of this
 *    session. Claiming is not a tool: the run claims the next task in code (`claimNext`, one
 *    atomic step), so the model never picks its own work and two runs never take the same task.
 *
 * Every tool returns text, including errors (the model reads it and corrects itself).
 */
import { tool } from 'ai'
import { definePlugin, errorText, type HarnessContext, type HarnessPlugin } from 'eharness'
import { z } from 'zod'
import { DomainError } from '../../app/errors.ts'
import { simulatedTaskText } from '../../domain/rehearsal.ts'
import { profileOfSession } from '../../domain/run-profiles.ts'
import { BOARD_COLUMNS, TASK_PRIORITIES, type Task } from '../../domain/tasks.ts'
import type { TaskDraft, TaskPatch } from '../../domain/work-queue.ts'
import { costText, describeTask, taskLine } from '../../domain/work-queue.ts'
import { rehearsalSessions } from './rehearsal-registry.ts'

export const CREATE_TASK_TOOL = 'create_task'
export const LIST_TASKS_TOOL = 'list_tasks'
export const UPDATE_TASK_TOOL = 'update_task'
export const COMPLETE_TASK_TOOL = 'complete_task'
/** Rules that approve these tools in chats: queueing work needs no permission of its own. */
export const WORK_QUEUE_TOOLS = [
  CREATE_TASK_TOOL,
  LIST_TASKS_TOOL,
  UPDATE_TASK_TOOL,
  COMPLETE_TASK_TOOL,
] as const

/** What the plugin needs from the app (`app/work-queue.ts` over the deps, built in `main.ts`). */
export interface WorkQueueIntake {
  create(input: TaskDraft & { createdBy: string }): Task
  list(query: {
    column?: (typeof BOARD_COLUMNS)[number] | undefined
    agentId?: string | undefined
    program?: string | undefined
    limit?: number | undefined
  }): Array<{ task: Task; column: string }>
  update(id: string, patch: TaskPatch): Task
  cancel(id: string): Task
  /** The program of a program run names this tool in its authority. */
  authorizes(sessionId: string, toolName: string): boolean
  complete(
    sessionId: string,
    input: { summary: string; outputs: string[] },
  ): Promise<{ ok: true; task: Task } | { ok: false; error: string }>
}

export interface WorkQueuePluginOptions {
  /** Late-bound: the plugin is built before the app deps. */
  intake: () => WorkQueueIntake | undefined
  /** The agent of a hook context (`ctx.agent.id` is the slug of the definition). */
  agentOf: (slug: string) => { id: string; role: string } | undefined
}

const path = z
  .string()
  .regex(/^\/[^\n]*$/, 'a library path starting with /')
  .max(500)

const due = z
  .string()
  .describe('Due date as YYYY-MM-DD or an ISO date-time.')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'not a date')

const createSchema = z.object({
  agent: z.string().min(1).describe('Slug of the agent that does the task (its owner).'),
  title: z.string().min(1).max(200).describe('One line: what the task is.'),
  brief: z
    .string()
    .max(20_000)
    .optional()
    .describe(
      'What to do in markdown: the goal, the background, what the result looks like and where to save it. The worker starts with an empty context, so this is everything it knows.',
    ),
  inputs: z.array(path).max(50).optional().describe('Library paths the task starts from.'),
  priority: z.enum(TASK_PRIORITIES).optional().describe('Default normal.'),
  due: due.optional(),
})

const listSchema = z.object({
  column: z
    .enum(BOARD_COLUMNS)
    .optional()
    .describe(
      'queued, running, waiting (waits for the client), review (finished, not accepted yet) or done.',
    ),
  agent: z.string().optional().describe('Only the tasks of this agent (slug).'),
  program: z
    .string()
    .optional()
    .describe('Only the runs of this program (its id or name), e.g. to see what it spent.'),
  limit: z.number().int().min(1).max(100).optional(),
})

const updateSchema = z.object({
  id: z.string().min(1).describe('Task id (from list_tasks).'),
  title: z.string().min(1).max(200).optional(),
  brief: z.string().max(20_000).optional(),
  inputs: z.array(path).max(50).optional(),
  priority: z.enum(TASK_PRIORITIES).optional().describe('Re-prioritise.'),
  due: due.nullable().optional().describe('null removes the due date.'),
  agent: z.string().optional().describe('Reassign to this agent (slug).'),
  cancel: z.boolean().optional().describe('true: cancel the task.'),
})

const completeSchema = z.object({
  summary: z.string().min(1).max(2000).describe('What you did, in a few sentences.'),
  outputs: z
    .array(path)
    .max(100)
    .describe('Library paths of everything you made for this task. They must exist.'),
})

const text = (error: unknown): string =>
  error instanceof DomainError ? error.message : errorText(error)

export const CREATE_TASK_DESCRIPTION =
  'Put a task in the work queue of an agent. The task waits as Queued on the board until a worker program of that agent picks it up (priority first, then the nearest due date, then the oldest). The client sees it and may change or cancel it. Write a complete brief.'
export const LIST_TASKS_DESCRIPTION =
  'Read the task board: each task with its column (queued, running, waiting, review, done), owner, priority and what it cost so far (its own session). Filter by column, agent or program; the total cost of the rows is at the end. Use it before queueing work, so you do not queue the same thing twice, and to answer what a run or a program cost.'
export const UPDATE_TASK_DESCRIPTION =
  'Change a task that has not started: re-prioritise, reassign, rewrite, set a due date, or cancel it. A task that runs or finished cannot be changed.'
export const COMPLETE_TASK_DESCRIPTION =
  'Mark the task of this run done: a short summary and the library paths of what you made (they must exist). The client then reviews it. Call it once the work is verified, then give your final report.'

const dueAt = (value: string): number => Date.parse(value)

/** A rehearsal does not touch the real board: the call is recorded and the model told so. */
function simulateTask(
  sessionId: string,
  tool: string,
  input: unknown,
  kind: 'create' | 'update',
  detail: string,
): string {
  rehearsalSessions.get(sessionId)?.recorder.simulated({ tool, input })
  return simulatedTaskText(kind, detail)
}

/** `complete_task` of a rehearsal: the outputs must exist in the overlay, nothing else changes. */
async function completeInRehearsal(
  sessionId: string,
  input: { summary: string; outputs: string[] },
): Promise<string> {
  const rehearsal = rehearsalSessions.get(sessionId)
  const missing: string[] = []
  for (const path of input.outputs) {
    if ((await rehearsal?.fs.stat?.(path)) == null) missing.push(path)
  }
  if (missing.length > 0) {
    return `ERROR: these outputs do not exist: ${missing.join(', ')}. Write them first, then call complete_task again.`
  }
  rehearsal?.recorder.simulated({ tool: COMPLETE_TASK_TOOL, input })
  return 'SIMULATED: this is a rehearsal, so the task is not completed on the board. Treat it as complete and give your final report, listing the same outputs.'
}

export function workQueue(options: WorkQueuePluginOptions): HarnessPlugin<'work-queue'> {
  return definePlugin({
    name: 'work-queue',
    session: (rawCtx) => {
      const ctx = rawCtx as HarnessContext
      const sessionId = ctx.session.id
      const origin = profileOfSession(sessionId, ctx.session.parent !== undefined).origin
      const agent = options.agentOf(ctx.agent.id)
      const intake = (): WorkQueueIntake => {
        const found = options.intake()
        if (found === undefined) throw new Error('the work queue is not ready')
        return found
      }
      const self = (): { id: string; role: string } => {
        if (agent === undefined) throw new Error(`unknown agent ${ctx.agent.id}`)
        return agent
      }

      const tools: Record<string, unknown> = {}
      // a program run is offered a manager tool only when its authority names it (the engine of a
      // run is closed-world anyway: this keeps tools it can never use out of its prompt)
      const offered = (name: string): boolean =>
        origin === 'program' || origin === 'rehearsal'
          ? intake().authorizes(sessionId, name)
          : (origin === 'dm' || origin === 'heartbeat') && agent?.role === 'lead'
      if (offered(CREATE_TASK_TOOL)) {
        tools[CREATE_TASK_TOOL] = tool({
          description: CREATE_TASK_DESCRIPTION,
          inputSchema: createSchema,
          metadata: { risk: 'write', idempotent: false },
          execute: (input): string => {
            if (origin === 'rehearsal') {
              return simulateTask(
                sessionId,
                CREATE_TASK_TOOL,
                input,
                'create',
                `${input.title} for ${input.agent}`,
              )
            }
            try {
              const task = intake().create({
                agentId: input.agent,
                title: input.title,
                brief: input.brief,
                inputs: input.inputs,
                priority: input.priority,
                dueAt: input.due === undefined ? undefined : dueAt(input.due),
                createdBy: self().id,
              })
              return `Queued task ${task.id} for ${input.agent}: ${task.title}. It starts when a worker program of that agent runs.`
            } catch (error) {
              return `ERROR: could not queue the task: ${text(error)}`
            }
          },
        })
      }
      if (offered(LIST_TASKS_TOOL)) {
        tools[LIST_TASKS_TOOL] = tool({
          description: LIST_TASKS_DESCRIPTION,
          inputSchema: listSchema,
          metadata: { risk: 'read', idempotent: true },
          execute: (input): string => {
            try {
              const rows = intake().list({
                column: input.column,
                agentId: input.agent,
                program: input.program,
                limit: input.limit,
              })
              if (rows.length === 0) return 'No tasks match.'
              const total = rows.reduce((sum, r) => sum + r.task.costUsd, 0)
              return [
                ...rows.map((r) => taskLine(r.task, r.column)),
                `Cost of these ${rows.length} task(s): ${costText(total)} (what their sessions really spent).`,
              ].join('\n')
            } catch (error) {
              return `ERROR: could not read the board: ${text(error)}`
            }
          },
        })
      }
      if (offered(UPDATE_TASK_TOOL)) {
        tools[UPDATE_TASK_TOOL] = tool({
          description: UPDATE_TASK_DESCRIPTION,
          inputSchema: updateSchema,
          metadata: { risk: 'write', idempotent: false },
          execute: (input): string => {
            if (origin === 'rehearsal') {
              return simulateTask(
                sessionId,
                UPDATE_TASK_TOOL,
                input,
                'update',
                input.cancel === true ? `cancel ${input.id}` : input.id,
              )
            }
            try {
              if (input.cancel === true) {
                const task = intake().cancel(input.id)
                return `Cancelled task ${task.id}: ${task.title}.`
              }
              const task = intake().update(input.id, {
                agentId: input.agent,
                title: input.title,
                brief: input.brief,
                inputs: input.inputs,
                priority: input.priority,
                dueAt:
                  input.due === undefined
                    ? undefined
                    : input.due === null
                      ? null
                      : dueAt(input.due),
              })
              return `Updated.\n${describeTask(task)}`
            } catch (error) {
              return `ERROR: could not update the task: ${text(error)}`
            }
          },
        })
      }
      if (
        (origin === 'program' || origin === 'rehearsal') &&
        intake().authorizes(sessionId, COMPLETE_TASK_TOOL)
      ) {
        tools[COMPLETE_TASK_TOOL] = tool({
          description: COMPLETE_TASK_DESCRIPTION,
          inputSchema: completeSchema,
          metadata: { risk: 'write', idempotent: true },
          execute: async (input): Promise<string> => {
            if (origin === 'rehearsal') return completeInRehearsal(sessionId, input)
            try {
              const done = await intake().complete(sessionId, input)
              return done.ok
                ? `Recorded: task ${done.task.id} is complete and goes to the client's review once your final report is in. List the same outputs in it.`
                : `ERROR: ${done.error}`
            } catch (error) {
              return `ERROR: could not complete the task: ${text(error)}`
            }
          },
        })
      }
      return { tools: tools as never }
    },
  })
}
