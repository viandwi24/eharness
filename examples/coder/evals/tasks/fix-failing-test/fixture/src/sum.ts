export function sum(values: number[]): number {
  let total = 0
  for (let i = 1; i < values.length; i++) total += values[i] as number
  return total
}
