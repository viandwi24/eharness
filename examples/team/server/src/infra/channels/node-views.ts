/**
 * The admin views of nodes (docs/plans/P41-team-channels.md, phase L5): the tree the Channels page
 * shows, with what each node sets itself and what it inherits, and the one way a policy is written
 * to a node. Shared by every transport service; platform neutral.
 */
import type {
  ChannelNodeView,
  ChannelPolicy,
  ChannelPolicyInput,
  ChannelSettingKey,
} from '../../domain/channels.ts'
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
