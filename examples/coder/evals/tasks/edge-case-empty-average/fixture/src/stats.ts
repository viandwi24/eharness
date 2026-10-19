export function average(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length
}
