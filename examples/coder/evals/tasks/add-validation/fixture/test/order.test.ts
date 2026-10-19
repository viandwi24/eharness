import { expect, test } from 'bun:test'
import { totalPrice } from '../src/order.ts'

test('total', () => {
  expect(totalPrice(5, 3)).toBe(15)
})
