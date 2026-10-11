/**
 * Timing and randomness helpers shared by our own tests. Internal: not exported from
 * `eharness/testing` and not bundled (nothing public imports this file).
 */

/** Resolve after `ms` milliseconds. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Poll `condition` every few ms until it holds; rejects with `what` after `ms`. Prefer this to a
 * fixed `sleep` whenever a test waits for an effect.
 */
export async function until(
  what: string,
  condition: () => boolean | Promise<boolean>,
  ms = 5_000,
): Promise<void> {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(3)
  }
}

/** Deterministic PRNG (mulberry32) so a failing run can be reproduced from its seed. */
export function prng(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
