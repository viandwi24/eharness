import type { HarnessAgentConfig } from './agent.ts'

/** Names of the timed phases reported as `span` events (see {@link HarnessAgentConfig.observe}). */
export type ObserveSpanName =
  | 'lock.wait'
  | 'turn.prepare'
  | 'compaction'
  | 'state.write'
  | 'message.write'
  | 'model.call'
  | 'tool.execute'

/** Names of the counters reported as `count` events. */
export type ObserveCountName =
  | 'hook.failed'
  | 'hook.timeout'
  | 'events.overflow'
  | 'state.conflict'
  | 'tool-source.backoff'
  | 'warning'

/** Where an observed event happened; every field is present only when it applies. */
export interface ObserveScope {
  sessionId?: string | undefined
  turnId?: string | undefined
  /** Step index (`model.call`). */
  step?: number | undefined
  /** Tool name (`tool.execute`). */
  tool?: string | undefined
  /** Hook name (`turn.prepare`, `hook.failed`, `hook.timeout`). */
  hook?: string | undefined
  /** Plugin (or `app`) that owns the hook, tool source or tool. */
  owner?: string | undefined
  /** Tool source id (`tool-source.backoff`). */
  source?: string | undefined
  /** Warning code (`warning`) or error code. */
  code?: string | undefined
}

/**
 * One operational signal (spec 10 §8). `span`: a phase that took `durationMs` (`ok: false` when it
 * threw). `count`: something happened once.
 */
export type ObserveEvent =
  | ({ type: 'span'; name: ObserveSpanName; durationMs: number; ok: boolean } & ObserveScope)
  | ({ type: 'count'; name: ObserveCountName } & ObserveScope)
