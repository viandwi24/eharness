/**
 * The chat side of the heartbeat (docs/plans/P40-team-autonomous-operations.md, D9): which
 * conversations a beat may report to, which it watches, and how many new messages each got. Reads
 * the channels gateway only (late-bound, it is built after the heartbeat service); never writes.
 */
import type { HeartbeatChannels } from '../../app/ports.ts'
import type { ChatActivity, HeartbeatDestinationView, WatchNode } from '../../domain/heartbeat.ts'
import type { ChannelGateway } from '../channels/index.ts'

/** Messages counted per chat before the count reads "N+" (cheap: the log is only paged once). */
const ACTIVITY_CAP = 100

export function heartbeatChannels(gateway: () => ChannelGateway | undefined): HeartbeatChannels {
  const labelOf = (gw: ChannelGateway, nodeId: string): string => {
    const node = gw.nodes.get(nodeId)
    if (node === undefined) return nodeId
    const room = gw.roomOf(node)
    const own = node.title ?? node.nativeId
    return room.id === node.id ? own : `${room.title ?? room.nativeId} / ${own}`
  }
  return {
    destinations(agentId) {
      const gw = gateway()
      if (gw === undefined) return []
      const out: HeartbeatDestinationView[] = []
      for (const c of gw.connectionsOf(agentId)) {
        for (const n of gw.nodes.list(c.connectionId)) {
          if (n.state !== 'active' || !n.traits.postable) continue
          const scope = gw.settings.resolve(n.id)
          if (scope?.allowed !== true) continue
          out.push({
            connectionId: c.connectionId,
            nodeId: n.id,
            label: labelOf(gw, n.id),
            platform: c.platform,
            kind: n.kind,
            proactive: scope.proactive.allowed,
          })
        }
      }
      return out
    },

    nodes(agentId) {
      const gw = gateway()
      if (gw === undefined) return []
      const out: WatchNode[] = []
      for (const c of gw.connectionsOf(agentId)) {
        for (const n of gw.nodes.list(c.connectionId)) {
          if (n.state !== 'active') continue
          out.push({
            connectionId: c.connectionId,
            nodeId: n.id,
            title: labelOf(gw, n.id),
            kind: n.kind,
            allowed: gw.settings.resolve(n.id)?.allowed === true,
          })
        }
      }
      return out
    },

    async activity(nodes, since, until): Promise<ChatActivity[]> {
      const gw = gateway()
      if (gw === undefined) return []
      const out: ChatActivity[] = []
      for (const n of nodes) {
        const page = await gw.log.range([n.nodeId], {
          from: since,
          to: until + 1,
          limit: ACTIVITY_CAP,
        })
        const others = page.items.filter((m) => !m.self)
        out.push({
          nodeId: n.nodeId,
          title: n.title,
          count: others.length,
          capped: page.next !== undefined,
        })
      }
      return out
    },

    agentOf(connectionId) {
      return gateway()?.config(connectionId)?.agentId
    },

    roleOf(identityId) {
      return gateway()?.roleOfIdentity(identityId)
    },

    canRead(identityId, nodeId) {
      const gw = gateway()
      const id = gw?.identities.get(identityId)
      const node = gw?.nodes.get(nodeId)
      if (gw === undefined || id === undefined || node === undefined) return false
      const role = gw.roleOfIdentity(identityId)
      if (role === 'owner' || role === 'admin') return true
      if (role !== 'member') return false
      const chain = new Set([node.id, ...gw.nodes.chain(node).map((n) => n.id)])
      if (gw.identities.memberships(id.id).some((m) => chain.has(m.nodeId))) return true
      const view = gw.people.get(id.connectionId, id.nativeId)
      return view?.divisions.some((d) => chain.has(d.nodeId)) === true
    },
  }
}
