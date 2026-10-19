import { expect, test } from 'bun:test'
import { fizzbuzz } from '../src/fizz.ts'

test('fizzbuzz', () => {
  expect(fizzbuzz(15)).toEqual(['1', '2', 'Fizz', '4', 'Buzz', 'Fizz', '7', '8', 'Fizz', 'Buzz', '11', 'Fizz', '13', '14', 'FizzBuzz'])
  expect(fizzbuzz(0)).toEqual([])
})
