/**
 * Public types, option shapes, constants and the data part of the `subagent()` plugin (spec 20).
 *
 * @see docs/specs/20-subagent-plugin.md
 */
import type { FlexibleSchema } from 'ai'
import { z } from 'zod/v4'
import {
  type DataPartDef,
  defineDataPart,
  type HarnessAgent,
  type HarnessContext,
  type HarnessRun,
  type HarnessSession,
  type SessionOptions,
} from '../index.ts'
import type { SubagentMessageLimits } from './messaging.ts'

/** Default name of the `agent` tool. */
export const AGENT_TOOL = 'agent'

/** Denial reason of a child approval under `approvals: 'policy'` with `policy: 'deny'`. */
export const SUBAGENT_NO_USER =
  'No user is available; this action is not allowed in autonomous mode.'

/** Error text of a client tool call the child cannot get answered (policy mode, no answer). */
export const SUBAGENT_NO_CLIENT =
  'No user is available to answer this call. Continue without it or choose another approach.'

/** Text of a bare denial from an `answer` callback. */
export const SUBAGENT_DENIED = 'Denied by the user.'

/** Identifies a child session the plugin is about to open (`subagent({ childSession })`). */
export interface SubagentChildInfo {
  parentSessionId: string
  /** Catalog key of the agent definition that runs the child. */
  agent: string
  /** Name the launcher gave the child, when known. */
  name?: string
  /** Nesting depth of the child (the root's children are 1). */
  depth: number
}

/** A file handed to a child: the `FileUIPart` fields the child's first message carries. */
export interface SubagentFile {
  /** A URL or reference the child's `inputFiles` accepts (protocol allowed, resolved for its model). */
  url: string
  mediaType: string
  filename?: string
}

/** The `files` argument of the `agent` tool (spec 20 §2.4). */
export interface SubagentFilesOptions {
  /**
   * Turn one reference the model passed (a path or `library:` ref as shown in the conversation)
   * into a file for the child, or refuse it with a readable `{ error }` (missing, too large,
   * unsupported type). A throw becomes an error text too; the call then fails without starting a
   * child.
   */
  resolve: (
    ref: string,
    ctx: { parentSessionId: string; agent: string; signal: AbortSignal },
  ) => Promise<SubagentFile | { error: string }> | SubagentFile | { error: string }
  /** Most files per call. Default 5. */
  max?: number
}

/** Default cap of the report injected into the parent when a background child finishes. */
export const AGENT_REPORT_MAX_CHARS = 16000

/** Inbox key prefix of the first turn of a durable background child (ADR-0046). */
export const BACKGROUND_KEY = 'subagent-bg:'

/** Plugin state key in the child session marking a durable background child. */
export const BACKGROUND_STATE = 'background'

/** Default name of the tool that reads a subagent's full final report. */
export const AGENT_OUTPUT_TOOL = 'agent_output'

/** Default page size of `agent_output`, in characters. */
export const AGENT_OUTPUT_PAGE_CHARS = 16000

// biome-ignore lint/suspicious/noExplicitAny: agents of different configs share one loose type
export type AnyAgent = HarnessAgent<any>
// biome-ignore lint/suspicious/noExplicitAny: a session of a loosely typed agent
export type AnySession = HarnessSession<any, any>
// biome-ignore lint/suspicious/noExplicitAny: a run of a loosely typed agent
export type AnyRun = HarnessRun<any>

/** One subagent type. */
export interface SubagentDefinition {
  /**
   * The agent that runs the child sessions. It must share storage with the parent's agent so the
   * parent / child index works across instances, and for `approvals: 'park'` it needs
   * {@link subagentChild} (or `subagent({ parentAgent })`) installed.
   */
  agent: AnyAgent
  /** One line shown to the model in the tool description. */
  description: string
  /** `maxSteps` of the child's turns. */
  maxTurns?: number
  /**
   * Whether a finished agent of this type can be resumed by `send_message` (a new turn on the same
   * child session, full history). Default `true`; set `false` for one-shot types such as read-only
   * search or plan agents (they can still receive messages while they run).
   *
   * @experimental Draft: may change in a minor release (docs/engineering/api-stability.md).
   */
  resumable?: boolean
}

/** Subagent types by name, or a function evaluated once per session. */
export type SubagentCatalog =
  | Record<string, SubagentDefinition>
  | (() => Record<string, SubagentDefinition>)

/** What the `answer` callback is asked (`approvals: 'inline'`). */
export type SubagentApprovalRequest =
  | {
      type: 'approval'
      /** Subagent type. */
      agent: string
      childSessionId: string
      approvalId: string
      toolCallId: string
      toolName: string
      input?: unknown
      risk?: string
    }
  | {
      type: 'client-tool'
      agent: string
      childSessionId: string
      toolCallId: string
      toolName: string
      input?: unknown
    }

/**
 * The answer: approve or deny an `'approval'` request, or give a `'client-tool'` request its
 * result. A mismatching shape denies / answers with an error.
 */
export type SubagentApprovalAnswer =
  | { approved: boolean; reason?: string; note?: string; remember?: 'once' | 'session' }
  | { output: unknown }
  | { errorText: string }

/** Options of {@link subagent}. */
export interface SubagentOptions {
  /** The subagent types. */
  agents: SubagentCatalog
  /** Name of the tool. Default `'agent'`. */
  toolName?: string
  /**
   * Nesting limit: the root session is depth 0; a session at `maxDepth` does not get the tool.
   * Default 2.
   */
  maxDepth?: number
  /** Children running at once, per nesting depth and plugin instance. Default 8. */
  maxConcurrent?: number
  /**
   * Cap of the children one session may start over its lifetime (counted per parent session,
   * `agent` calls only; resuming a child or messaging it is not a new child). Further `agent`
   * calls are refused with a readable error string and start nothing. In `'park'` mode with
   * `selfAgent`, the count is read from the stored child index (`children()`), so it holds across
   * instances and restarts; otherwise it counts the children this session object started.
   * Default: no cap. `maxConcurrent` limits only children running at once.
   */
  maxChildren?: number
  /**
   * Session options for every child session this plugin opens (foreground, background, park start,
   * resume, `agent_stop`/message delivery): `lock`, `runtime`, `storage`, `toolsContext`. The
   * `runtime` is merged under the plugin's own keys; `parent` cannot be set here. Runs on each open.
   */
  childSession?: (info: SubagentChildInfo) => Omit<SessionOptions, 'parent'> | undefined
  /**
   * Session options for the parent / root sessions this plugin opens from a child or to reconcile
   * (the same idea as `childSession`, for `parentAgent` / `selfAgent` opens).
   */
  parentSession?: (sessionId: string) => Omit<SessionOptions, 'parent'> | undefined
  /**
   * Offer `run_in_background`: the child runs detached and its report is injected into the parent
   * as an `eh.event` with `wake: true`. `true` offers the field in the root session, foreground
   * unless the model asks. Default `false`. With `approvals: 'park'` the child is started
   * **durably** (ADR-0046): its first turn goes through the child's durable inbox, the parent's
   * call is answered at once and the report arrives from whichever instance finishes the child.
   *
   * - `default`: an `agent` call that omits `run_in_background` runs in the background (Claude
   *   Code's interactive default); the model passes `run_in_background: false` when it needs the
   *   result before it can continue. Default `false`.
   * - `inChildren`: offer the field in CHILD sessions too. A child session is closed when its turn
   *   ends, which aborts the background subagents it started, and its report would go to a
   *   session nobody watches; so by default only the root session (and any session without a
   *   `parent`) gets the field. Enable it only when your child sessions stay open (spec 20 §2.2).
   *   Default `false`.
   */
  background?:
    | boolean
    | {
        default?: boolean
        inChildren?: boolean
        /**
         * `'park'` + `selfAgent`: a running background child older than this gets one
         * "timed out" report (spec 20 §3.6). Default 3 600 000 (1 hour);
         * `Number.POSITIVE_INFINITY` = unbounded.
         */
        timeoutMs?: number
        /** Also stop the child that timed out. Default true (a background child never runs unbounded). */
        stopOnTimeout?: boolean
        /** A child without a turn this long after its start is reported "failed to start". Default 90 000. */
        startGraceMs?: number
        /** One reminder when a child waits for a person this long (0 = never). Default 900 000. */
        waitingReminderMs?: number
        /**
         * Run `reconcileBackgroundChildren` every this many ms while the session is open; this timer
         * enforces `timeoutMs`. Default `min(60 000, timeoutMs / 4)` (at least 1 000) when the timeout
         * is finite; `0` = only at open.
         */
        reconcileEveryMs?: number
      }
  /**
   * How the child's approvals and client tool calls are answered: `'inline'` (the `answer`
   * callback, in process), `'park'` (the parent parks as an external wait, ADR-0035) or
   * `'policy'` (automatically, see `policy`).
   */
  approvals: 'inline' | 'park' | 'policy'
  /** Required for `'inline'`. */
  answer?: (
    request: SubagentApprovalRequest,
    signal: AbortSignal,
  ) => Promise<SubagentApprovalAnswer> | SubagentApprovalAnswer
  /** For `'policy'`: `'deny'` (default) or `'approve'` every child approval. */
  policy?: 'deny' | 'approve'
  /** Child session id. Default `<parentId>:agent:<toolCallId>`. */
  childSessionId?: (parentSessionId: string, toolCallId: string) => string
  /**
   * The agent that owns this plugin's sessions. With `'park'` and when set, `session.start`
   * reconciles the session's pending subagent waits in the background ({@link reconcileSubagentWaits}, children
   * opened on the catalog agents): a crash between a child finishing and its hook is healed when
   * the session opens. Best effort, never awaited by the open; failures are logged.
   */
  selfAgent?: () => AnyAgent
  /**
   * The messaging tool (`send_message` by default) and the `name` field of the `agent` tool. On by
   * default; `false` removes both. With `approvals: 'park'` messages travel over the durable inbox
   * (`child.enqueue`), names and the agent directory are rebuilt from storage (`selfAgent`),
   * and `parentAgent` resolves `main`. A session that has the plugin and no catalog still gets
   * `send_message`. ADR-0038, ADR-0041, spec 20 §5, §5.9.
   *
   * @experimental Draft: may change in a minor release (docs/engineering/api-stability.md).
   */
  messageTool?: boolean | { name?: string }
  /**
   * The report-reading tool (`agent_output` by default). Default: on when `background` or
   * `messageTool` is on; `false` removes it; `true` / an object forces it on. Spec 20 §5.6.
   */
  outputTool?: boolean | { name?: string }
  /**
   * The tool that stops a running agent (`agent_stop` by default). Same default and rules as
   * `outputTool`. Spec 20 §5.8.
   */
  stopTool?: boolean | { name?: string }
  /**
   * Cap of the report a finishing background agent injects into the parent, in characters
   * (default {@link AGENT_REPORT_MAX_CHARS}). A cut report says how to read the rest with
   * `agent_output`.
   */
  maxReportChars?: number
  /**
   * Offer a `files` argument on the `agent` tool: references the model passes on become file
   * parts of the child's first user message. Off unless set (spec 20 §2.4).
   */
  files?: SubagentFilesOptions
  /** Throttling of `send_message` (spec 20 §5.4). */
  messageLimits?: SubagentMessageLimits
  /** `'park'`: timeout of the parent's wait in ms. Default none. */
  parkTimeoutMs?: number
  /**
   * How the notice "this child waits for the user" (a parked durable background child) reaches its
   * parent. It never wakes an idle parent in either mode; the choice is about a parent that is
   * *running a turn* when the child parks:
   *
   * - `'step'` (default): the notice is delivered at the parent's next step boundary like any
   *   event, which gives the running turn one more model call that only reads the notice.
   * - `'notice'`: the notice is only stored (visible in the history and to UIs, `deliver:
   *   'next-turn'`); the model reads it with its next turn, which the child's final report wakes.
   *   Use it when an extra model call per approval is not wanted.
   *
   * The final report always wakes the parent. Must be set on the plugin of the **child's** agent
   * (`subagent({ parentAgent })` or {@link subagentChild}), because the child's `turn.end` hook
   * delivers the notice. Spec 20 §3.5.
   */
  onPark?: 'step' | 'notice'
  /**
   * The agent that owns the parent sessions, for the `turn.end` hook this plugin installs when the
   * agent is itself a child of a `'park'` parent (see {@link subagentChild}). A function, so two
   * agents can reference each other.
   */
  parentAgent?: () => AnyAgent
  /**
   * `'park'`: called with the continuation run a child's completion started on the parent
   * (`resolveWait()`); drive or stream it. Default: the run is drained, its result is stored.
   */
  onParentRun?: (run: AnyRun, parentSessionId: string) => void
}

/** Progress of a running child (preliminary tool output; UI only). */
export interface SubagentProgress {
  status: 'running' | 'completed' | 'failed' | 'stopped'
  agent: string
  description: string
  sessionId: string
  steps: number
  lastTool?: string
  text: string
}

/** Data of `data-subagent.run` (persisted; id = the tool call id): lets a UI open the transcript. */
export interface SubagentRunData {
  toolCallId: string
  sessionId: string
  agent: string
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'stopped'
  /** The `name` the model gave the agent (spec 20 §5). */
  name?: string
  /** Background task id (`agent-<n>`), when the agent has one (restores the id after a restart). */
  taskId?: string
  /** `'park'`: the child runs durably in the background (ADR-0046); its report arrives as an event. */
  background?: boolean
}

const runSchema: FlexibleSchema<SubagentRunData> = z.object({
  toolCallId: z.string(),
  sessionId: z.string(),
  agent: z.string(),
  status: z.enum(['running', 'waiting', 'completed', 'failed', 'stopped']),
  name: z.string().optional(),
  taskId: z.string().optional(),
  background: z.boolean().optional(),
}) as never

/** The data parts of the subagent plugin. */
export interface SubagentDataParts extends Record<string, DataPartDef> {
  run: DataPartDef<FlexibleSchema<SubagentRunData>>
}

export const runPart: DataPartDef<FlexibleSchema<SubagentRunData>> = defineDataPart({
  schema: runSchema,
})

export type Ctx = HarnessContext<SubagentDataParts>

export interface AgentInput {
  subagent_type: string
  description: string
  prompt: string
  files?: string[]
  run_in_background?: boolean
  name?: string
}
