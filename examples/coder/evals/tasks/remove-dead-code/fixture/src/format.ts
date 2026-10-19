function oldPad(s: string): string {
  return ` ${s} `
}

export function legacyFormat(s: string): string {
  return oldPad(s).toUpperCase()
}

export function format(s: string): string {
  return `[${s}]`
}
