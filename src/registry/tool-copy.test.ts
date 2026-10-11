import { expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod'
import { withToolExecute, withToolFields } from './tool-copy.ts'

const base = tool({
  description: 'd',
  inputSchema: z.object({}),
  execute: async () => 'a',
})

test('withToolExecute replaces execute and keeps other fields', async () => {
  const copy = withToolExecute(base, async () => 'b')
  expect(copy.description).toBe('d')
  expect(copy.inputSchema).toBe(base.inputSchema)
  expect(await copy.execute?.({}, {} as never)).toBe('b')
  expect(await base.execute?.({}, {} as never)).toBe('a')
})

test('withToolExecute throws for a tool without execute', () => {
  const client = tool({ description: 'c', inputSchema: z.object({}) })
  expect(() => withToolExecute(client, async () => 'x')).toThrow(/no `execute`/)
})

test('withToolFields sets fields without mutating', () => {
  const copy = withToolFields(base, { deferLoading: true, metadata: { risk: 'read' } })
  expect(copy.deferLoading).toBe(true)
  expect(base.deferLoading).toBeUndefined()
})
