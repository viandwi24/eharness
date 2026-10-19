export function isEmail(value: string): boolean {
  return /^.+@.+$/.test(value)
}
