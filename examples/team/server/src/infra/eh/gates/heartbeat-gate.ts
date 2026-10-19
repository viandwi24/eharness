/**
 * The heartbeat gate: the fixed, read-only authority of a heartbeat beat and the per-call
 * `refuse` decisions (memory, chat reads and the one post, ledger writes, tools opened by live
 * standing orders). Extracted from `agent-factory.ts`; the pure decisions live in
 * `domain/heartbeat.ts`, `domain/supervisor.ts` and `domain/standing-orders.ts`.
 */
import { errorText } from 'eharness'
import type { ActivatedConnectors } from 'eharness/connectors'
import { matchRule } from 'eharness/permissions'
import {
  HEARTBEAT_ALLOWED,
  HEARTBEAT_CONTENT_READS,
  HEARTBEAT_FILE_WRITES,
  HEARTBEAT_POST_TOOL,
  type HeartbeatDestination,
  heartbeatChannelRefusal,
  heartbeatRefusal,
  isFileWrite,
  ledgerWriteRefusal,
} from '../../../domain/heartbeat.ts'
import { destKey, needTools } from '../../../domain/standing-orders.ts'
import {
  isMemoryTool,
  MEMORY_EDIT_TOOLS,
  MEMORY_VIEW_TOOL,
  memoryCallRefusal,
} from '../../../domain/supervisor.ts'
import { resolveConnectionRef } from '../../channels/connection-ref.ts'
import type { ChannelGateway } from '../../channels/index.ts'
import { MEMORY_TOOL_KINDS } from '../connector-catalog.ts'
import type { ConnectorsRuntime } from '../connectors.ts'
import type { HeartbeatIntake } from '../heartbeat-plugin.ts'
import { toolFactsOf } from '../order-tools.ts'
import type { SessionGate } from '../permission-plugin.ts'

export interface HeartbeatGateInput {
  agentId: string
  sessionId: string
  out: ActivatedConnectors
  connectors: Pick<ConnectorsRuntime, 'toolKinds' | 'definitions'>
  heartbeat?: (() => HeartbeatIntake | undefined) | undefined
  channels?: (() => ChannelGateway | undefined) | undefined
}

export function createHeartbeatGate(
  input: HeartbeatGateInput,
): SessionGate & { rules: { allow: string[]; deny: string[] } } {
  const { out } = input
  const deps = {
    connectors: input.connectors,
    heartbeat: input.heartbeat,
    channels: input.channels,
  }
  const def = { id: input.agentId }
  const sessionId = input.sessionId
  // the heartbeat is read-only and has one fixed authority (`HEARTBEAT_ALLOWED`)
  const match = {
    roots: [{ virtual: '/', real: '/' }],
    toolKinds: { ...MEMORY_TOOL_KINDS, ...out.rules.toolKinds },
  }
  // the read-only tools of connected third-party services (a tracker, a CRM) are what the
  // person's checklist usually asks a beat to look at; writes stay out (D18 of the e2e pass)
  const kinds = deps.connectors.toolKinds(def.id) ?? {}
  const lookups = Object.entries(out.toolNameMap)
    .filter(
      ([name, origin]) =>
        kinds[name] === 'read' &&
        !out.rules.deny.includes(name) &&
        deps.connectors.definitions.find((d) => d.id === origin.connectorId)?.source !== 'builtin',
    )
    .map(([name]) => name)
  /**
   * Chat tools of a beat: reads go through (a download writes a file: refused); the one
   * post is allowed only as a new message to the chat of an active standing order, inside the
   * daily cap of that chat and not as a repeat. Read on every call, like a program's authority.
   */
  const channelCall = (call: { toolName: string; input: unknown }): string | undefined => {
    const allowed = deps.heartbeat?.()?.allowed(def.id) ?? []
    let target: HeartbeatDestination | { error: string } | undefined
    const input = (call.input ?? {}) as Record<string, unknown>
    const gw = deps.channels?.()
    if (call.toolName === HEARTBEAT_POST_TOOL && allowed.length > 0 && gw !== undefined) {
      try {
        const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
        const ref =
          str(input.connection) === undefined
            ? undefined
            : resolveConnectionRef(gw.connectionsOf(def.id), input.connection as string)
        if (ref !== undefined && !ref.ok) target = { error: ref.text }
        else {
          const conversation = str(input.conversation)
          const topic = str(input.topic)
          const t = gw.resolveTarget(def.id, sessionId, {
            ...(ref === undefined ? {} : { connection: ref.id }),
            ...(conversation === undefined ? {} : { conversation }),
            ...(topic === undefined ? {} : { topic }),
          })
          target = { connectionId: t.config.connectionId, nodeId: t.node.id }
        }
      } catch (error) {
        target = { error: errorText(error) }
      }
    }
    const refusal = heartbeatChannelRefusal(call, { allowed, target })
    if (refusal !== undefined || call.toolName !== HEARTBEAT_POST_TOOL) return refusal
    const text = typeof input.text === 'string' ? input.text : ''
    if (text.trim() === '') return 'Not posted: send needs text.'
    const to = destKey({
      kind: 'chat',
      connectionId: (target as HeartbeatDestination).connectionId,
      nodeId: (target as HeartbeatDestination).nodeId,
    })
    // what a DM said never goes into a group (checked before the post is counted)
    return (
      deps.heartbeat?.()?.postPrivacy(def.id, to) ??
      deps.heartbeat?.()?.reservePost(def.id, to, text)
    )
  }
  /**
   * A read of what people said (history, search, a message by id): only chats inside the read
   * scope of the beat (the chats the givers of its live orders can read). The call must name
   * a chat that resolves; a DM that was read is remembered for the post check.
   */
  const contentRead = (call: { toolName: string; input: unknown }): string | undefined => {
    const hb = deps.heartbeat?.()
    const gw = deps.channels?.()
    if (hb === undefined || gw === undefined) return undefined
    const input = (call.input ?? {}) as Record<string, unknown>
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
    const chat = str(input.chat) ?? str(input.conversation)
    if (chat === undefined || chat.trim() === '') {
      return `Not read: ${call.toolName} must name the chat (its id from channel_describe, its native id or its exact title). A heartbeat reads only the chats of its standing orders.`
    }
    const bound = gw.connectionsOf(def.id)
    let ids = bound.map((c) => c.connectionId)
    if (str(input.connection) !== undefined) {
      const ref = resolveConnectionRef(bound, input.connection as string)
      if (!ref.ok) return ref.text
      ids = [ref.id]
    }
    let node: ReturnType<typeof gw.nodeOf>
    for (const id of ids) {
      node = gw.nodeOf(id, chat)
      if (node !== undefined) break
    }
    if (node === undefined) {
      return `Not read: "${chat}" is not a chat I ingest. Use channel_describe to list them.`
    }
    return hb.readCheck(def.id, {
      nodeId: node.id,
      title: node.title ?? node.nativeId,
      ids: [node.id, ...gw.nodes.chain(node).map((n) => n.id)],
      direct: node.kind === 'direct',
    })
  }
  // what the live orders of owners and admins open for the running beat (P52): the tools of
  // their `needs` that the agent actually has, and writing their ledger paths. The snapshot is
  // read on every call; the engine rules below only make the candidates callable, `refuse`
  // is what decides.
  const facts = toolFactsOf(out, deps.connectors.toolKinds(def.id) ?? {})
  const candidates = facts
    .filter(
      (f) =>
        f.connectorId === 'web' ||
        f.connectorId === 'browser' ||
        deps.connectors.definitions.find((d) => d.id === f.connectorId)?.source !== 'builtin',
    )
    .map((f) => f.name)
  const grants = (): { needs: string[]; writes: string[] } =>
    deps.heartbeat?.()?.grants(def.id) ?? { needs: [], writes: [] }
  const fileWrites = HEARTBEAT_FILE_WRITES.filter(
    (t) => t in out.toolNameMap && !out.rules.deny.includes(t),
  )
  // the supervisor duty (P53): memory reads on the agent's own folder, and edits only in a beat
  // whose observation has findings about its own memory (`memoryCallRefusal` decides, every call)
  const memoryTools = [MEMORY_VIEW_TOOL, ...MEMORY_EDIT_TOOLS].filter(
    (t) => !out.rules.deny.includes(t),
  )
  return {
    rules: {
      allow: [
        ...HEARTBEAT_ALLOWED,
        HEARTBEAT_POST_TOOL,
        ...lookups,
        ...candidates,
        ...fileWrites,
        ...memoryTools,
      ],
      deny: [],
    },
    refuse: (call) => {
      if (isMemoryTool(call.toolName)) {
        return memoryTools.includes(call.toolName)
          ? memoryCallRefusal(call, {
              agentId: def.id,
              fixing: deps.heartbeat?.()?.memoryFix(def.id) === true,
            })
          : heartbeatRefusal(call.toolName)
      }
      if (HEARTBEAT_CONTENT_READS.includes(call.toolName)) {
        const refused = contentRead(call)
        if (refused !== undefined) return refused
        if (call.toolName !== 'channel_read') return undefined
      }
      if (call.toolName === HEARTBEAT_POST_TOOL || call.toolName === 'channel_read') {
        return channelCall(call)
      }
      if (isFileWrite(call.toolName)) {
        return fileWrites.includes(call.toolName) || call.toolName === 'delete_file'
          ? ledgerWriteRefusal(call, grants().writes)
          : heartbeatRefusal(call.toolName)
      }
      if (lookups.includes(call.toolName)) return undefined
      if (candidates.includes(call.toolName)) {
        return needTools(grants().needs, facts, out.rules).includes(call.toolName)
          ? undefined
          : `Not available in a heartbeat: ${call.toolName}. No live standing order of an owner or an admin needs it (an order lists its needs: web, browser, phone/<slug>).`
      }
      return HEARTBEAT_ALLOWED.some((rule) =>
        matchRule(rule, call, { ...match, polarity: 'allow' }),
      )
        ? undefined
        : heartbeatRefusal(call.toolName)
    },
    askedReason: heartbeatRefusal,
  }
}
