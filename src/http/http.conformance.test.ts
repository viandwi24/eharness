/** `httpConformance` against `createHarnessHttp(...).fetch` and through a real `Bun.serve`. */
import { test } from 'bun:test'
import { defineHarnessAgent } from '../index.ts'
import { memoryMessages, memoryState, memoryStreamLog } from '../storage/memory.ts'
import { httpConformance } from '../testing/index.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { createHarnessHttp, openAccess } from './index.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function slowAgent() {
  return defineHarnessAgent({
    model: scriptedModel(
      Array.from({ length: 20 }, () => ({ text: 'a slow answer', delayMs: 60 })),
    ),
    contextWindow: 100_000,
    storage: { messages: memoryMessages(), state: memoryState(), streams: memoryStreamLog() },
    streams: { flushMs: 5, pollMs: 10 },
    logger: silent,
    onWarning() {},
  })
}

let agent: ReturnType<typeof slowAgent> | undefined
let server: ReturnType<typeof Bun.serve> | undefined
const dispose = async () => {
  await server?.stop(true)
  server = undefined
  await agent?.close()
  agent = undefined
}

for (const c of httpConformance(
  () => {
    agent = slowAgent()
    const http = createHarnessHttp(agent, { authorize: openAccess })
    return { fetch: http.fetch }
  },
  { dispose },
)) {
  test(`fetch: ${c.name}`, c.run)
}

for (const c of httpConformance(
  () => {
    agent = slowAgent()
    const http = createHarnessHttp(agent, { authorize: openAccess, basePath: '/api' })
    server = Bun.serve({ port: 0, fetch: http.fetch })
    return {
      baseUrl: `http://localhost:${server.port}/api`,
      fetch: (request) => fetch(request),
    }
  },
  { dispose },
)) {
  test(`Bun.serve: ${c.name}`, c.run)
}
