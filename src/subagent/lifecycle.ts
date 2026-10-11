/**
 * The life of one child session while it runs in this process: the abort wiring, the concurrency
 * slot and the session handle. Every execution mode (foreground, user-backgrounded, background,
 * park) goes through {@link withChildLifecycle}, so none of them can leak a listener, a slot or an
 * open child on an early exit.
 *
 * The durable background start (ADR-0046) is the one exception: its child handle must stay open to
 * drain its own inbox, so it only uses {@link closeChild} on failure.
 *
 * @see docs/specs/20-subagent-plugin.md
 */
import type { SessionOptions } from '../index.ts'
import { closeChild } from './child-run.ts'
import { wireRunning } from './entries.ts'
import type { Scope } from './env.ts'
import type { AgentEntry } from './messaging.ts'
import type { AnySession, SubagentDefinition } from './types.ts'

/** What a running child holds: its abort controller, its slot and (once opened) its session. */
export interface ChildLease {
  /** The child's own abort: follows `follow` and, unless disabled, the parent session. */
  readonly ac: AbortController
  /**
   * Open the child session. The first open wires `entry` (when given) for message delivery;
   * {@link ChildLease.end} closes the session again.
   */
  open(options: SessionOptions): AnySession
  /** Stop following the `follow` signal (a foreground child moved to the background). */
  unfollow(): void
}

/** Arguments of {@link withChildLifecycle}. */
export interface ChildLifecycleArgs<R> {
  scope: Scope
  def: SubagentDefinition
  sessionId: string
  /** Directory entry of the child: wired for message delivery when the session opens. */
  entry?: AgentEntry | undefined
  /** An abort controller the caller already hands out (a `stop` function); default: a new one. */
  ac?: AbortController
  /** An outside signal the child follows (the tool call, the park wait). */
  follow?: AbortSignal
  /** Abort the child when the parent session closes (default). `'park'` children outlive it. */
  followParent?: boolean
  /** Waiting for a slot was aborted: the child never started. */
  onRefused: () => R | Promise<R>
}

/**
 * Run `fn` for one child: wire the aborts, wait for a free slot of this depth, and afterwards
 * (however `fn` ends) remove the listeners, close the child session if it was opened and release
 * the slot. `fn` must not throw for run errors; if it does, the cleanup still runs.
 */
export async function withChildLifecycle<R>(
  a: ChildLifecycleArgs<R>,
  fn: (lease: ChildLease) => Promise<R>,
): Promise<R> {
  const { scope, def, sessionId, entry, follow } = a
  const ac = a.ac ?? new AbortController()
  const onFollow = (): void => ac.abort(follow?.reason)
  const onParentClosed = (): void => ac.abort('parent closed')
  const followParent = a.followParent !== false
  if (follow !== undefined) {
    if (follow.aborted) onFollow()
    else follow.addEventListener('abort', onFollow, { once: true })
  }
  if (followParent) scope.ctx.signal.addEventListener('abort', onParentClosed, { once: true })
  const unfollow = (): void => follow?.removeEventListener('abort', onFollow)
  const dropListeners = (): void => {
    unfollow()
    if (followParent) scope.ctx.signal.removeEventListener('abort', onParentClosed)
  }
  const sem = scope.env.semaphoreFor(scope.depth)
  if (!(await sem.acquire(ac.signal))) {
    dropListeners()
    return await a.onRefused()
  }
  let opened = false
  try {
    return await fn({
      ac,
      unfollow,
      open(options) {
        const child = def.agent.session(sessionId, options) as AnySession
        opened = true
        if (entry !== undefined) wireRunning(entry, child)
        return child
      },
    })
  } finally {
    dropListeners()
    if (opened) await closeChild(def, sessionId)
    sem.release()
  }
}
