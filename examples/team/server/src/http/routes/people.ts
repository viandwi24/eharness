import { createRoute, OpenAPIHono, type z } from '@hono/zod-openapi'
import type { Deps, PersonPatchInput } from '../../app/ports.ts'
import { errorResponses, jsonError } from '../schemas/common.ts'
import {
  PairingCodeSchema,
  PersonAccountParam,
  PersonCreateBodySchema,
  PersonDetailSchema,
  PersonFromAccountBodySchema,
  PersonIdParam,
  PersonLabelBodySchema,
  PersonLinkBodySchema,
  PersonListQuery,
  PersonListSchema,
  PersonNodeListSchema,
  PersonPatchBodySchema,
  UnassignedListSchema,
  UnassignedQuery,
} from '../schemas/people.ts'

const security = [{ Bearer: [] }]
const content = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })
const tags = ['people']
const detail = { description: 'The person', content: content(PersonDetailSchema) }
const unknown = jsonError('Unknown person or account')
const refused = jsonError('Refused: the account belongs to somebody else, or pairing is limited')
const body = <T extends z.ZodType>(schema: T) => ({
  required: true as const,
  content: content(schema),
})

const list = createRoute({
  method: 'get',
  path: '/people',
  tags,
  summary: 'People directory',
  description:
    'One page of the people of the team (a person has any number of platform accounts), newest change first. Search matches name, nickname, field values and platform ids.',
  security,
  request: { query: PersonListQuery },
  responses: {
    200: { description: 'A page', content: content(PersonListSchema) },
    ...errorResponses,
  },
})
const unassigned = createRoute({
  method: 'get',
  path: '/people/unassigned',
  tags,
  summary: 'Accounts without a person',
  description:
    'Platform accounts seen in chats that belong to no person: candidates to create or attach.',
  security,
  request: { query: UnassignedQuery },
  responses: {
    200: { description: 'Accounts', content: content(UnassignedListSchema) },
    ...errorResponses,
  },
})
const nodes = createRoute({
  method: 'get',
  path: '/people/nodes',
  tags,
  summary: 'Chats and topics for divisions',
  description: 'The chats and topics of every connection a person can be given as divisions.',
  security,
  responses: {
    200: { description: 'Nodes', content: content(PersonNodeListSchema) },
    ...errorResponses,
  },
})
const fromAccount = createRoute({
  method: 'post',
  path: '/people/from-account',
  tags,
  summary: 'Create a person from an account',
  description:
    'Creates the person from what the account shows (name, username) and links the account; an account that is already linked returns its person.',
  security,
  request: { body: body(PersonFromAccountBodySchema) },
  responses: {
    200: detail,
    404: jsonError('Unknown connection, or the account has not written yet'),
    409: refused,
    ...errorResponses,
  },
})
const create = createRoute({
  method: 'post',
  path: '/people',
  tags,
  summary: 'Create a person',
  security,
  request: { body: body(PersonCreateBodySchema) },
  responses: { 200: detail, 409: refused, ...errorResponses },
})
const get = createRoute({
  method: 'get',
  path: '/people/{id}',
  tags,
  summary: 'One person',
  description: 'With accounts (as seen in chats), fields, notes, divisions and the last 50 events.',
  security,
  request: { params: PersonIdParam },
  responses: { 200: detail, 404: unknown, ...errorResponses },
})
const patch = createRoute({
  method: 'patch',
  path: '/people/{id}',
  tags,
  summary: 'Change a person',
  description:
    'Name, nickname, status, role (`null` = the default), divisions, fields (merged; `null` deletes a key) and staff notes. Role and divisions apply to every account of the person.',
  security,
  request: { params: PersonIdParam, body: body(PersonPatchBodySchema) },
  responses: { 200: detail, 404: unknown, 409: refused, ...errorResponses },
})
const link = createRoute({
  method: 'post',
  path: '/people/{id}/accounts',
  tags,
  summary: 'Link an account',
  description:
    'Links a platform account (by the user id seen on a connection) to the person. An account of somebody else is refused: unlink it there first.',
  security,
  request: { params: PersonIdParam, body: body(PersonLinkBodySchema) },
  responses: { 200: detail, 404: unknown, 409: refused, ...errorResponses },
})
const label = createRoute({
  method: 'patch',
  path: '/people/{id}/accounts/{accountId}',
  tags,
  summary: 'Label an account',
  security,
  request: { params: PersonAccountParam, body: body(PersonLabelBodySchema) },
  responses: { 200: detail, 404: unknown, ...errorResponses },
})
const unlink = createRoute({
  method: 'delete',
  path: '/people/{id}/accounts/{accountId}',
  tags,
  summary: 'Unlink an account',
  description: 'The account stays known; it has no person afterwards.',
  security,
  request: { params: PersonAccountParam },
  responses: { 200: detail, 404: unknown, ...errorResponses },
})
const remove = createRoute({
  method: 'delete',
  path: '/people/{id}',
  tags,
  summary: 'Delete a person',
  description:
    'The person goes; their accounts belong to nobody again (guests until linked) and their per-account roles of before go too. The history of changes is kept.',
  security,
  request: { params: PersonIdParam },
  responses: { 204: { description: 'Deleted' }, 404: unknown, ...errorResponses },
})
const pairing = createRoute({
  method: 'post',
  path: '/people/{id}/pairing-code',
  tags,
  summary: 'Pairing code',
  description:
    'A single-use code valid for one hour: the person sends `/link CODE` from the new account. Shown once.',
  security,
  request: { params: PersonIdParam },
  responses: {
    200: { description: 'The code', content: content(PairingCodeSchema) },
    404: unknown,
    409: refused,
    ...errorResponses,
  },
})

/** Only the keys that are set: the port takes `exactOptionalPropertyTypes`. */
const defined = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

export function peopleRoutes(deps: Deps) {
  const people = deps.people
  return new OpenAPIHono()
    .openapi(list, async (c) => c.json(await people.list(defined(c.req.valid('query'))), 200))
    .openapi(unassigned, async (c) =>
      c.json({ items: await people.unassigned(c.req.valid('query').limit) }, 200),
    )
    .openapi(nodes, async (c) => c.json({ items: await people.nodes() }, 200))
    .openapi(fromAccount, async (c) => c.json(await people.fromAccount(c.req.valid('json')), 200))
    .openapi(create, async (c) =>
      c.json(
        await people.create(
          defined(c.req.valid('json')) as PersonPatchInput & { displayName: string },
        ),
        200,
      ),
    )
    .openapi(get, async (c) => c.json(await people.get(c.req.valid('param').id), 200))
    .openapi(patch, async (c) =>
      c.json(await people.update(c.req.valid('param').id, defined(c.req.valid('json'))), 200),
    )
    .openapi(link, async (c) =>
      c.json(await people.link(c.req.valid('param').id, defined(c.req.valid('json'))), 200),
    )
    .openapi(label, async (c) => {
      const { id, accountId } = c.req.valid('param')
      return c.json(await people.setLabel(id, accountId, c.req.valid('json').label), 200)
    })
    .openapi(unlink, async (c) => {
      const { id, accountId } = c.req.valid('param')
      return c.json(await people.unlink(id, accountId), 200)
    })
    .openapi(remove, async (c) => {
      await people.remove(c.req.valid('param').id)
      return c.body(null, 204)
    })
    .openapi(pairing, async (c) => c.json(await people.pairingCode(c.req.valid('param').id), 200))
}
