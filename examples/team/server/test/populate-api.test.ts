import { afterEach, expect, test } from 'bun:test'
import { cleanup, instance, populateBase } from './support/backup-world.ts'
import { populateApi } from './support/populate-api.ts'

afterEach(cleanup)

const TABLES = [
  'api_agents',
  'api_keys',
  'api_conversations',
  'api_requests',
  'api_calls',
  'artifacts',
  'artifact_versions',
  'artifact_blobs',
  'artifact_events',
  'browser_profiles',
  'library_files',
]

test('populateApi fills the API, artifact, browser and upload tables', async () => {
  const { server } = instance()
  const base = await populateBase(server)
  const world = await populateApi(server, base)
  const count = (t: string, where = '1=1'): number =>
    (
      server.conn.sqlite.query(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`).get() as {
        n: number
      }
    ).n
  for (const t of TABLES) expect(count(t), t).toBeGreaterThan(0)
  expect(count('api_agents')).toBe(2)
  expect(count('api_agents', 'archived_at IS NOT NULL')).toBe(1)
  expect(count('api_keys', 'revoked_at IS NOT NULL')).toBe(1)
  expect(count('artifact_versions')).toBeGreaterThan(3)
  expect(count('library_files', "path LIKE '/uploads/%'")).toBe(world.uploadPaths.length)
  expect(world.shareToken.length).toBeGreaterThan(8)

  const agents = await server.app.request('/v1/agents', {
    headers: { authorization: `Bearer ${world.apiKey}` },
  })
  expect(agents.status).toBe(200)
  const bad = await server.app.request('/v1/agents', { headers: { authorization: 'Bearer nope' } })
  expect(bad.status).toBe(401)
})
