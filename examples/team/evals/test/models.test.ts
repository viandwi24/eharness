import { expect, test } from 'bun:test'
import { ratesFromModelsDev } from '../src/models.ts'

const doc = {
  free: { models: { 'deepseek-x': { cost: { input: 0, output: 0 } } } },
  other: { models: { 'deepseek/deepseek-x': { cost: { input: 1, output: 2 } } } },
  openrouter: { models: { 'deepseek/deepseek-x': { cost: { input: 0.3, output: 1.2 } } } },
}

test('prices come from the openrouter entry, never from a free 0/0 tier', () => {
  expect(ratesFromModelsDev(doc, 'deepseek/deepseek-x')).toEqual({ input: 0.3, output: 1.2 })
})

test('a model that only has free entries has no price', () => {
  expect(ratesFromModelsDev({ free: doc.free }, 'deepseek-x')).toBeUndefined()
})
