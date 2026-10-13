/**
 * The web side of the people directory (`PeoplePort`, P43): a thin layer over `gateway.directory`.
 * Every change is recorded with the actor `web` (the owner at the web app).
 */
import type { PeoplePort, PersonDetail, PersonListItem, PersonPatchInput } from '../../app/ports.ts'
import { conflict, invalid, notFound } from '../../domain/errors.ts'
import type { ChannelGateway } from './gateway.ts'
import { type Person, PersonError, type PersonPatch } from './persons.ts'

const ACTOR = 'web'

export interface PeopleAdminOptions {
  gateway: ChannelGateway
  now?: () => number
}

export function createPeoplePort(options: PeopleAdminOptions): PeoplePort {
  const { gateway } = options
  const dir = gateway.directory
  const now = options.now ?? Date.now

  /** A refused directory change reads as a 409 (or 404) with the readable sentence. */
  const guard = <T>(fn: () => T): T => {
    try {
      return fn()
    } catch (error) {
      if (error instanceof PersonError) {
        if (error.code === 'PERSON_NOT_FOUND') throw notFound('Person', error.message)
        if (error.code.startsWith('INVALID')) throw invalid(error.message, error.code)
        throw conflict(error.message, error.code)
      }
      throw error
    }
  }

  const title = (nodeId: string): string => {
    const n = gateway.nodes.get(nodeId)
    if (n === undefined) return nodeId
    const parent = n.parentId === null ? undefined : gateway.nodes.get(n.parentId)
    const own = n.title ?? n.nativeId
    return parent === undefined ? own : `${parent.title ?? parent.nativeId} / ${own}`
  }

  const itemOf = (p: Person): PersonListItem => {
    const accounts = dir.identitiesOf(p.id)
    return {
      id: p.id,
      displayName: p.displayName,
      nickname: p.nickname,
      status: p.status,
      role: p.role,
      divisions: p.divisions.map((nodeId) => ({ nodeId, title: title(nodeId) })),
      fields: p.fields,
      accountCount: accounts.length,
      accounts: accounts.slice(0, 3).map((a) => ({
        platform: a.platform,
        label: a.label,
        username: a.username ?? null,
      })),
      updatedAt: p.updatedAt,
    }
  }

  const detailOf = (id: string): PersonDetail => {
    const p = dir.persons.get(id)
    if (p === undefined) throw notFound('Person', id)
    return {
      ...itemOf(p),
      notes: p.notes,
      memberId: p.memberId,
      createdAt: p.createdAt,
      accountViews: dir.identitiesOf(id).map((a) => ({
        id: a.accountId,
        platform: a.platform,
        nativeId: a.nativeId,
        label: a.label,
        connectionId: a.connectionId ?? null,
        name: a.name ?? null,
        username: a.username ?? null,
      })),
      events: dir.persons.events(id, 50),
    }
  }

  const patchOf = (input: PersonPatchInput): PersonPatch => {
    const out: PersonPatch = {}
    if (input.displayName !== undefined) out.displayName = input.displayName
    if (input.nickname !== undefined) out.nickname = input.nickname
    if (input.status !== undefined) out.status = input.status
    if (input.role !== undefined) out.role = input.role
    if (input.divisions !== undefined) {
      for (const d of input.divisions) {
        if (gateway.nodes.get(d) === undefined)
          throw invalid(`"${d}" is not a known chat or topic.`)
      }
      out.divisions = input.divisions
    }
    if (input.fields !== undefined) out.fields = input.fields
    if (input.notes !== undefined) out.notes = input.notes
    return out
  }

  const accountOf = (personId: string, accountId: string) => {
    const a = dir.persons.accounts(personId).find((x) => x.id === accountId)
    if (a === undefined) throw notFound('Account', accountId)
    return a
  }

  return {
    async list(query) {
      const limit = Math.min(Math.max(query.limit, 1), 100)
      const page = Math.max(query.page, 1)
      const r = dir.persons.list({
        ...(query.q === undefined ? {} : { q: query.q }),
        limit,
        offset: (page - 1) * limit,
      })
      return { items: r.items.map(itemOf), total: r.total, page, limit }
    },
    async get(id) {
      return detailOf(id)
    },
    async create(input) {
      const { displayName, nickname, role, divisions, fields, notes } = input
      const clean: Record<string, string> = {}
      for (const [k, v] of Object.entries(fields ?? {}))
        if (v !== null && v.trim() !== '') clean[k] = v
      if (divisions !== undefined) patchOf({ divisions })
      const p = guard(() =>
        dir.persons.create(
          {
            displayName,
            ...(nickname === undefined ? {} : { nickname }),
            ...(role === undefined ? {} : { role }),
            ...(divisions === undefined ? {} : { divisions }),
            fields: clean,
            ...(notes === undefined ? {} : { notes }),
          },
          ACTOR,
          now(),
        ),
      )
      return detailOf(p.id)
    },
    async update(id, patch) {
      guard(() => dir.persons.update(id, patchOf(patch), ACTOR, now()))
      return detailOf(id)
    },
    async link(id, input) {
      const platform = dir.platformOf(input.connectionId)
      if (platform === undefined) throw notFound('Connection', input.connectionId)
      guard(() =>
        dir.persons.link(
          id,
          {
            platform,
            nativeId: input.peerId,
            ...(input.label === undefined ? {} : { label: input.label }),
          },
          'owner',
          ACTOR,
          now(),
        ),
      )
      return detailOf(id)
    },
    async setLabel(id, accountId, label) {
      const a = accountOf(id, accountId)
      dir.persons.setLabel(a.id, label, ACTOR, now())
      return detailOf(id)
    },
    async unlink(id, accountId) {
      const a = accountOf(id, accountId)
      dir.persons.unlink(a.id, ACTOR, now())
      return detailOf(id)
    },
    async remove(id) {
      if (!dir.persons.delete(id, ACTOR, now())) throw notFound('Person', id)
    },
    async pairingCode(id) {
      if (dir.persons.get(id) === undefined) throw notFound('Person', id)
      const r = await dir.persons.issueCode(id, now())
      if ('error' in r) throw conflict(r.error, 'PAIRING_REFUSED')
      return r
    },
    async unassigned(limit) {
      return dir.unassigned(limit).map((u) => ({
        connectionId: u.connectionId,
        platform: u.platform,
        peerId: u.peerId,
        name: u.name ?? null,
        username: u.username ?? null,
      }))
    },
    async fromAccount(input) {
      if (dir.platformOf(input.connectionId) === undefined) {
        throw notFound('Connection', input.connectionId)
      }
      const p = guard(() => dir.ensureFor(input.connectionId, input.peerId, ACTOR))
      if (p === undefined) {
        throw notFound('Account', `${input.connectionId}/${input.peerId} (it has not written yet)`)
      }
      return detailOf(p.id)
    },
    async nodes() {
      const out: Array<{ id: string; connectionId: string; label: string }> = []
      for (const c of gateway.connections()) {
        for (const n of gateway.nodes.list(c.connectionId)) {
          if (n.state === 'deleted' || n.state === 'left' || n.kind === 'direct') continue
          out.push({ id: n.id, connectionId: c.connectionId, label: title(n.id) })
        }
      }
      return out.sort((a, b) => a.label.localeCompare(b.label))
    },
  }
}

/** The people port, delegating to a service built later (it needs the gateway). */
export function lazyPeoplePort(get: () => PeoplePort | undefined): PeoplePort {
  return new Proxy({} as PeoplePort, {
    get: (_t, name) => {
      const target = get()
      if (target === undefined) throw new Error('channels are not ready yet')
      return (target as unknown as Record<string | symbol, unknown>)[name]
    },
  })
}
