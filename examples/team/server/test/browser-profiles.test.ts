import { describe, test } from 'bun:test'
import { browserProfileStoreConformance } from 'eharness/testing'
import { sqliteBrowserProfiles } from '../src/infra/db/browser-profiles-repo.ts'
import { openDatabase } from '../src/infra/db/client.ts'

describe('sqlite browser profiles pass the eharness/browser store conformance suite', () => {
  const cases = browserProfileStoreConformance(() =>
    sqliteBrowserProfiles(openDatabase(':memory:').sqlite),
  )
  for (const c of cases) test(c.name, c.run)
})
