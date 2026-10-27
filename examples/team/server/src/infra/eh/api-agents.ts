/**
 * API agents on eharness (docs/plans/P56-developer-api.md): the model side of the Developer API.
 *
 * Isolation is by construction, not by rules in the prompt:
 *  - an API agent is built here, never by the team's `agent-factory`: no connectors, no channels,
 *    no memory of other agents, no programs, decisions, tasks or sub-agents. Its tools are the file
 *    tools over a scoped file system (`scopedFs`: only the granted folders exist for it) and,
 *    when the owner turned it on, `web_search`;
 *  - its sessions live in their own namespace (`api:<agentId>:...`), which no team route resolves;
 *  - one-shot runs use in-memory storage: nothing of the input or the answer is stored.
 *
 * Every model call is tagged with the API key that paid for it (`api_calls`); the workspace budget
 * still applies through the shared ledger scope. Calls also reach the Logs page (`activityLog`) with
 * model, tokens, cost and timing only: prompts and answers are never kept there.
 */
import type { Database } from 'bun:sqlite'
import {
  createUIMessageStreamResponse,
  type FileUIPart,
  jsonSchema,
  type LanguageModel,
  type UIMessageChunk,
} from 'ai'
import {
  defineHarnessAgent,
  definePlugin,
  type HarnessAgent,
  type HarnessSession,
  lookupModel,
  type MessageAdapter,
  type ModelCallEvent,
  type ModelCallRecord,
  type ModelCatalog,
  type SessionLock,
  type TurnResult,
  untrustedContent,
  uuidv7,
} from 'eharness'
import {
  type FileMeta,
  type FileSystem,
  type FileToolName,
  filesystem,
  type WriteResult,
} from 'eharness/filesystem'
import { inMemoryMessages, inMemoryState } from 'eharness/storage/memory'
import { webSearch } from 'eharness/web'
import type {
  ApiHistoryMessage,
  ApiMessageRequest,
  ApiRunRequest,
  ApiRuntime,
  ApiUsageStore,
  RunSummary,
} from '../../app/developer-api.ts'
import {
  type ApiAgent,
  type ApiConversation,
  apiInstructions,
  apiSessionId,
  contextBlock,
  isUnderFolder,
  mayRead,
  mayWrite,
} from '../../domain/developer-api.ts'
import { zodSchemaValidator } from '../json-schema.ts'
import type { ActivityLog } from './activity-log.ts'
import type { ModelConfig } from './provider.ts'
import { setBudgetLimit, sqliteBudgetLedger } from './storage.ts'

/** Steps one API turn may take (tools included). */
const MAX_STEPS = 12
/** Output cap of one model call: API answers are short, and it bounds the cost of one call. */
const MAX_OUTPUT_TOKENS = 8_192
const DEFAULT_WINDOW = 200_000
const READ_TOOLS: FileToolName[] = ['list_files', 'read_file', 'grep', 'glob']
const WRITE_TOOLS: FileToolName[] = ['write_file', 'edit_file']

class AccessDenied extends Error {}

/**
 * A file system that shows only what the agent was granted. Everything else reads as missing (an
 * agent cannot learn which paths exist), writes outside the write folder fail with a readable
 * message, and nothing can be deleted.
 */
export function scopedFs(
  base: FileSystem,
  agent: Pick<ApiAgent, 'readFolders' | 'writeFolder'>,
): FileSystem {
  const folders =
    agent.writeFolder === null ? agent.readFolders : [...agent.readFolders, agent.writeFolder]
  const denyWrite = (path: string): never => {
    throw new AccessDenied(
      agent.writeFolder === null
        ? `you cannot write files (${path}): this agent has read-only access.`
        : `you can only write inside ${agent.writeFolder} (${path} is outside it).`,
    )
  }
  return {
    async read(path) {
      return mayRead(agent, path) ? base.read(path) : null
    },
    async write(path, content, opts): Promise<WriteResult> {
      if (!mayWrite(agent, path)) return denyWrite(path)
      return base.write(path, content, opts)
    },
    async delete() {
      throw new AccessDenied('you cannot delete files.')
    },
    async list(prefix = '/') {
      const p = prefix.replace(/\/+$/, '')
      const out = new Map<string, FileMeta>()
      for (const f of folders) {
        let target: string | undefined
        if (p === '' || isUnderFolder(f, p)) target = `${f}/`
        else if (isUnderFolder(p, f)) target = prefix
        if (target === undefined) continue
        for (const m of await base.list(target)) if (mayRead(agent, m.path)) out.set(m.path, m)
      }
      return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    },
  }
}

export interface ApiRuntimeDeps {
  sqlite: Database
  models: ModelConfig
  catalog?: ModelCatalog | undefined
  /** The shared library file system (`libraryFs`). */
  library: FileSystem
  /** Stored messages and state of conversations (the factory's SQLite storage) and the turn lock. */
  storage: { messages: MessageAdapter; state: unknown }
  lock: SessionLock
  usage: ApiUsageStore
  /** The model call log of the Logs page; it gets metadata only (no prompt, no answer). */
  activityLog?: Pick<ActivityLog, 'record'>
  workspaceId: string
  /** Ledger scope of the workspace (`workspaceScope`). */
  workspaceScope: (workspaceId: string) => string
  /** The workspace default model pick. */
  settings: () => {
    defaultModel: string | null
    defaultProfile: string | null
    budgetUsd: number | null
  }
  now?: () => number
  tuning?: { modelMaxRetries?: number }
}

const textOf = (message: { parts: Array<{ type: string; text?: string }> } | undefined): string =>
  (message?.parts ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('')

/** A call without what was said: the Logs page shows API calls as metadata only. */
function withoutContent(e: ModelCallEvent): ModelCallRecord {
  const {
    kind: _k,
    sessionId: _s,
    turnId: _t,
    stepIndex: _i,
    messageId: _m,
    costUsd: _c,
    costSource: _cs,
    ...call
  } = e
  return {
    ...call,
    request: { options: null },
    response: {},
    output: { text: '', reasoning: '', toolCalls: [] },
  }
}

/** The text-only view of a UI message stream: no tools, reasoning, data parts or metadata. */
function publicStream(source: ReadableStream<UIMessageChunk>): ReadableStream<UIMessageChunk> {
  const reader = source.getReader()
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return controller.close()
        const chunk = value as UIMessageChunk & { messageMetadata?: unknown }
        switch (chunk.type) {
          case 'start':
          case 'finish': {
            const { messageMetadata: _m, ...rest } = chunk
            controller.enqueue(rest as UIMessageChunk)
            return
          }
          case 'start-step':
          case 'finish-step':
          case 'text-start':
          case 'text-delta':
          case 'text-end':
          case 'abort':
            controller.enqueue(chunk)
            return
          case 'error':
            controller.enqueue({
              type: 'error',
              errorText: 'The agent could not finish the request.',
            })
            return
          default:
            // tool calls, reasoning, sources, files, data parts, metadata: never leave the server
            continue
        }
      }
    },
    cancel: (reason) => reader.cancel(reason),
  })
}

export function createApiRuntime(deps: ApiRuntimeDeps): ApiRuntime & {
  /** Models of API agents resolve here (tests read the effective pick). */
  modelOf(agent: ApiAgent): LanguageModel
} {
  const now = deps.now ?? (() => Date.now())
  const ledger = sqliteBudgetLedger(deps.sqlite)
  setBudgetLimit(deps.sqlite, deps.workspaceScope(deps.workspaceId), deps.settings().budgetUsd)
  /** Cost the `model.call` hook already booked per request (the rest of a turn's cost is added at its end). */
  const booked = new Map<string, number>()

  const modelOf = (agent: ApiAgent): LanguageModel => {
    const s = deps.settings()
    return deps.models.resolve(
      agent.model ?? (agent.modelProfile === null ? s.defaultModel : null),
      agent.modelProfile ?? s.defaultProfile,
    )
  }

  const usagePlugin = (agent: ApiAgent) =>
    definePlugin({
      name: 'api-usage',
      setup: () => ({
        hooks: {
          'model.call': (ctx: { runtime: Record<string, unknown> }, e: ModelCallEvent): void => {
            deps.activityLog?.record(withoutContent(e), { ...e, agentId: agent.id })
            const keyId = ctx.runtime.apiKeyId
            const requestId = ctx.runtime.apiRequestId
            if (typeof keyId !== 'string' || typeof requestId !== 'string') return
            const cost = e.costUsd ?? 0
            booked.set(requestId, (booked.get(requestId) ?? 0) + cost)
            deps.usage.recordCall({
              id: e.id,
              at: now(),
              keyId,
              agentId: agent.id,
              requestId,
              model: e.model.modelId,
              inputTokens: e.usage.inputTokens ?? 0,
              outputTokens: e.usage.outputTokens ?? 0,
              costUsd: cost,
            })
          },
        },
      }),
    })

  function build(
    agent: ApiAgent,
    storage: { messages: MessageAdapter; state?: unknown },
  ): HarnessAgent {
    const model = modelOf(agent)
    const info = lookupModel(deps.catalog, model)
    const hasFiles = agent.readFolders.length > 0 || agent.writeFolder !== null
    const search = deps.models.search
    const plugins = [
      ...(hasFiles
        ? [
            filesystem({
              fs: scopedFs(deps.library, agent),
              tools: agent.writeFolder === null ? READ_TOOLS : [...READ_TOOLS, ...WRITE_TOOLS],
              // defence in depth: the scoped file system already hides everything else
              readonlyPrefixes: agent.readFolders,
              toolOutputs: false,
              toolMedia: false,
              onAdapterError: (error) =>
                error instanceof AccessDenied ? `ERROR: ${error.message}` : undefined,
            }),
          ]
        : []),
      ...(agent.webSearch && search !== undefined ? [webSearch({ search })] : []),
      usagePlugin(agent),
    ]
    return defineHarnessAgent({
      id: `api-${agent.id}`,
      model,
      contextWindow: info?.contextWindow ?? DEFAULT_WINDOW,
      ...(deps.catalog === undefined ? {} : { models: deps.catalog }),
      settings: {
        maxOutputTokens: Math.min(info?.maxOutputTokens ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
        ...(deps.tuning?.modelMaxRetries === undefined
          ? {}
          : { maxRetries: deps.tuning.modelMaxRetries }),
      },
      instructions: apiInstructions(agent),
      plugins,
      storage: storage as never,
      loop: { maxSteps: MAX_STEPS },
      budget: {
        ledger: {
          adapter: ledger,
          scopes: (ctx: { runtime: Record<string, unknown> }) => [
            deps.workspaceScope(String(ctx.runtime.workspaceId ?? deps.workspaceId)),
          ],
        },
      },
    } as never) as HarnessAgent
  }

  /** Conversation agents are built once per agent version (storage is shared and durable). */
  const cached = new Map<string, { version: number; agent: HarnessAgent }>()
  const conversationAgent = (agent: ApiAgent): HarnessAgent => {
    const hit = cached.get(agent.id)
    if (hit !== undefined && hit.version === agent.version) return hit.agent
    const built = build(agent, deps.storage as never)
    cached.set(agent.id, { version: agent.version, agent: built })
    return built
  }

  /** Book the part of a turn's cost no model call carried (a web search's own model). */
  const settleCost = (agent: ApiAgent, keyId: string, requestId: string, costUsd: number): void => {
    const seen = booked.get(requestId) ?? 0
    booked.delete(requestId)
    const extra = costUsd - seen
    if (extra > 1e-9) {
      deps.usage.recordCall({
        id: `${requestId}:extra`,
        at: now(),
        keyId,
        agentId: agent.id,
        requestId,
        model: 'extra',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: extra,
      })
    }
  }

  type Result = TurnResult
  const summaryOf = (result: Result): RunSummary => ({
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: result.usage.costUsd ?? 0,
    stop: result.stop,
    ...(result.error === undefined ? {} : { errorCode: result.error.code }),
  })

  /** A failure before the turn's commit point (busy, invalid input) reads as an error with a code. */
  const acceptedError = (e: {
    code: string
    message: string
    details?: Record<string, unknown> | undefined
  }): Error => Object.assign(new Error(e.message), { code: e.code, details: e.details })

  const turnRuntime = (req: { keyId: string; requestId: string }) => ({
    workspaceId: deps.workspaceId,
    apiKeyId: req.keyId,
    apiRequestId: req.requestId,
  })

  return {
    modelOf,

    async run(req: ApiRunRequest) {
      const { agent } = req
      const memory = inMemoryMessages()
      const sessionId = `api:${agent.id}:run-${uuidv7()}`
      const runAgent = build(agent, { messages: memory, state: inMemoryState() })
      // earlier turns of the caller's own transcript become history; the last message is the input
      const history = req.messages.slice(0, -1)
      if (history.length > 0) {
        await memory.save(
          sessionId,
          history.map((m) => ({
            id: uuidv7(),
            role: m.role,
            parts: [{ type: 'text' as const, text: m.content }],
          })) as never,
        )
      }
      const last = req.messages.at(-1)?.content ?? ''
      const ctxText = contextBlock(req.context)
      const text =
        ctxText === ''
          ? last
          : `${last}\n\n${untrustedContent(ctxText, { source: 'api-context', name: 'context' })}`
      // images ride on the input (the last user message) as data URLs; memory storage only
      const images = req.images ?? []
      const input =
        images.length === 0
          ? text
          : {
              text,
              files: images.map(
                (image): FileUIPart => ({
                  type: 'file',
                  mediaType: image.mediaType,
                  url: `data:${image.mediaType};base64,${image.data}`,
                }),
              ),
            }
      const session = runAgent.session(sessionId, {
        runtime: { workspaceId: deps.workspaceId },
      }) as HarnessSession
      try {
        const schema = req.outputSchema
        const sendOptions = {
          runtime: turnRuntime(req),
          ...(req.signal === undefined ? {} : { abortSignal: req.signal }),
          ...(schema === undefined
            ? {}
            : {
                output: {
                  schema: jsonSchema(schema, {
                    validate: (value: unknown) => {
                      const problems = zodSchemaValidator.validate(schema, value)
                      return problems.length === 0
                        ? { success: true as const, value }
                        : { success: false as const, error: new Error(problems.join('; ')) }
                    },
                  }),
                  maxRetries: 2,
                },
              }),
        }
        const run = session.send(input, sendOptions as never)
        const failed = await run.accepted
        if (failed !== undefined) throw acceptedError(failed)
        const result = await run.result
        settleCost(agent, req.keyId, req.requestId, result.usage.costUsd ?? 0)
        const text = textOf(result.messages.findLast((m) => m.role === 'assistant') as never)
        return {
          output: schema === undefined ? text : (result as { output?: unknown }).output,
          summary: summaryOf(result),
        }
      } finally {
        booked.delete(req.requestId)
        await session.close()
      }
    },

    async stream(req: ApiMessageRequest) {
      const session = open(req)
      const run = session.send(req.text, {
        runtime: turnRuntime(req),
        ...(req.signal === undefined ? {} : { abortSignal: req.signal }),
      })
      const failed = await run.accepted
      if (failed !== undefined) throw acceptedError(failed)
      const done = run.result.then((result) => {
        settleCost(req.agent, req.keyId, req.requestId, result.usage.costUsd ?? 0)
        return summaryOf(result)
      })
      const response = createUIMessageStreamResponse({
        stream: publicStream(run.stream as ReadableStream<UIMessageChunk>),
        headers: { 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' },
      })
      return { response, done }
    },

    async reply(req: ApiMessageRequest) {
      const session = open(req)
      const run = session.send(req.text, {
        runtime: turnRuntime(req),
        ...(req.signal === undefined ? {} : { abortSignal: req.signal }),
      })
      const failed = await run.accepted
      if (failed !== undefined) throw acceptedError(failed)
      const result = await run.result
      settleCost(req.agent, req.keyId, req.requestId, result.usage.costUsd ?? 0)
      return {
        text: textOf(result.messages.findLast((m) => m.role === 'assistant') as never),
        summary: summaryOf(result),
      }
    },

    async history(
      agent: ApiAgent,
      conversation: ApiConversation,
      page: { limit: number; before?: string | undefined },
    ) {
      const sessionId = apiSessionId(agent.id, conversation.id)
      // kind messages and tool-only steps are not part of the conversation the developer sees
      const loaded = await deps.storage.messages.load({
        sessionId,
        limit: page.limit + 1,
        ...(page.before === undefined ? {} : { beforeId: page.before }),
      })
      const visible = loaded.filter(
        (m) =>
          (m.role === 'user' || m.role === 'assistant') &&
          (m.metadata as { eharness?: { kind?: unknown } } | undefined)?.eharness?.kind ===
            undefined,
      )
      const hasMore = visible.length > page.limit
      const slice = hasMore ? visible.slice(visible.length - page.limit) : visible
      const messages: ApiHistoryMessage[] = slice
        .map((m) => ({
          id: m.id,
          role: m.role as 'user' | 'assistant',
          text: textOf(m as never),
          createdAt:
            (m.metadata as { eharness?: { createdAt?: number } } | undefined)?.eharness
              ?.createdAt ?? null,
        }))
        .filter((m) => m.text !== '')
      return { messages, ...(hasMore && slice[0] !== undefined ? { nextBefore: slice[0].id } : {}) }
    },

    purge(agent: ApiAgent, conversation: ApiConversation) {
      const id = apiSessionId(agent.id, conversation.id)
      for (const table of [
        'eh_messages',
        'eh_state',
        'eh_locks',
        'eh_inbox',
        'eh_stream_log',
        'eh_stream_chunks',
      ]) {
        deps.sqlite.query(`DELETE FROM ${table} WHERE session_id = ?`).run(id)
      }
    },
  }

  function open(req: ApiMessageRequest): HarnessSession {
    return conversationAgent(req.agent).session(apiSessionId(req.agent.id, req.conversation.id), {
      lock: deps.lock,
      runtime: { workspaceId: deps.workspaceId },
    }) as HarnessSession
  }
}
