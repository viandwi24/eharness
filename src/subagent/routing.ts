/**
 * Messages between the agents of a session (ADR-0038, ADR-0041) and the `send_message`,
 * `agent_stop` and `agent_output` tools that expose them to the model.
 *
 * @see docs/specs/20-subagent-plugin.md
 */
import { type FlexibleSchema, tool } from 'ai'
import { z } from 'zod/v4'
import { errorText, isHarnessError, type ToolInput } from '../index.ts'
import { closeChild } from './child-run.ts'
import { messageDescription } from './descriptions.ts'
import { parkStatus, rebuildEntries, rebuildPark, rootOf, selfNameOf, stopPark } from './entries.ts'
import type { Env, Reporter, Scope } from './env.ts'
import {
  AGENT_MESSAGE_MAX_CHARS,
  type AgentDirectory,
  type AgentEntry,
  type AgentSender,
  findEntry,
  frameAgentMessage,
  throttle,
} from './messaging.ts'
import { type MessageLike, textOf } from './report.ts'
import { AGENT_OUTPUT_PAGE_CHARS, type AnySession, type Ctx } from './types.ts'

export function reporterOf(ctx: Ctx): Reporter {
  return async (text, data) => {
    await ctx.session.inject(
      'eh.event',
      { name: 'subagent', text, data },
      { deliver: 'next-step', wake: true },
    )
  }
}

export type Routed =
  | { kind: 'error'; text: string }
  | { kind: 'dropped'; text: string }
  | { kind: 'delivered'; label: string; id: string }
  | { kind: 'resumed'; label: string; id: string }

function fail(text: string): Routed {
  return { kind: 'error', text: text.startsWith('ERROR') ? text : `ERROR: ${text}` }
}

/** The throttle verdict as a routing result: `undefined` to go on. */
function throttled(
  dir: AgentDirectory,
  key: string,
  text: string,
  limits: Env['limits'],
  queue: number[],
): Routed | undefined {
  const limited = throttle(dir, key, text, limits, queue)
  if (limited === undefined) return undefined
  return limited.startsWith('ERROR') ? fail(limited) : { kind: 'dropped', text: limited }
}

/** Find the target of a message, check the rules, then deliver or resume. */
export async function route(
  scope: Scope,
  sender: AgentSender,
  to: string,
  text: string,
): Promise<Routed> {
  const { dir, env } = scope
  const { limits, park, toolName } = env
  if (dir === undefined) return fail('messaging is not available in this session.')
  if (text.length > AGENT_MESSAGE_MAX_CHARS) {
    return fail(
      `the message is too long (${text.length} characters, at most ${AGENT_MESSAGE_MAX_CHARS}). Shorten it.`,
    )
  }
  const key = to.trim()
  if (key === '') return fail('`to` is empty.')
  if (park) return routePark(scope, sender, key, text)
  const isMain = key.toLowerCase() === 'main'
  let target = isMain ? undefined : findEntry(dir, key)
  if (!isMain && target === undefined) {
    await rebuildEntries(scope, true)
    target = findEntry(dir, key)
  }
  const known = (): string =>
    [
      ...(sender.kind === 'agent' && sender.sessionId === dir.rootId ? [] : ['main']),
      ...[...dir.entries.values()].map((e) => e.name ?? e.taskId ?? e.childSessionId),
    ].join(', ')
  const senderLabel = sender.kind === 'agent' ? sender.label : 'user'
  const senderId = sender.kind === 'agent' ? sender.id : 'user'

  if (isMain) {
    if (sender.kind === 'user') return fail('the user talks to main in the main conversation.')
    if (sender.sessionId === dir.rootId)
      return fail('you are the main agent; you cannot message yourself.')
    if (dir.main === undefined) return fail('the main agent cannot be reached from this session.')
    const limited = throttled(dir, `${senderId}->main`, text, limits, dir.mainQueued)
    if (limited !== undefined) return limited
    const relation =
      dir.entries.get(sender.sessionId)?.ownerSessionId === dir.rootId ? 'child' : 'peer'
    const framed = frameAgentMessage(text, { label: senderLabel, id: senderId }, relation)
    try {
      await dir.main(framed, { from: senderLabel, fromId: senderId })
    } catch (error) {
      return fail(`could not deliver the message to main: ${errorText(error)}`)
    }
    return { kind: 'delivered', label: 'main', id: 'main' }
  }

  if (target === undefined) return fail(`no agent "${key}". You can message: ${known()}.`)
  const entry = target
  const label = entry.name ?? entry.taskId ?? entry.childSessionId
  if (sender.kind === 'agent' && entry.childSessionId === sender.sessionId) {
    return fail('you cannot message yourself.')
  }
  if (entry.status === 'stopped' && entry.modelStopped !== true) {
    return fail(`${label} was cancelled by the user and cannot be messaged.`)
  }
  const running = entry.status === 'running'
  if (!running && !entry.resumable) {
    return fail(
      `${label} (${entry.agent}) has finished and cannot be resumed (a one-shot agent). Start a new agent with the ${toolName} tool if more work is needed.`,
    )
  }
  if (running && entry.deliver === undefined) {
    return fail(`${label} is still starting; send the message again in a moment.`)
  }
  if (sender.kind === 'agent') {
    const limited = throttled(
      dir,
      `${senderId}->${entry.childSessionId}`,
      text,
      limits,
      entry.queued,
    )
    if (limited !== undefined) return limited
  }
  const relation =
    sender.kind === 'agent' && sender.sessionId === entry.ownerSessionId
      ? 'launcher'
      : sender.kind === 'agent' &&
          dir.entries.get(sender.sessionId)?.ownerSessionId === entry.childSessionId
        ? 'child'
        : 'peer'
  const payload =
    sender.kind === 'agent'
      ? frameAgentMessage(text, { label: senderLabel, id: senderId }, relation)
      : text
  const id = entry.taskId ?? entry.childSessionId
  if (running) {
    try {
      if (sender.kind === 'user') await entry.deliverUser?.(text)
      else await entry.deliver?.(payload, { from: senderLabel, fromId: senderId })
      return { kind: 'delivered', label, id }
    } catch (error) {
      if (isHarnessError(error) && error.code === 'EH_SESSION_CLOSED') {
        return fail(`${label} is just finishing; send the message again in a moment.`)
      }
      return fail(`could not deliver the message to ${label}: ${errorText(error)}`)
    }
  }
  if (entry.resume === undefined) return fail(`${label} cannot be resumed.`)
  const out = await entry.resume(payload, sender)
  if (out.startsWith('ERROR')) return fail(out)
  return { kind: 'resumed', label, id: out }
}

/** The `send_message` tool of one session. */
export function messageTool(scope: Scope, name: string): ToolInput {
  const schema = z.object({
    to: z
      .string()
      .describe('"main", an agent id such as agent-2, a child session id, or the name you gave'),
    message: z.string().describe('The message; it must be self-contained'),
  })
  return tool({
    description: messageDescription(name),
    inputSchema: schema as unknown as FlexibleSchema<{ to: string; message: string }>,
    async execute({ to, message }): Promise<string> {
      const { ctx, dir } = scope
      const { park } = scope.env
      if (dir === undefined) return 'ERROR: messaging is not available in this session.'
      const text = message.trim()
      if (text === '') return 'ERROR: the message is empty.'
      const self = dir.entries.get(ctx.session.id)
      const isRoot = scope.isRoot
      const parkName = park && !isRoot ? await selfNameOf(scope) : undefined
      const sender: AgentSender = {
        kind: 'agent',
        label: isRoot
          ? 'main'
          : (parkName ??
            self?.name ??
            self?.taskId ??
            self?.agent ??
            (park ? ctx.session.id : 'agent')),
        id: isRoot ? 'main' : (self?.taskId ?? ctx.session.id),
        sessionId: ctx.session.id,
        report: reporterOf(ctx),
        addUsage: (usage, source) => {
          try {
            ctx.turn?.addUsage(usage, { source })
          } catch {
            // the sender's turn is over
          }
        },
      }
      const routed = await route(scope, sender, to, text)
      switch (routed.kind) {
        case 'error':
        case 'dropped':
          return routed.text
        case 'delivered':
          return routed.label === 'main'
            ? 'Message sent to main. It sees it at its next step, or now if it is idle.'
            : `Message delivered to ${routed.label}. It sees it at its next step; its answer, if any, comes back as a message.`
        case 'resumed':
          return park
            ? `${routed.label} had finished; it was resumed on the same session with your message. Its report arrives here as a message when it finishes.`
            : `${routed.label} had finished; it was resumed on the same session with your message and runs in the background as ${routed.id}. Its report arrives here when it finishes.`
      }
    },
  }) as ToolInput
}

/**
 * The latest non-empty final text of a child (a side-effect-free read: the child is not opened, so
 * no start hooks or recovery run). Closes it afterwards only when it is idle and untracked.
 */
async function readFinalText(
  scope: Scope,
  def: NonNullable<ReturnType<Scope['defs']>[string]>,
  agent: string,
  childId: string,
  entry: AgentEntry | undefined,
): Promise<string> {
  const { ctx, dir, registry } = scope
  let text = ''
  const child = scope.env.peekOf(def.agent, childId, {
    parentSessionId: ctx.session.id,
    agent,
    depth: scope.depth + 1,
  })
  try {
    const stored = (await child.messages({ limit: 200 })) as unknown as MessageLike[]
    for (const m of stored.toReversed()) {
      if (m.role !== 'assistant') continue
      text = textOf(m, true)
      if (text !== '') break
    }
  } finally {
    // Closing would abort a resume that started meanwhile: close only a child that is
    // idle now (re-checked after the open) and not tracked as running.
    const running =
      dir?.entries.get(childId)?.status === 'running' ||
      registry.list().some((t) => t.childSessionId === childId && t.status === 'running')
    let busy = running
    if (!busy) {
      try {
        const stats = await child.stats()
        busy = stats.activeTurn !== null || stats.pending !== null
      } catch {
        busy = true
      }
    }
    if (!busy && entry?.durable !== true) await closeChild(def, childId)
  }
  return text
}

/** What `agent_stop` says about an agent that already ended: its answer, when it left one. */
export async function endedAnswer(
  scope: Scope,
  label: string,
  status: string,
  agent: string | undefined,
  childId: string | undefined,
  entry: AgentEntry | undefined,
  outputToolName: string | undefined,
): Promise<string> {
  const base = `${label} is not running (${status}).`
  if (agent === undefined || childId === undefined) return base
  const def = scope.defs()[agent]
  if (def === undefined) return base
  let text = ''
  try {
    text = await readFinalText(scope, def, agent, childId, entry)
  } catch {
    return base
  }
  if (text === '') return base
  const max = Math.min(scope.env.reportMax, 4000)
  const body =
    text.length > max
      ? `${text.slice(0, max)}\n… [cut at ${max} of ${text.length} characters${outputToolName === undefined ? '' : `; read the rest with ${outputToolName}({ id: "${label}" })`}]`
      : text
  return `${base} It had already ended; its final answer:\n\n${body}`
}

/** The `agent_stop` tool of one session: stop a running agent; it stays resumable. */
export function stopTool(scope: Scope): ToolInput {
  const schema = z.object({
    id: z.string().describe('An agent id such as agent-2, its name, or its child session id'),
  })
  return tool({
    description: `Stop a running background subagent (by id, name or child session id). Its work so far stays in its session; unless it is a one-shot type you can resume it later by sending it a message. For shell commands use kill_shell instead.`,
    inputSchema: schema as unknown as FlexibleSchema<{ id: string }>,
    async execute({ id }): Promise<string> {
      const { dir, registry } = scope
      const key = id.trim()
      if (key === '') return 'ERROR: `id` is empty.'
      let entry: AgentEntry | undefined
      if (dir !== undefined) {
        entry = findEntry(dir, key)
        if (entry === undefined) {
          await rebuildEntries(scope, true)
          entry = findEntry(dir, key)
        }
      }
      if (entry?.durable === true) {
        return stopPark(scope, entry, (label, status) =>
          endedAnswer(
            scope,
            label,
            status,
            entry.agent,
            entry.childSessionId,
            entry,
            scope.env.outputEnabled ? scope.env.outputToolName : undefined,
          ),
        )
      }
      const task = registry.get(key)
      if (task === undefined) {
        const label = entry?.name ?? entry?.taskId ?? key
        return entry === undefined
          ? `ERROR: no running agent "${key}". Agents that finished need no stopping.`
          : endedAnswer(
              scope,
              label,
              entry.status,
              entry.agent,
              entry.childSessionId,
              entry,
              scope.env.outputEnabled ? scope.env.outputToolName : undefined,
            )
      }
      const label = task.name ?? task.id
      if (task.status !== 'running') {
        return endedAnswer(
          scope,
          label,
          task.status,
          task.agent,
          task.childSessionId,
          entry,
          scope.env.outputEnabled ? scope.env.outputToolName : undefined,
        )
      }
      if (entry !== undefined) entry.modelStopped = true
      await registry.stop(task.id)
      return `Stopped ${label}.${entry?.resumable === false ? '' : ' It can be resumed by sending it a message.'}`
    },
  }) as ToolInput
}

/** The `agent_output` tool of one session: the full final report of an agent, paged. */
export function outputTool(scope: Scope, name: string): ToolInput {
  const schema = z.object({
    id: z.string().describe('An agent id such as agent-2, its name, or its child session id'),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Character to start at (default 0); use the offset of the "more" footer'),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(`Characters to return (default ${AGENT_OUTPUT_PAGE_CHARS})`),
  })
  return tool({
    description: `Read the full final report of a subagent (by id, name or child session id). Use it when a background agent's report arrived cut, or to read a finished agent again. Works for one-shot agents and after a restart. A report longer than one page continues with ${name}({ id, offset }). A still-running agent returns its status and latest progress.`,
    inputSchema: schema as unknown as FlexibleSchema<{
      id: string
      offset?: number
      limit?: number
    }>,
    async execute({ id, offset, limit }): Promise<string> {
      const { ctx, dir, registry } = scope
      const key = id.trim()
      if (key === '') return 'ERROR: `id` is empty.'
      let entry: AgentEntry | undefined
      if (dir !== undefined) {
        entry = findEntry(dir, key)
        if (entry === undefined) {
          await rebuildEntries(scope, true)
          entry = findEntry(dir, key)
        }
      }
      const task = registry.get(key)
      const agent = entry?.agent ?? task?.agent
      const childId = entry?.childSessionId ?? task?.childSessionId
      if (agent === undefined || childId === undefined) {
        const known = [
          ...(dir === undefined
            ? []
            : [...dir.entries.values()].map((e) => e.name ?? e.taskId ?? e.childSessionId)),
          ...registry.list().map((t) => t.name ?? t.id),
        ]
        const unique = [...new Set(known)]
        return `ERROR: no agent "${key}".${unique.length === 0 ? ' No agents were started in this session.' : ` Known agents: ${unique.join(', ')}.`}`
      }
      if (entry?.durable === true) await parkStatus(scope, entry).catch(() => {})
      const label = entry?.name ?? entry?.taskId ?? task?.id ?? childId
      const status = entry?.status ?? task?.status
      if (status === 'running') {
        const tail = task?.tail ?? ''
        return `${label} (${agent}) is still running; no final report yet.${tail === '' ? '' : `\nLatest progress:\n${tail}`}\nIts report arrives as a message when it finishes.`
      }
      const def = scope.defs()[agent]
      if (def === undefined) return `ERROR: the agent type "${agent}" is not available.`
      let text = ''
      try {
        text = await readFinalText(scope, def, agent, childId, entry)
      } catch (error) {
        ctx.log.warn('subagent: could not read an agent report', { error: errorText(error) })
        return `ERROR: could not read the report of ${label}: ${errorText(error)}`
      }
      const head = `${label} (${agent}, ${status ?? 'finished'})`
      if (text === '') return `${head} has no final text report.`
      const from = Math.min(offset ?? 0, text.length)
      const size = limit ?? AGENT_OUTPUT_PAGE_CHARS
      const to = Math.min(text.length, from + size)
      const body = text.slice(from, to)
      const footer =
        to < text.length
          ? `\n… [characters ${from}-${to} of ${text.length}; more: ${name}({ id: "${key}", offset: ${to} })]`
          : from > 0
            ? `\n… [characters ${from}-${to} of ${text.length}; end of report]`
            : ''
      return `${head}\n\n${body}${footer}`
    },
  }) as ToolInput
}

/** `'park'`: deliver to `main`, the root session, over its durable inbox. */
async function parkToMain(scope: Scope, sender: AgentSender, text: string): Promise<Routed> {
  const { dir, ctx, env } = scope
  const { options, limits } = env
  if (dir === undefined) return fail('messaging is not available in this session.')
  if (sender.kind === 'user') return fail('the user talks to main in the main conversation.')
  if (scope.isRoot) return fail('you are the main agent; you cannot message yourself.')
  const rootId = await rootOf(scope)
  if (rootId === undefined || options.parentAgent === undefined) {
    return fail(
      'the main agent cannot be reached from this session (set `parentAgent` on its subagent() plugin).',
    )
  }
  const limited = throttled(dir, `${sender.id}->main`, text, limits, dir.mainQueued)
  if (limited !== undefined) return limited
  const relation = ctx.session.parent?.sessionId === rootId ? 'child' : 'peer'
  const framed = frameAgentMessage(text, { label: sender.label, id: sender.id }, relation)
  try {
    await (options.parentAgent().session(rootId, env.parentOptions(rootId)) as AnySession).enqueue(
      framed,
      { mode: 'steer' },
    )
  } catch (error) {
    return fail(`could not deliver the message to main: ${errorText(error)}`)
  }
  return { kind: 'delivered', label: 'main', id: 'main' }
}

/**
 * `'park'`: send to a child of this session over the child's durable inbox. A running child (a
 * live turn or waiting for an answer) gets a steer; a finished one a new turn on the same
 * session, whose report its `turn.end` hook enqueues back here.
 */
async function routePark(
  scope: Scope,
  sender: AgentSender,
  key: string,
  text: string,
): Promise<Routed> {
  const { dir, env } = scope
  const { limits, toolName } = env
  if (dir === undefined) return fail('messaging is not available in this session.')
  if (key.toLowerCase() === 'main') return parkToMain(scope, sender, text)
  let entry = findEntry(dir, key)
  if (entry === undefined) {
    await rebuildPark(scope, true)
    entry = findEntry(dir, key)
  }
  if (entry === undefined) {
    const known = [
      ...(scope.isRoot ? [] : ['main']),
      ...[...dir.entries.values()].map((e) => e.name ?? e.childSessionId),
    ].join(', ')
    return fail(`no agent "${key}". You can message: ${known}.`)
  }
  const label = entry.name ?? entry.childSessionId
  if (entry.childSessionId === scope.ctx.session.id) return fail('you cannot message yourself.')
  const def = scope.defs()[entry.agent]
  if (def === undefined) {
    return fail(`the agent type "${entry.agent}" is not available any more; it cannot be messaged.`)
  }
  if (sender.kind === 'agent') {
    const limited = throttled(
      dir,
      `${sender.id}->${entry.childSessionId}`,
      text,
      limits,
      entry.queued,
    )
    if (limited !== undefined) return limited
  }
  const state = await parkStatus(scope, entry).catch(() => undefined)
  if (state === undefined) return fail(`could not read the state of ${label}.`)
  const running = state.status === 'running'
  if (!running && !entry.resumable) {
    return fail(
      `${label} (${entry.agent}) has finished and cannot be resumed (a one-shot agent). Start a new agent with the ${toolName} tool if more work is needed.`,
    )
  }
  const payload =
    sender.kind === 'agent'
      ? frameAgentMessage(text, { label: sender.label, id: sender.id }, 'launcher', label)
      : text
  try {
    // the handle stays open: it drains the inbox when no other instance holds the session
    await (def.agent.session(entry.childSessionId, env.entryOptions(entry)) as AnySession).enqueue(
      payload,
      {
        mode: running ? 'steer' : 'queue',
      },
    )
  } catch (error) {
    return fail(`could not deliver the message to ${label}: ${errorText(error)}`)
  }
  return running ? { kind: 'delivered', label, id: label } : { kind: 'resumed', label, id: label }
}
