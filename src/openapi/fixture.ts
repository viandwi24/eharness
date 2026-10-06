/**
 * A petstore-like OpenAPI 3.0 fixture (tests and the offline example): `$ref`s, a recursive schema,
 * path / query / header / body parameters, an API-key scheme, a hostile `servers` entry.
 */
export const PETSTORE_SPEC = {
  openapi: '3.0.3',
  info: { title: 'Petstore', version: '1.0.0' },
  // never trusted by default (SSRF)
  servers: [{ url: 'http://169.254.169.254/latest' }],
  components: {
    securitySchemes: {
      key: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
    },
    schemas: {
      Pet: {
        type: 'object',
        required: ['name'],
        properties: {
          id: { type: 'integer', readOnly: true },
          name: { type: 'string', description: 'The pet name.' },
          tag: { type: 'string', nullable: true },
          friend: { $ref: '#/components/schemas/Pet' },
        },
      },
      NewPet: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' }, tag: { type: 'string' } },
      },
    },
    parameters: {
      Limit: { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } },
    },
  },
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        summary: 'List pets',
        tags: ['pets'],
        parameters: [
          { $ref: '#/components/parameters/Limit' },
          { name: 'tags', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
          { name: 'X-Request-Id', in: 'header', schema: { type: 'string' } },
          { name: 'X-Api-Key', in: 'header', schema: { type: 'string' } },
          { name: 'session', in: 'cookie', schema: { type: 'string' } },
        ],
      },
      post: {
        operationId: 'createPet',
        summary: 'Create a pet',
        tags: ['pets'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/NewPet' } } },
        },
      },
    },
    '/pets/{petId}': {
      parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        operationId: 'getPet',
        summary: 'Get one pet',
        tags: ['pets'],
      },
      delete: { operationId: 'deletePet', summary: 'Delete a pet', tags: ['pets'] },
    },
    '/admin/users': {
      get: { operationId: 'listUsers', tags: ['admin'] },
    },
    '/pets/{petId}/photo': {
      put: {
        operationId: 'uploadPhoto',
        requestBody: {
          required: true,
          content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
        },
      },
    },
  },
} as const

/** A spec with `count` generated GET operations. */
export function bigSpec(count: number): object {
  const paths: Record<string, unknown> = {}
  for (let i = 0; i < count; i++) paths[`/r${i}`] = { get: { operationId: `op${i}` } }
  return { openapi: '3.1.0', info: { title: 'Big', version: '1' }, paths }
}
