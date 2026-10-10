/** `bun run openapi`: write ../shared/openapi.json from the routes (no server, no model). */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { OPENAPI_DOC } from '../src/http/app.ts'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose } from '../src/main.ts'

const target = new URL('../../shared/openapi.json', import.meta.url).pathname
const server = compose({
  dbFile: ':memory:',
  seed: false,
  models: scriptedModelConfig('export' as never),
})
const doc = server.app.getOpenAPI31Document(OPENAPI_DOC)
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`)
console.log(`wrote ${target}`)
await server.close()
