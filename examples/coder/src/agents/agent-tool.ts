/** The `agent` tool: runs a subagent as a child session and streams its progress. */
import { type LanguageModelUsage, readUIMessageStream, tool } from 'ai'
import type { HarnessAgent, HarnessRun, ToolInput } from 'eharness'
import { z } from 'zod/v4'
import type {
  AgentDefinition,
  AgentProgress,
  ApprovalBroker,
  CoderMessage,
  PermissionEngine,
  ToolCallInfo,
} from '../contracts.ts'
import { driveTurn } from './drive.ts'

/** Dependencies of {@link createAgentTool}. */
export interface AgentToolDeps {
  /** Definitions available to spawn (already filtered by depth / Agent(...) rules by the caller if needed). */
  definitions(): AgentDefinition[]
  /** The HarnessAgent for a definition at a nesting depth (1 = child of the main agent); the caller caches it. */
  // biome-ignore lint/suspicious/noExplicitAny: agents of different configs share one loose type
  agentFor(def: AgentDefinition, depth: number): HarnessAgent<any>
  broker: ApprovalBroker
  permissions: PermissionEngine
  describe(call: ToolCallInfo): Promise<{ title: string; detail?: string; suggestedRule?: string }>
  /** Default 8 concurrent children per process. */
  maxConcurrent?: number
}

const THROTTLE_MS = 100

interface Semaphore {
  acquire(signal?: AbortSignal): Promise<boolean>
  release(): void
}

function createSemaphore(max: number): Semaphore {
  let running = 0
  const waiters: Array<() => void> = []
  return {
    async acquire(signal) {
      if (running < max) {
        running++
        return true
      }
      return await new Promise<boolean>((resolve) => {
        const onAbort = (): void => {
          const i = waiters.indexOf(grant)
          if (i >= 0) waiters.splice(i, 1)
          resolve(false)
        }
        const grant = (): void => {
          signal?.removeEventListener('abort', onAbort)
          resolve(true)
        }
        waiters.push(grant)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
    release() {
      const next = waiters.shift()
      if (next !== undefined) next()
      else running--
    },
  }
}

const semaphores = new WeakMap<AgentToolDeps, Semaphore>()

function semaphoreFor(deps: AgentToolDeps): Semaphore {
  let s = semaphores.get(deps)
  if (s === undefined) {
    s = createSemaphore(deps.maxConcurrent ?? 8)
    semaphores.set(deps, s)
  }
  return s
}

function usageOf(u: {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  cacheWriteTokens?: number
}): LanguageModelUsage {
  return {
    inputTokens: u.inputTokens,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: u.cachedInputTokens,
      cacheWriteTokens: u.cacheWriteTokens,
    },
    outputTokens: u.outputTokens,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    totalTokens: u.inputTokens + u.outputTokens,
  }
}

function textOf(message: CoderMessage | undefined, afterLastStep: boolean): string {
  if (message === undefined) return ''
  let parts = message.parts
  if (afterLastStep) {
    const i = parts.map((p) => p.type).lastIndexOf('step-start')
    if (i >= 0) parts = parts.slice(i)
  }
  return parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
    .trim()
}

function shortArg(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value !== '') {
      const line = value.replace(/\s+/g, ' ').trim()
      return line.length > 60 ? `${line.slice(0, 59)}…` : line
    }
  }
  return ''
}

/** Steps and latest tool of one streamed message. */
function inspect(message: CoderMessage): { steps: number; lastTool?: string } {
  let steps = 0
  let lastTool: string | undefined
  for (const part of message.parts) {
    if (part.type === 'step-start') steps++
    else if (part.type.startsWith('tool-') || part.type === 'dynamic-tool') {
      const p = part as { type: string; toolName?: string; input?: unknown }
      const name = p.type === 'dynamic-tool' ? (p.toolName ?? 'tool') : p.type.slice(5)
      const arg = shortArg(p.input)
      lastTool = arg === '' ? name : `${name} ${arg}`
    }
  }
  return { steps: Math.max(steps, lastTool === undefined ? 0 : 1), lastTool }
}

function describeTypes(defs: AgentDefinition[]): string {
  return defs.map((d) => `- ${d.name}: ${d.description}`).join('\n')
}

/** The `agent` tool for an agent running at `depth` (0 = main). */
export function createAgentTool(deps: AgentToolDeps, depth: number): ToolInput {
  return ((ctx: {
    session: { id: string; parent?: { depth?: number } }
    turn?: {
      id: string
      addUsage(usage: LanguageModelUsage, meta?: { costUsd?: number; source?: string }): void
    }
  }) => {
    // resolved once per session so the description (and the prompt-cache prefix) stays stable
    const initial = deps.definitions()
    return tool({
      description: `Launch a subagent to handle a task on its own and return a report.

Available subagent types:
${describeTypes(initial)}

Usage:
- The subagent starts with no context: the prompt must be self-contained (goal, what you already know, the form of the answer you need).
- Only the subagent's final report comes back to you; it is not shown to the user.
- Launch independent subagents in parallel by calling this tool several times in one step.
- Prefer \`explore\` for searching and reading the codebase; do simple lookups yourself.`,
      inputSchema: z.object({
        subagent_type: z.string().describe('The subagent type to use'),
        description: z.string().describe('A short (3-5 words) label for the task'),
        prompt: z.string().describe('The complete task for the subagent'),
      }),
      async *execute(
        { subagent_type, description, prompt },
        { toolCallId, abortSignal },
      ): AsyncGenerator<AgentProgress | string, void, undefined> {
        const defs = deps.definitions()
        const def = defs.find((d) => d.name === subagent_type)
        if (def === undefined) {
          yield `ERROR: unknown subagent_type "${subagent_type}". Available: ${defs.map((d) => d.name).join(', ')}`
          return
        }
        const turn = ctx.turn
        if (turn === undefined) {
          yield 'ERROR: subagents can only be started inside a turn.'
          return
        }
        const sessionId = `${ctx.session.id}:agent:${toolCallId}`
        const progress = (over: Partial<AgentProgress>): AgentProgress => ({
          status: 'running',
          agent: def.name,
          description,
          sessionId,
          steps: 0,
          text: '',
          ...over,
        })
        const sem = semaphoreFor(deps)
        yield progress({ text: 'Waiting for a free subagent slot…' })
        if (!(await sem.acquire(abortSignal))) {
          yield progress({ status: 'failed' })
          yield '[subagent stopped: aborted] '
          return
        }
        const agent = deps.agentFor(def, depth + 1)
        try {
          const child = agent.session(sessionId, {
            parent: {
              sessionId: ctx.session.id,
              turnId: turn.id,
              toolCallId,
              depth: (ctx.session.parent?.depth ?? depth) + 1,
            },
          })
          // latest-value mailbox between the stream consumers (callbacks) and this generator
          let latest = progress({})
          let dirty = true
          let finished = false
          let wake: (() => void) | undefined
          const notify = (): void => {
            dirty = true
            wake?.()
          }
          let stepsBefore = 0
          let stepsNow = 0
          let lastMessage: CoderMessage | undefined
          const consumers: Promise<void>[] = []
          const consume = async (run: HarnessRun<CoderMessage>): Promise<void> => {
            stepsBefore += stepsNow
            stepsNow = 0
            try {
              for await (const message of readUIMessageStream<CoderMessage>({
                stream: run.stream,
              })) {
                lastMessage = message
                const info = inspect(message)
                stepsNow = info.steps
                latest = progress({
                  steps: stepsBefore + info.steps,
                  lastTool: info.lastTool ?? latest.lastTool,
                  text: textOf(message, true),
                })
                notify()
              }
            } catch {
              // stream errors surface through run.result
            }
          }
          const run = child.send(prompt, { abortSignal, maxSteps: def.maxTurns })
          const driven = driveTurn(run, {
            session: child,
            broker: deps.broker,
            permissions: deps.permissions,
            describe: deps.describe,
            agent: def.name,
            signal: abortSignal,
            onRun: (r) => {
              consumers.push(consume(r))
            },
          }).finally(async () => {
            await Promise.all(consumers)
            finished = true
            notify()
          })
          while (!finished || dirty) {
            if (!dirty) {
              await new Promise<void>((resolve) => {
                wake = resolve
                if (dirty || finished) resolve()
              })
              wake = undefined
              continue
            }
            dirty = false
            yield latest
            if (!finished) await new Promise((r) => setTimeout(r, THROTTLE_MS))
          }
          const result = await driven
          turn.addUsage(usageOf(result.usage), {
            costUsd: result.usage.costUsd,
            source: `subagent:${def.name}`,
          })
          await agent.closeSession(sessionId).catch(() => {})
          const assistant =
            result.messages.findLast((m) => m.id === result.messageId) ??
            result.messages.findLast((m) => m.role === 'assistant')
          const text = textOf(assistant, true) || textOf(lastMessage, true) || latest.text
          const complete = result.stop === 'complete'
          yield progress({
            status: complete ? 'done' : 'failed',
            steps: latest.steps || result.steps,
            lastTool: latest.lastTool,
            text,
          })
          yield complete
            ? text || '(the subagent returned no text)'
            : `[subagent stopped: ${result.stop}] ${text}`
        } finally {
          sem.release()
        }
      },
    })
  }) as unknown as ToolInput
}
