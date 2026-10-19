export function lineItem(name: string, cents: number): string {
  return `${name}: $${(cents / 100).toFixed(2)}`
}

export function totalLine(cents: number): string {
  return `TOTAL: $${(cents / 100).toFixed(2)}`
}
