/**
 * An OpenAPI document as agent tools (`eharness/openapi`), offline: the spec is a small inline
 * JSON object, `fetch` is a fake, and the model is scripted. Shows curation (`include`), the
 * app-supplied base URL and auth header (the spec's `servers` entry is ignored), risk from the HTTP
 * method (writes need approval), and errors as strings the model can read.
 *
 *   bun examples/openapi-tools.ts
 */
import { defineHarnessAgent } from 'eharness'
import { openApiTools } from 'eharness/openapi'
import { exampleModel } from './shared/model.ts'

const spec = {
  openapi: '3.0.3',
  info: { title: 'Orders', version: '1.0.0' },
  servers: [{ url: 'http://169.254.169.254/latest' }], // never used: the app supplies baseUrl
  components: {
    schemas: {
      Order: {
        type: 'object',
        properties: { id: { type: 'string' }, total: { type: 'number' } },
      },
    },
  },
  paths: {
    '/orders/{id}': {
      get: {
        operationId: 'getOrder',
        summary: 'Get one order',
        tags: ['orders'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
      delete: {
        operationId: 'cancelOrder',
        summary: 'Cancel an order',
        tags: ['orders'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },
    '/admin/export': { get: { operationId: 'exportAll', tags: ['admin'] } },
  },
}

const requests: string[] = []
const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const headers = new Headers(init?.headers)
  requests.push(`${init?.method} ${String(url)} auth=${headers.get('authorization')}`)
  if (String(url).endsWith('/orders/o-404')) {
    return new Response('order not found', { status: 404, statusText: 'Not Found' })
  }
  return Response.json({ id: 'o-1', total: 42 })
}) as typeof fetch

const orders = openApiTools(spec, {
  name: 'orders',
  baseUrl: 'https://orders.example.com/v1',
  headers: (ctx) => ({ authorization: `Bearer ${String(ctx.runtime.token)}` }),
  include: { tags: ['orders'] }, // curate: the admin export is not offered to the model
  fetch: fakeFetch,
})

const agent = defineHarnessAgent({
  model: exampleModel([
    { toolCalls: [{ toolName: 'orders_getOrder', input: { path: { id: 'o-404' } } }] },
    { toolCalls: [{ toolName: 'orders_getOrder', input: { path: { id: 'o-1' } } }] },
    { toolCalls: [{ toolName: 'orders_cancelOrder', input: { path: { id: 'o-1' } } }] },
    { text: 'Order o-1 exists; cancelling it needs your approval.' },
  ]),
  contextWindow: 200_000,
  tools: [orders],
  // GET → read (approved); DELETE → destructive (a person decides)
  approval: { risk: { read: 'approved', write: 'approved', destructive: 'user-approval' } },
})

const run = await agent
  .session('orders-demo', { runtime: { token: 'demo-token' } })
  .send('Look at order o-404, then o-1, then cancel o-1.').result
console.log(`turn: ${run.stop}`)
for (const line of requests) console.log(`request: ${line}`)
const outputs = run.messages
  .find((m) => m.id === run.messageId)
  ?.parts.flatMap((p) => ('output' in p ? [JSON.stringify(p.output)] : []))
console.log(`tool outputs: ${outputs?.join(' | ')}`)
console.log(`pending: ${run.pending?.approvals.map((a) => a.toolName).join(', ')}`)
await agent.close()
