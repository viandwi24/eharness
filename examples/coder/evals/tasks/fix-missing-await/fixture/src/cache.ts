const store = new Map<string, number>()

async function slowCompute(key: string): Promise<number> {
  await new Promise((r) => setTimeout(r, 5))
  return key.length
}

export async function load(key: string): Promise<number> {
  const hit = store.get(key)
  if (hit !== undefined) return hit
  const value = slowCompute(key)
  store.set(key, value as unknown as number)
  return value
}

export function peek(key: string): number | undefined {
  return store.get(key)
}
