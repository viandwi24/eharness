/**
 * Every recipe of the web app (web/src/lib/scripts/recipes.ts) builds a manifest the server accepts
 * and code that passes Check (types, lint, grants), so a recipe never drifts from the script API.
 */
import { describe, expect, test } from 'bun:test'
import { RECIPES } from '../../web/src/lib/scripts/recipes.ts'
import { parseManifest } from '../src/domain/script-manifest.ts'
import { scriptTypes } from '../src/domain/scripts.ts'
import { checkScript } from '../src/infra/scripts/check.ts'
import { HOST_METHODS } from '../src/infra/scripts/host.ts'

const chat = (c: string) => ({ connection: 'c1', chat: c })
const VALUES = {
  from: chat('Signals'),
  to: chat('VIP'),
  to2: chat('Desk'),
  chat: chat('Group'),
  words: ['buy', 'sell'],
  table: 'signals',
  reply: 'Hi',
  text: 'Hello',
  time: '09:00',
  agent: 'lead',
  file: '/library/a.png',
  limit: '5',
  minutes: '10',
  welcome: 'Hi {name}',
}

describe('recipes', () => {
  const types = scriptTypes(HOST_METHODS)
  for (const r of RECIPES) {
    test(`${r.id}: the manifest parses and the code passes Check`, async () => {
      const b = r.build(VALUES as never)
      const m = parseManifest(b.manifest)
      if (!m.ok) throw new Error(m.errors.join('; '))
      const c = await checkScript({ source: b.source, types, manifest: m.value })
      expect(c.problems).toEqual([])
    })
  }
})
