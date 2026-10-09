/**
 * Serializes async work per key inside one process (one queue per file), so a check-then-write
 * sequence is atomic for callers in this process. Not a cross-process lock.
 */
export function keyedMutex(): <T>(key: string, work: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>()
  return (key, work) => {
    const result = (tails.get(key) ?? Promise.resolve()).then(work, work)
    const tail = result.catch(() => {})
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return result
  }
}
