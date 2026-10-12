import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import {
  applyProposal,
  editPersona,
  getPersonaState,
  personaHistory,
  rejectProposal,
  revertPersona,
  WEB_ACTOR,
} from '../../app/persona.ts'
import type { Deps } from '../../app/ports.ts'
import { errorResponses, IdParam, jsonError } from '../schemas/common.ts'
import {
  PERSONA_LIMITS,
  PersonaEditSchema,
  PersonaHistorySchema,
  PersonaProposalParam,
  PersonaProposalSchema,
  PersonaRevertSchema,
  PersonaStateSchema,
  PersonaVersionSchema,
} from '../schemas/persona.ts'

const security = [{ Bearer: [] }]
const json = <T extends Parameters<typeof Object>[0]>(schema: T) => ({
  'application/json': { schema },
})
const tags = ['persona']

const getRoute = createRoute({
  method: 'get',
  path: '/agents/{id}/persona',
  tags,
  summary: 'The persona of an agent',
  description:
    'The current persona (identity, voice and preferences, operating rules) and the proposals waiting for an admin. An agent that has none yet gets its first version made from its instructions.',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'The persona', content: json(PersonaStateSchema) },
    404: jsonError('Unknown agent'),
    ...errorResponses,
  },
})

const editRoute = createRoute({
  method: 'patch',
  path: '/agents/{id}/persona',
  tags,
  summary: 'Edit the persona (a new version)',
  description:
    'A token holder is an admin: the edit is a new version at once (author "the web app", source `web`), effective from the agent next turn. Size and obvious injection patterns are checked; operating rules only by size. Nothing changes when the text is the same.',
  security,
  request: { params: IdParam, body: { required: true, content: json(PersonaEditSchema) } },
  responses: {
    200: { description: 'The current version', content: json(PersonaVersionSchema) },
    404: jsonError('Unknown agent'),
    409: jsonError('The agent is archived, or the persona changed concurrently'),
    ...errorResponses,
  },
})

const historyRoute = createRoute({
  method: 'get',
  path: '/agents/{id}/persona/history',
  tags,
  summary: 'Versions of the persona',
  description:
    'Every version, newest first, with author, source, reason and the diff against the one before.',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'The versions', content: json(PersonaHistorySchema) },
    404: jsonError('Unknown agent'),
    ...errorResponses,
  },
})

const revertRoute = createRoute({
  method: 'post',
  path: '/agents/{id}/persona/revert',
  tags,
  summary: 'Restore an earlier version as a new version',
  description:
    'Restores the identity and voice of a version (the history keeps everything; the operating rules stay as they are).',
  security,
  request: { params: IdParam, body: { required: true, content: json(PersonaRevertSchema) } },
  responses: {
    200: { description: 'The new version', content: json(PersonaVersionSchema) },
    404: jsonError('Unknown agent or version'),
    ...errorResponses,
  },
})

const applyRoute = createRoute({
  method: 'post',
  path: '/agents/{id}/persona/proposals/{proposalId}/apply',
  tags,
  summary: 'Apply a proposal (a new version)',
  description:
    'Confirms a proposal the agent opened for a member or an admin. A proposal that was written against an older persona is `stale` and refused.',
  security,
  request: { params: PersonaProposalParam },
  responses: {
    200: { description: 'The new version', content: json(PersonaVersionSchema) },
    404: jsonError('Unknown proposal'),
    409: jsonError('Decided already, or stale'),
    ...errorResponses,
  },
})

const rejectRoute = createRoute({
  method: 'post',
  path: '/agents/{id}/persona/proposals/{proposalId}/reject',
  tags,
  summary: 'Reject a proposal',
  security,
  request: { params: PersonaProposalParam },
  responses: {
    200: { description: 'The proposal', content: json(PersonaProposalSchema) },
    404: jsonError('Unknown proposal'),
    409: jsonError('Decided already'),
    ...errorResponses,
  },
})

export function personaRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(getRoute, (c) =>
      c.json({ ...getPersonaState(deps, c.req.valid('param').id), limits: PERSONA_LIMITS }, 200),
    )
    .openapi(editRoute, (c) =>
      c.json(editPersona(deps, c.req.valid('param').id, c.req.valid('json')), 200),
    )
    .openapi(historyRoute, (c) =>
      c.json({ items: personaHistory(deps, c.req.valid('param').id) }, 200),
    )
    .openapi(revertRoute, (c) =>
      c.json(
        revertPersona(deps, c.req.valid('param').id, c.req.valid('json').version, WEB_ACTOR),
        200,
      ),
    )
    .openapi(applyRoute, (c) =>
      c.json(applyProposal(deps, c.req.valid('param').proposalId, WEB_ACTOR).version, 200),
    )
    .openapi(rejectRoute, (c) =>
      c.json(rejectProposal(deps, c.req.valid('param').proposalId, WEB_ACTOR), 200),
    )
}
