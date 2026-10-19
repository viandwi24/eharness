let count = 0

export function makeCounter(): { next(): number } {
  return {
    next() {
      count += 1
      return count
    },
  }
}
