import { expect, test } from 'bun:test'
import { totalPrice } from '../src/order.ts'

test('rejects', () => {
  expect(() => totalPrice(5, 0)).toThrow('quantity must be positive')
  expect(() => totalPrice(5, -2)).toThrow('quantity must be positive')
})
