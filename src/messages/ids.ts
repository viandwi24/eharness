/**
 * UUIDv7 message and turn ids (RFC 9562), monotonic within a generator.
 *
 * Layout: 48-bit Unix ms timestamp · version 7 · 12-bit `rand_a` used as a counter (RFC 9562 §6.2
 * method 1, "fixed bit-length dedicated counter") · variant `10` · 62 random bits.
 *
 * Lexicographic order of the lowercase hex strings equals creation order, which
 * `MessageAdapter`s rely on (spec 05 §4).
 *
 * @see docs/specs/03-messages.md#8-ids
 */

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Highest value of the 12-bit counter. */
const COUNTER_MAX = 0xfff
/** Seeds are drawn below this value so a millisecond always has room for ≥ 2048 ids. */
const COUNTER_SEED_LIMIT = 0x800
/** Largest 48-bit timestamp. */
const MAX_TIMESTAMP = 2 ** 48 - 1

/** Options of {@link createUuidV7Generator} (for tests). */
export interface UuidV7GeneratorOptions {
  /** Clock in epoch ms. Default `Date.now`. */
  now?: () => number
  /** Fills a byte array with random values. Default `crypto.getRandomValues`. */
  random?: (bytes: Uint8Array) => void
}

/**
 * A monotonic UUIDv7 generator.
 *
 * `floor` is the newest id the caller already knows (e.g. the newest message of a session).
 * When the generated id would not sort after it (clock skew between instances, clock going
 * backwards), the id gets the floor's timestamp + 1 ms (spec 03 §8). The bump applies to that
 * call only: it does not move the generator's clock, so a skewed floor of one session never shifts
 * ids of other sessions sharing the generator. Pass the session's newest id on every call.
 */
export type UuidV7Generator = (floor?: string) => string

/**
 * Create an independent monotonic UUIDv7 generator.
 *
 * Within one generator, every id sorts strictly after the previous one, even within the same
 * millisecond or when the clock goes backwards.
 */
export function createUuidV7Generator(options: UuidV7GeneratorOptions = {}): UuidV7Generator {
  const now = options.now ?? (() => Date.now())
  const random =
    options.random ??
    ((bytes: Uint8Array) => {
      crypto.getRandomValues(bytes)
    })
  let lastMs = -1
  let counter = 0
  const bytes = new Uint8Array(10)

  const seedCounter = (): number => {
    random(bytes)
    return (((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0)) % COUNTER_SEED_LIMIT
  }

  return (floor) => {
    const ms = Math.floor(now())
    const floorMs = floor === undefined ? undefined : uuidV7Timestamp(floor)
    if (floorMs !== undefined && floorMs >= Math.max(ms, lastMs)) {
      // per-call floor bump (spec 03 §8): sorts after the floor, generator state untouched
      if (floorMs + 1 > MAX_TIMESTAMP) throw new RangeError('UUIDv7 timestamp overflow')
      const seed = seedCounter()
      random(bytes)
      return format(floorMs + 1, seed, bytes)
    }
    if (ms > lastMs) {
      lastMs = ms
      counter = seedCounter()
    } else {
      // same millisecond (or clock went backwards): keep the last timestamp, count up
      counter += 1
      if (counter > COUNTER_MAX) {
        lastMs += 1
        counter = seedCounter()
      }
    }
    if (lastMs > MAX_TIMESTAMP) throw new RangeError('UUIDv7 timestamp overflow')
    random(bytes)
    return format(lastMs, counter, bytes)
  }
}

function hex(value: number, length: number): string {
  return value.toString(16).padStart(length, '0')
}

function format(ms: number, counter: number, rand: Uint8Array): string {
  const time = hex(ms, 12)
  const randA = hex(counter, 3)
  // variant 10xx in the top bits of rand_b
  const b0 = ((rand[2] ?? 0) & 0x3f) | 0x80
  const tail = hex(b0, 2) + hex(rand[3] ?? 0, 2)
  let node = ''
  for (let i = 4; i < 10; i++) node += hex(rand[i] ?? 0, 2)
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${randA}-${tail}-${node}`
}

/** The default generator used by {@link uuidv7} and {@link nextId}. */
const defaultGenerator: UuidV7Generator = createUuidV7Generator()

/**
 * Generate a UUIDv7 string that sorts after every id generated before it in this process.
 *
 * This is the default `config.generateId`.
 *
 * @example
 * ```ts
 * const a = uuidv7()
 * const b = uuidv7()
 * a < b // true
 * ```
 * @see docs/specs/03-messages.md#8-ids
 */
export function uuidv7(): string {
  return defaultGenerator()
}

/**
 * Generate a UUIDv7 that also sorts after `floor` (the newest id a session knows). The floor bump
 * affects only this call (see {@link UuidV7Generator}).
 *
 * @see docs/specs/03-messages.md#8-ids
 */
export function nextId(floor?: string): string {
  return defaultGenerator(floor)
}

/**
 * Check whether a string is a lowercase UUIDv7 (version 7, RFC 9562 variant).
 *
 * @see docs/specs/03-messages.md#8-ids
 */
export function isUuidV7(id: string): boolean {
  return UUID_V7.test(id)
}

/** Epoch ms timestamp of a UUIDv7, or `undefined` if `id` is not one. */
export function uuidV7Timestamp(id: string): number | undefined {
  if (!isUuidV7(id)) return undefined
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16)
}
