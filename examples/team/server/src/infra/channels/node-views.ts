/**
 * The admin views of nodes (docs/plans/P41-team-channels.md, phase L5): the tree the Channels page
 * shows, with what each node sets itself and what it inherits, and the one way a policy is written
 * to a node. Shared by every transport service; platform neutral.
 */

import type { ChannelSettingsPort } from '../../app/ports.ts'
import type {
  ChannelChatsQuery,
  ChannelNodeView,
  ChannelPolicy,
  ChannelPolicyInput,
  ChannelSettingKey,
  TablePage,
} from '../../domain/channels.ts'
import { invalid, notFound } from '../../domain/errors.ts'
import { checkOverlay } from '../../domain/persona.ts'
import type { ChannelGateway } from './gateway.ts'
import type { NodeRow } from './model.ts'
import type { ScopePolicy } from './policy.ts'

const KEYS: ChannelSettingKey[] = [
  'enabled',
  'agentId',
  'wake',
  'delivery',
  'retentionDays',
  'observe',
  'sessionScope',
  'redactOnDelete',
  'proactive',
  'defaultRole',
  'replyStyle',
  'personaOverlay',
  'feed',
  'copyTrial',
]

/** The part of the settings stored on one node that the page edits. */
export function policyView(own: ScopePolicy): ChannelPolicy | null {
  const has = KEYS.some((k) => own[k] !== undefined)
  if (!has) return null
  return {
    enabled: own.enabled !== false,
    ...(own.agentId === undefined ? {} : { agentId: own.agentId }),
    ...(own.wake === undefined ? {} : { wake: own.wake }),
    ...(own.delivery === undefined ? {} : { delivery: own.delivery }),
    ...(own.retentionDays === undefined ? {} : { retentionDays: own.retentionDays }),
    ...(own.observe === undefined ? {} : { observe: own.observe }),
    ...(own.sessionScope === undefined ? {} : { sessionScope: own.sessionScope }),
    ...(own.redactOnDelete === undefined ? {} : { redactOnDelete: own.redactOnDelete }),
    ...(own.proactive === undefined ? {} : { proactive: own.proactive }),
    ...(own.defaultRole === undefined ? {} : { defaultRole: own.defaultRole }),
    ...(own.replyStyle === undefined ? {} : { replyStyle: own.replyStyle }),
    ...(own.personaOverlay === undefined ? {} : { personaOverlay: own.personaOverlay }),
    ...(own.feed === undefined ? {} : { feed: own.feed }),
    ...(own.copyTrial === undefined ? {} : { copyTrial: own.copyTrial }),
  }
}

export function nodeView(
  gateway: ChannelGateway,
  node: NodeRow,
  extra: Pick<ChannelNodeView, 'account'> = {},
): ChannelNodeView | undefined {
  const scope = gateway.settings.resolve(node.id)
  if (scope === undefined) return undefined
  const access = gateway.nodes.access(node.id)
  const username = node.meta.username
  const inherited: ChannelNodeView['inherited'] = {}
  for (const k of KEYS) {
    const o = scope.origin[k]
    if (o !== undefined) inherited[k] = o
  }
  return {
    id: node.id,
    ...(node.parentId === null ? {} : { parentId: node.parentId }),
    nativeId: node.nativeId,
    kind: node.kind,
    chatKind: node.kind === 'direct' ? 'dm' : node.traits.broadcast ? 'channel' : 'group',
    platformType: node.platformType,
    title: node.title ?? node.nativeId,
    ...(typeof username === 'string' ? { username } : {}),
    state: node.state,
    container: node.traits.container,
    ...(node.traits.container ? { topics: gateway.nodes.children(node.id).length } : {}),
    postable: node.traits.postable,
    ...(access === undefined || access.member === 'unknown' ? {} : { member: access.member }),
    ...(access?.canPost === null || access?.canPost === undefined
      ? {}
      : { canPost: access.canPost }),
    ...(extra.account === undefined ? {} : { account: extra.account }),
    firstSeen: node.firstSeenAt,
    lastSeen: node.lastEventAt,
    policy: policyView(gateway.settings.get(node.id)),
    effective: {
      allowed: scope.allowed,
      agentId: scope.agentId,
      wake: scope.wake,
      delivery: scope.delivery,
      retentionDays: scope.retentionDays,
      observe: scope.observe,
      sessionScope: scope.sessionScope,
      redactOnDelete: scope.redactOnDelete,
      proactive: {
        allowed: scope.proactive.allowed,
        digest: scope.proactive.digest,
        digestMinutes: scope.proactive.digestMinutes,
        maxMentions: scope.proactive.maxMentions,
        ...(scope.proactive.quietHours === undefined
          ? {}
          : { quietHours: scope.proactive.quietHours }),
      },
      ...(scope.defaultRole === undefined ? {} : { defaultRole: scope.defaultRole }),
      ...(scope.replyStyle === undefined ? {} : { replyStyle: scope.replyStyle }),
      ...(scope.personaOverlay === undefined ? {} : { personaOverlay: scope.personaOverlay }),
      feed: scope.feed,
      copyTrial: scope.copyTrial,
    },
    inherited,
  }
}

/** Chats and topics of a connection (people are not chats: they reach the agent through linking). */
export function listNodeViews(
  gateway: ChannelGateway,
  connectionId: string,
  options: { account?: (node: NodeRow) => ChannelNodeView['account'] | undefined } = {},
): ChannelNodeView[] {
  const out: ChannelNodeView[] = []
  for (const node of gateway.nodes.list(connectionId)) {
    if (node.kind === 'direct' || node.state === 'deleted') continue
    const account = options.account?.(node)
    const view = nodeView(gateway, node, account === undefined ? {} : { account })
    if (view !== undefined) out.push(view)
  }
  return out
}

/**
 * One page of the chats or topics of a connection: filtered, sorted and counted in SQL, only the
 * rows of the page are resolved into views.
 */
export function pageNodeViews(
  gateway: ChannelGateway,
  connectionId: string,
  query: ChannelChatsQuery,
  options: { account?: (node: NodeRow) => ChannelNodeView['account'] | undefined } = {},
): TablePage<ChannelNodeView> {
  const page = gateway.nodes.table(connectionId, query, {
    allowedByDefault: gateway.config(connectionId)?.groupPolicy === 'open',
  })
  const items: ChannelNodeView[] = []
  for (const node of page.items) {
    const account = options.account?.(node)
    const view = nodeView(gateway, node, account === undefined ? {} : { account })
    if (view !== undefined) items.push(view)
  }
  return { items, total: page.total, page: query.page, limit: query.limit }
}

/** The number of chats (rooms and spaces) of a connection. */
export function countChats(gateway: ChannelGateway, connectionId: string): number {
  return gateway.nodes
    .list(connectionId)
    .filter((n) => (n.kind === 'room' || n.kind === 'space') && n.state !== 'deleted').length
}

/**
 * Write a policy to a node. `null` clears everything set on it (inherit again). A field set to
 * `null` is cleared; a room that gets a policy and has no explicit `enabled` is switched on
 * (a thread keeps inheriting from its room).
 */
export function writePolicy(
  gateway: ChannelGateway,
  node: NodeRow,
  input: ChannelPolicyInput | null,
  checkAgent: (agentId: string) => void,
): void {
  if (input === null) {
    gateway.settings.set(
      node.id,
      Object.fromEntries(KEYS.map((k) => [k, null])) as Record<string, null>,
    )
    return
  }
  if (typeof input.agentId === 'string') checkAgent(input.agentId)
  if (typeof input.personaOverlay === 'string') {
    const problem = checkOverlay(input.personaOverlay)
    if (problem !== undefined) throw invalid(problem, 'PERSONA_INVALID')
  }
  const patch: Record<string, unknown> = {}
  for (const k of KEYS) {
    const v = (input as Record<string, unknown>)[k]
    if (v !== undefined) patch[k] = v
  }
  const own = gateway.settings.get(node.id)
  if (patch.enabled === undefined && own.enabled === undefined && node.kind !== 'thread') {
    patch.enabled = true
  }
  gateway.settings.set(node.id, patch)
}

/** Chat settings of any connection through the gateway (`ChannelSettingsPort`). */
export function channelSettingsPort(
  gateway: ChannelGateway,
  agents: { get(id: string): { archivedAt: number | null } | undefined },
): ChannelSettingsPort {
  const nodeOf = (connectionId: string, nodeId: string): NodeRow => {
    const node = gateway.nodes.get(nodeId)
    if (node === undefined || node.connectionId !== connectionId || node.kind === 'direct')
      throw notFound('chat', nodeId)
    return node
  }
  return {
    chats: (connectionId) => {
      if (gateway.config(connectionId) === undefined) throw notFound('connection', connectionId)
      return listNodeViews(gateway, connectionId)
    },
    chat: (connectionId, nodeId) =>
      nodeView(gateway, nodeOf(connectionId, nodeId)) as ChannelNodeView,
    setChatPolicy(connectionId, nodeId, input) {
      const node = nodeOf(connectionId, nodeId)
      writePolicy(gateway, node, input, (agentId) => {
        const a = agents.get(agentId)
        if (a === undefined || a.archivedAt !== null) throw invalid(`unknown agent: ${agentId}`)
      })
      return nodeView(gateway, node) as ChannelNodeView
    },
  }
}
