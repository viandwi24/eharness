/**
 * Time-sortable ids (UUIDv7, RFC 9562). Own generator: the domain imports nothing, and the
 * ids of eharness messages come from the library.
 */
let lastMs = 0
let seq = 0

/** Monotonic within a process: ids created in the same millisecond still sort by creation. */
export function newId(now: number = Date.now()): string {
  if (now > lastMs) {
    lastMs = now
    seq = 0
  } else {
    seq++ // 12-bit counter in rand_a; on overflow borrow the next millisecond
    if (seq > 0xfff) {
      lastMs++
      seq = 0
    }
  }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let ts = lastMs
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts % 256
    ts = Math.floor(ts / 256)
  }
  bytes[6] = 0x70 | (seq >> 8)
  bytes[7] = seq & 0xff
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Session id of an agent's DM chat. */
export const dmSessionId = (agentId: string): string => `dm:${agentId}`

/** Session id of a delegated task. */
export const taskSessionId = (taskId: string): string => `task:${taskId}`

/** Session id of one routine fire. */
export const routineSessionId = (routineId: string, fireAt: number): string =>
  `routine:${routineId}:${fireAt}`
