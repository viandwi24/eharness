/** `httpConformance` against the team server's harness HTTP (composed in memory, no network). */
import { test } from 'bun:test'
import { httpConformance, scriptedModel } from 'eharness/testing'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

let server: Server | undefined
const dispose = async (): Promise<void> => {
  await server?.close()
  server = undefined
}

const cases = httpConformance(
  () => {
    const app = compose({
      dbFile: ':memory:',
      token: undefined, // open access: the suite sends no credentials
      // the suite needs replies that take a while (each stream part waits 60 ms)
      models: scriptedModelConfig(
        scriptedModel(Array.from({ length: 40 }, () => ({ text: 'a slow answer', delayMs: 60 }))),
      ),
    })
    server = app
    return { fetch: (request) => Promise.resolve(app.app.fetch(request)) }
  },
  {
    dispose,
    // the team only serves the DMs of agents it knows: create one agent per case and use its DM
    sessionId: async (suggested) => {
      const res = await server?.app.request('/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: suggested, instructions: 'Answer briefly.' }),
      })
      if (res?.status !== 201) throw new Error(`could not create the agent: ${res?.status}`)
      const agent = (await res.json()) as { id: string }
      return `dm:${agent.id}`
    },
  },
)
// The team mounts the handler inside its own Hono app, which answers an unknown path with its own
// error code (`NOT_FOUND`), not the library's `EH_HTTP_NOT_FOUND`: that one case is the app's contract.
const OWN_404 = 'an unknown path is a 404 with the error shape'
for (const c of cases) {
  if (c.name === OWN_404) continue
  test(c.name, c.run, 20_000)
}
