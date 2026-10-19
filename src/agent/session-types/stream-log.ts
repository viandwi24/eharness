/**
 * Stream log port (resumable streams).
 *
 * @see docs/specs/05-session-and-storage.md
 */

/** Key of one turn's chunk log (spec 04 §6.2). */
export interface StreamLogKey {
  sessionId: string
  turnId: string
}

/** Lifecycle of a stream log: `missing` = never written, expired or unknown. */
export type StreamLogStatus = 'streaming' | 'done' | 'error' | 'aborted' | 'missing'

/** Result of {@link StreamLogAdapter.read}. */
export interface StreamLogRead {
  /** Chunks `from` … `next - 1`, in order (JSON values). */
  chunks: unknown[]
  /** Cursor of the first chunk not returned: `from + chunks.length`. */
  next: number
  status: StreamLogStatus
}

/**
 * Short-lived, append-only log of the UI message chunks of one turn (spec 04 §6.2, ADR-0039): lets
 * a reader in another process replay and follow a turn it does not own. Cursor = 0-based chunk
 * index within the turn. Committed messages stay the truth; the log is only for live resume.
 * eharness ships `inMemoryStreamLog()` (`eharness/storage/memory`) and `streamLogConformance`
 * (`eharness/testing`).
 *
 * @see docs/specs/04-streaming.md#62-stream-log-port
 *
 * @experimental Draft (stream log, spec 04 §6): may change in a minor release (docs/engineering/api-stability.md).
 */
export interface StreamLogAdapter {
  /**
   * Append `chunks` (JSON values) and return the new length. With `at`, the first chunk takes
   * cursor `at`: chunks that are already stored (length > `at`) are skipped, so a retried call is
   * idempotent; `at` greater than the length (or `at` > 0 on a log that does not exist) rejects
   * and must not create a log: the writer then restarts from `at: 0`. Appending to a closed log is ignored
   * (returns the length).
   */
  append(key: StreamLogKey, chunks: unknown[], options?: { at?: number }): Promise<number>
  /** Mark the end of the turn. Idempotent; the first status wins. */
  close(key: StreamLogKey, status: 'done' | 'error' | 'aborted'): Promise<void>
  /** Read up to `limit` chunks starting at cursor `from`. Never waits. */
  read(key: StreamLogKey, from: number, options?: { limit?: number }): Promise<StreamLogRead>
  /** Optional push: called after every append and on close. Returns the unsubscribe function. */
  subscribe?(key: StreamLogKey, onAppend: () => void): () => void
  /**
   * Optional: drop the log `ttlMs` from now (the core calls it after `close`, and, while a quiet
   * turn is still streaming, as a keep-alive that refreshes the retention).
   */
  expire?(key: StreamLogKey, ttlMs: number): Promise<void>
}
