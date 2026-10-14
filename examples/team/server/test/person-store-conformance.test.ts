import { describe, test } from 'bun:test'
import { uuidv7 } from 'eharness'
import { personStoreConformance } from 'eharness/testing'
import { asPersonStore, sqlitePersonStore } from '../src/infra/channels/persons.ts'
import { openDatabase } from '../src/infra/db/client.ts'

describe('sqlite people directory passes the eharness/identity conformance suite', () => {
  const cases = personStoreConformance(() =>
    asPersonStore(sqlitePersonStore(openDatabase(':memory:').sqlite, { next: uuidv7 })),
  )
  for (const c of cases) test(c.name, c.run)
})
