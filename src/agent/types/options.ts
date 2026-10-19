/**
 * Per-area option types of `HarnessAgentConfig` (inbox, tool sources, hooks, loop, approval, cache, compaction, ...).
 *
 * @see docs/specs/01-agent-and-plugins.md#1-defineharnessagent
 */
import type {
  LanguageModel,
  LanguageModelCallOptions,
  RequestOptions,
  TimeoutConfiguration,
  ToolApprovalConfiguration,
  ToolApprovalStatus,
  ToolResultPart,
  ToolSet,
} from 'ai'
import type { ProviderOptions } from '../../internal/ai-types.ts'
import type { HarnessUIMessage, ToolRisk } from '../../messages/types.ts'
import type { HarnessContext } from '../../plugin/types.ts'

/**
 * Backoff between failed attempts of an inbox item (`inbox.retry.backoff`): `fixed` waits
 * `delayMs`, `exponential` (default) `delayMs × 2^(attempts − 1)`, both capped at `maxDelayMs`;
 * `jitter` (default true) draws the wait uniformly from `[0, delay]` (full jitter).
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
export interface InboxBackoffOptions {
  /** Default `'exponential'`. */
  type?: 'fixed' | 'exponential'
  /** Default 1 000. */
  delayMs?: number
  /** Default 60 000. */
  maxDelayMs?: number
  /** Default true. */
  jitter?: boolean
}

/**
 * Poison-item limits of the durable inbox (`inbox.retry`, spec 05 §12 rules 11–13). Without it
 * an item is redelivered without limit.
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
export interface InboxRetryOptions {
  /** Counted claims after which an item is dead-lettered. Default: unlimited. */
  maxAttempts?: number
  backoff?: InboxBackoffOptions
  /** Failures that go dead at once (reason `'non-retryable'`). Default: `code === 'EH_INVALID_INPUT'`. */
  nonRetryable?: (error: { code?: string; message: string }) => boolean
}

/**
 * Limits of tool source listing (spec 02 §3.1).
 *
 * @see docs/specs/02-context-registry.md#3-tools
 */
export interface ToolSourcesConfig {
  /** Default 30 000 — a `list()` that does not settle in this time fails (`W_TOOL_SOURCE_FAILED`). */
  timeoutMs?: number
  /**
   * Default 5 000 — a failed source is not asked again for this long, doubling per consecutive
   * failure up to 60 000. `0` retries at the next turn.
   */
  retryAfterMs?: number
}

/**
 * Limits of awaited plugin hooks.
 *
 * @see docs/specs/01-agent-and-plugins.md#5-hooks
 */
export interface HooksConfig {
  /**
   * Default 30 000 — a hook the core awaits that does not settle within this time is treated as a
   * throwing hook (`W_HOOK_TIMEOUT`; `input.submit` still blocks, `tool.approve` still denies).
   * Aborting the turn also cuts running hooks short.
   */
  timeoutMs?: number
}

/**
 * Loop limits and persistence.
 *
 * @see docs/specs/01-agent-and-plugins.md#1-defineharnessagent
 */
export interface LoopConfig {
  /** Default 500 — per turn (stop `'max-steps'`; extensible by `turn.beforeEnd`). */
  maxSteps?: number
  /**
   * Default true — when the step budget runs out, run one more step without tools that asks the
   * model to summarize what it did and what is left (the stop stays `'max-steps'`).
   */
  wrapUp?: boolean
  /** Default none — output-token cap incl. nested usage (stop `'cost-cap'`). */
  maxTurnOutputTokens?: number
  /** Default none — wall clock per turn (stop `'timeout'`). */
  turnTimeoutMs?: number
  /** Default none — absolute cap on forced continuations per turn via `turn.beforeEnd`. */
  maxContinues?: number
  /**
   * Default 3 — continuations in a row after which the turn made no progress (no new successful
   * tool result) before further continuations are refused (`W_CONTINUE_LIMIT`).
   */
  maxIdleContinues?: number
  /** Stuck detection (spec 05 §3.2). `false` disables it. */
  progress?: ProgressConfig | false
  /** Default true — upsert the assistant message after every step. */
  persistEachStep?: boolean
}

/**
 * Progress guard: a turn that repeats the same call with the same result, or whose tool calls keep
 * failing, gets one reminder and then stops with `'stuck'`.
 *
 * @see docs/specs/05-session-and-storage.md#32-progress-guard-normative
 */
export interface ProgressConfig {
  /** Default 3 — the same call with the same result this many times within `window` steps. */
  repeats?: number
  /** Default 20 — steps (that called tools) examined for repeats. */
  window?: number
  /** Default 5 — steps in a row whose tool calls all failed. */
  errorStreak?: number
  /** Default 8 — failed results in a row of one tool (any inputs), with no success of it between. */
  toolErrorStreak?: number
  /** Default 1 — reminders before the turn stops with `'stuck'`. 0 stops at once. */
  nudges?: number
  /** Tools that may legitimately repeat (polling, waiting); ignored by the guard. */
  ignoreTools?: string[]
}

/**
 * Model settings passed to every `streamText` call.
 *
 * @see docs/specs/01-agent-and-plugins.md#1-defineharnessagent
 */
export type ModelSettings = Pick<
  LanguageModelCallOptions,
  | 'maxOutputTokens'
  | 'temperature'
  | 'topP'
  | 'topK'
  | 'presencePenalty'
  | 'frequencyPenalty'
  | 'stopSequences'
  | 'seed'
  | 'reasoning'
> &
  Pick<RequestOptions, 'maxRetries'> & {
    headers?: Record<string, string>
    providerOptions?: ProviderOptions
    /**
     * Per step. A number means `stepMs`. `totalMs` is rejected — use `loop.turnTimeoutMs`.
     * Default `{ firstChunkMs: 120_000, chunkMs: 120_000 }` (idle timeouts: a stream that goes
     * silent fails the step instead of holding the session forever); keys you set override the
     * default per key, `false` turns the default off.
     */
    timeout?: number | false | Omit<Exclude<TimeoutConfiguration<ToolSet>, number>, 'totalMs'>
    /** Retries of a step after streaming started (AI SDK `streamRetries`). */
    streamRetries?: number
  }

/**
 * Human-in-the-loop tool approval.
 *
 * @see docs/specs/11-interaction.md#3-tool-approval
 */
export interface ApprovalConfig {
  /** Static policy; same shape as AI SDK `ToolApprovalConfiguration`. */
  policy?: ToolApprovalConfiguration<ToolSet, unknown>
  /**
   * Status per tool risk (spec 11 §3.2); `unknown` applies to tools without a risk. Combined with
   * the policy and hooks, most restrictive wins.
   *
   * @example { destructive: 'user-approval', unknown: 'user-approval' }
   */
  risk?: Partial<Record<ToolRisk | 'unknown', ToolApprovalStatus>>
  /**
   * Passed as `experimental_toolApprovalSecret`: HMAC-signs requests.
   *
   * @experimental Relies on the AI SDK option `experimental_toolApprovalSecret`; an upstream
   * rename or removal changes this option (docs/engineering/api-stability.md).
   */
  secret?: string
  /** What `send()`/`regenerate()`/`edit()` do while approvals are pending. Default `'deny'`. */
  onNewInput?: 'deny' | 'reject'
}

/**
 * Prompt caching configuration.
 *
 * @see docs/specs/02-context-registry.md#61-cache-configuration
 */
export interface CacheConfig {
  mode?: 'auto' | 'breakpoints'
  ttl?: '5m' | '1h'
}

/**
 * File parts of user input (spec 05 §3 step 7). A URL outside `protocols` or a `data:` URL over
 * `maxBytes` is `EH_INVALID_INPUT`.
 *
 * @see docs/specs/05-session-and-storage.md#3-turn-lifecycle-normative-order
 */
export interface InputFilesConfig {
  /** Allowed URL protocols (lowercase, with the colon). Default `['data:', 'https:']`. */
  protocols?: string[]
  /** Maximum decoded size of a `data:` URL in bytes. Default 20 MB (20 971 520). */
  maxBytes?: number
  /**
   * Resolve a stored file URL for the model (spec 03 §6). Called at projection time for
   * every file part whose URL is not a `data:` URL, so apps keep references (a custom protocol
   * listed in `protocols`, e.g. `library://uploads/7`) in stored messages instead of inlined
   * base64. The stored message is never changed. Return `{ data }` (bytes or base64) or
   * `{ url }` (a URL the provider can fetch, e.g. signed), optionally with the real `mediaType`;
   * `undefined` leaves the part as it is; `null` (or a throw) replaces it with the
   * `FILE_UNAVAILABLE` text on the wire. Token estimates and compaction summaries do not call it.
   */
  resolve?: (
    url: string,
    ctx: { sessionId: string; mediaType: string; filename?: string },
  ) => Promise<ResolveInputFile | null | undefined> | ResolveInputFile | null | undefined
  /**
   * Tell the model where a file lives (spec 03 §6). Called at projection time for every `file`
   * part of a user message or steer whose URL is not a `data:` URL (a reference such as
   * `library:///uploads/x.png`); a returned string is added as a text part right after the file,
   * so the model can pass the reference on (for example to a subagent). `undefined` adds nothing.
   * The stored message is never changed; token estimates do not call it.
   */
  describe?: (file: { url: string; mediaType: string; filename?: string }) => string | undefined
}

/** A file resolved by {@link InputFilesConfig.resolve}: exactly one of `data` and `url`. */
export interface ResolveInputFile {
  mediaType?: string
  /** Raw bytes or a base64 string. */
  data?: Uint8Array | string
  url?: string
}

/** Maps a thrown tool error to its text (`config.toolErrorText`). */
export type ToolErrorTextFn = (
  error: unknown,
  call: { toolName: string; toolCallId: string },
) => string

/**
 * Tool result size limits.
 *
 * @see docs/specs/09-tools-and-mcp.md
 */
export interface ToolOutputConfig {
  /** Default 50_000 per result. */
  maxChars?: number
  perTool?: Record<string, number | false>
  /** Default `'truncate'`. */
  strategy?: 'truncate' | 'evict'
  /**
   * Media (screenshots, images) in tool results the model sees: the newest N; older ones become a
   * short note. Default: all. The stored messages keep every image.
   */
  keepImages?: number
}

/**
 * Limits on the tool calls of one model step (spec 09 §4.1). A model that degenerates can emit
 * hundreds of parallel calls in one step; past the limit, and for an exact repeat of a call of the
 * same step, the call is not executed and the model reads why.
 */
export interface ToolCallsConfig {
  /** Calls executed per step. Default 24. */
  maxPerStep?: number
  /**
   * Per turn: the same tool with the same input returning the same result (or the same error text)
   * this many times in a row stops running; the model reads a refusal. Different results reset the
   * count (polling stays allowed). Default 3; 0 disables.
   */
  maxIdenticalResults?: number
}

/**
 * Compaction configuration.
 *
 * @see docs/specs/06-compaction.md#1-configuration
 */
export interface CompactionConfig {
  /** Summarize when projected context exceeds this ratio of `contextWindow`. Default 0.75. */
  summarizeAt?: number
  /** Most recent completed turns kept verbatim. Default 4. */
  keepLast?: number
  /** Summarizer model. Default: agent model. */
  model?: LanguageModel
  /** Summarizer context window. */
  contextWindow?: number
  /** Replace the default summarizer instructions. */
  prompt?: string
  /** Max tokens for the summary. Default 4_000. */
  maxSummaryTokens?: number
  /** Token counter. Default `ceil(chars / 4)`, calibrated by provider usage. */
  countTokens?: (text: string) => number
  /** Escape hatch: final say over the assembled view, before the guard. */
  select?: (view: HarnessUIMessage[], ctx: HarnessContext) => HarnessUIMessage[]
  /**
   * View-only pruning of old, large tool outputs before summarizing (spec 06 §5.0). Default off
   * (`undefined` or `false`); `{}` turns it on with the defaults. Stored messages never change.
   */
  prune?: PruneConfig | false
  /**
   * Thrash detection (spec 06 §4): when a second automatic (mid-turn or overflow) compaction
   * within `withinSteps` model steps of the previous one ran (or was skipped as no-gain) and the
   * context is still above `summarizeAt` afterwards, the turn stops with `'context-thrash'`.
   * Pre-turn compactions do not start the window. Default `{ withinSteps: 2 }`; `false`
   * keeps going (no thrash stop).
   */
  thrash?: { withinSteps?: number } | false
}

/**
 * Options of `compaction.prune` (spec 06 §5.0): old tool outputs are replaced by a short
 * placeholder in the request only. Errors and `execution-denied` results are never pruned; the
 * current turn is never pruned.
 *
 * @see docs/specs/06-compaction.md#50-prune
 */
export interface PruneConfig {
  /** Completed turns (newest first) whose tool outputs are never pruned. Default 2. */
  keepTurns?: number
  /** Only outputs whose projected size exceeds this many characters are pruned. Default 2_000. */
  minChars?: number
  /** Final tool names whose outputs are never pruned. */
  exclude?: string[]
  /**
   * Placeholder text (must be pure: same part → same text). Default `TOOL_OUTPUT_PRUNED`
   * (`[output of <tool> pruned: <n> chars]`). The text is used as a `{ type: 'text' }` output.
   */
  replaceWith?: (part: ToolResultPart) => string
}
