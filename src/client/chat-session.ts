/**
 * `createChatSession`: the framework-neutral logic around an AI SDK chat of one eharness session:
 * history paging, re-attaching to a running turn (here or on another instance), retries, steering
 * while busy, stalled-connection detection, interrupted turns, error wording. It drives a
 * {@link ChatBridge} that `@ai-sdk/svelte` `Chat` satisfies structurally and `@ai-sdk/react`
 * `useChat` satisfies through `chatBridgeOf` (`eharness/client/react`).
 *
 * @see docs/specs/27-client.md#5-chat-session
 */
import type {
  ChatOnDataCallback,
  ChatOnErrorCallback,
  ChatOnFinishCallback,
  ChatStatus,
  ChatTransport,
  FileUIPart,
  UIMessage,
} from 'ai'
import type { MessagesPage } from '../http/index.ts'
import {
  type ChatProblem,
  CONTINUE_TEXT,
  describeChatError,
  interruptedTurn,
  mergeOlder,
  replaceTail,
} from './chat-helpers.ts'
import { sleep as defaultSleep } from './clock.ts'
import { type HarnessClient, isHarnessHttpError, isNetworkError } from './http-client.ts'
import { createStore, type Store } from './store.ts'
import { createHarnessTransport, type HarnessTransportOptions } from './transport.ts'

/** What the session needs from the chat object (`Chat` of `@ai-sdk/svelte` satisfies it). */
export interface ChatBridge<UI extends UIMessage = UIMessage> {
  /** Readable and writable (the session replaces the history with what is stored). */
  messages: UI[]
  readonly status: ChatStatus
  sendMessage(message: { text: string; files?: FileUIPart[] }): Promise<void>
  regenerate(options?: { messageId?: string }): Promise<void>
  resumeStream(): Promise<void>
  stop(): Promise<void>
  clearError(): void
}

/** Live state of the streamed turn (`data-eh.status`, transient). */
export type ChatActivity = 'thinking' | 'tool' | 'compacting' | null

/** The observable state of a {@link ChatSession}. */
export interface ChatSessionState {
  /** The first page of history was loaded. */
  loaded: boolean
  /** Older pages exist. */
  hasOlder: boolean
  loadingOlder: boolean
  /** Reattached to a running turn / following a steered one. */
  following: boolean
  /** Transient banner, e.g. "Sent to the running turn". */
  notice: string | null
  /** A failure of a turn this tab follows but did not start: show it inline (Retry when it helps). */
  problem: ChatProblem | null
  activity: ChatActivity
  /** A turn runs or is being followed in this chat. */
  busy: boolean
  /**
   * `stop()` could not reach the server (or has not been confirmed yet): the run may still be going
   * there. Stays `true`, and `busy` with it, until the server confirms the stop.
   */
  stopping: boolean
}

/** Options of {@link createChatSession}. */
export interface ChatSessionOptions<UI extends UIMessage = UIMessage> {
  client: HarnessClient
  sessionId: string
  /** Initial messages, when the caller already has them (`init()` then skips the first page). */
  messages?: UI[]
  /** Page size of the history reads. Default 50. */
  pageSize?: number
  /**
   * Ask the server to clip tool and data payloads over this many characters in every page read
   * (`?clip=`, 200..100000). `loadFull` fetches one message unclipped; see `isClippedPart`.
   */
  clip?: number
  /** Extra options of the default transport (`ifBusy`, `body`). Ignored when `transport` is given. */
  transportOptions?: Pick<HarnessTransportOptions, 'ifBusy' | 'body'>
  /** Your own transport (then a `202` is not noticed; prefer `transportOptions`). */
  transport?: ChatTransport<UI>
  /** Toasts. */
  notify?: (level: 'info' | 'error', text: string) => void
  /** Delay between `follow` retries (injectable for tests). */
  sleep?: (ms: number) => Promise<void>
}

/** What to spread into `new Chat({ ... })` / `useChat({ ... })`. */
export interface ChatInit<UI extends UIMessage = UIMessage> {
  id: string
  messages?: UI[]
  transport: ChatTransport<UI>
  onError: ChatOnErrorCallback
  onData: ChatOnDataCallback<UI>
  onFinish: ChatOnFinishCallback<UI>
}

/** The session logic around one chat. */
export interface ChatSession<UI extends UIMessage = UIMessage> extends Store<ChatSessionState> {
  readonly sessionId: string
  readonly chatInit: ChatInit<UI>
  /** Connect the chat object. Pass `undefined` to disconnect (unmount). */
  bind(chat: ChatBridge<UI> | undefined): void
  /** Load history, then reattach when a turn runs (here or on another instance). Idempotent. */
  init(): Promise<void>
  /** Attach to the running turn (replay then follow), then align with storage. */
  follow(): Promise<void>
  /** A turn this tab did not start: attach to its stream (checks a few times). */
  followServerTurn(): Promise<void>
  /** A message was stored by a turn this tab is not streaming: show it. */
  storedElsewhere(): Promise<void>
  /** Call every few seconds while the chat shows a running turn: drops a silently dead reader. */
  checkStalled(): Promise<void>
  /** Load the next older page; returns the number of messages added. */
  loadOlder(): Promise<number>
  /**
   * Fetch one message unclipped and replace it in `chat.messages` (same position). Returns the
   * message, or `undefined` when it could not be loaded. A later `refetch()` shows it clipped again.
   */
  loadFull(messageId: string): Promise<UI | undefined>
  /** Reload the newest page; older pages stay. */
  refetch(): Promise<void>
  /** Send a user message; while a turn runs it is steered into it. */
  send(text: string, files?: FileUIPart[]): Promise<void>
  /**
   * Interrupt the server turn (retried twice), then stop reading locally. When the server cannot
   * be reached it reports through `notify` and keeps `stopping` (and `busy`) until `checkStalled`
   * sees the turn end.
   */
  stop(): Promise<void>
  /** Send {@link CONTINUE_TEXT} after an interrupted turn. */
  continueTurn(): Promise<void>
  /** Regenerate the interrupted reply. */
  retryTurn(): Promise<void>
  /** The banner's Retry. */
  retry(): Promise<void>
  dismissProblem(): void
  /** The reply this chat ended on was cut short by a dead process. */
  interrupted(): boolean
  /** Recompute `busy` from the chat status (call when the chat status changed outside the session). */
  refreshBusy(): void
}

const NOTICE_STEERED = 'Sent to the running turn'
/** Interrupt requests `stop()` makes before it gives up (the first one and two retries). */
const STOP_ATTEMPTS = 3

/** Create the session logic of one eharness session. */
export function createChatSession<UI extends UIMessage = UIMessage>(
  options: ChatSessionOptions<UI>,
): ChatSession<UI> {
  const { client, sessionId } = options
  const pageSize = options.pageSize ?? 50
  const notify = options.notify ?? (() => {})
  const sleep = options.sleep ?? defaultSleep

  const store = createStore<ChatSessionState>({
    loaded: options.messages !== undefined,
    hasOlder: false,
    loadingOlder: false,
    following: false,
    notice: null,
    problem: null,
    activity: null,
    busy: false,
    stopping: false,
  })

  let chat: ChatBridge<UI> | undefined
  let nextBefore: string | undefined
  let netError: Error | null = null
  const lastNetError = (): Error | null => netError
  let queued = false
  let sending = false
  let initPromise: Promise<void> | undefined
  let idlePolls = 0
  /** A stored message was announced while a turn ran here: the stored view is behind (see `flushMissed`). */
  let missedStore = false

  const running = (): boolean => {
    const s = chat?.status
    return s === 'submitted' || s === 'streaming'
  }
  const busyNow = (): boolean =>
    store.get().following || sending || running() || store.get().stopping
  const patch = (changes: Partial<ChatSessionState>): void => {
    const next = { ...store.get(), ...changes }
    next.busy = next.following || sending || running() || next.stopping
    if (shallowEqual(next, store.get())) return
    store.set(next)
  }
  const refreshBusy = (): void => patch({})

  const transport =
    options.transport ??
    createHarnessTransport<UI>({
      client,
      sessionId: () => sessionId,
      ...(options.transportOptions ?? {}),
      onQueued: () => {
        queued = true
        patch({ notice: NOTICE_STEERED })
      },
    })

  const page = async (before?: string): Promise<MessagesPage | undefined> => {
    try {
      return await client.sessions.messages(sessionId, {
        limit: pageSize,
        ...(options.clip === undefined ? {} : { clip: options.clip }),
        ...(before === undefined ? {} : { before }),
      })
    } catch {
      return undefined
    }
  }
  const snapshot = async (): Promise<{ running: boolean; messageId?: string } | undefined> => {
    try {
      const s = await client.sessions.get(sessionId)
      const active = s.activeTurn ?? null
      return {
        running: s.running || active !== null,
        ...(active === null ? {} : { messageId: active.messageId }),
      }
    } catch {
      return undefined
    }
  }

  /**
   * A turn can continue an assistant message that is no longer the newest one (a `respond()`
   * continuation after event or input messages were stored behind it, or a recovered turn). AI SDK
   * `resumeStream()` only replaces the last message; any other id is pushed as a second copy (a
   * duplicate key in the UI). Move that message to the end while the turn streams; the refetch after
   * the turn restores the stored order.
   */
  const moveStreamingMessageLast = (messageId: string | undefined): void => {
    if (messageId === undefined || chat === undefined) return
    const messages = chat.messages
    const index = messages.findIndex((m) => m.id === messageId)
    if (index === -1 || index === messages.length - 1) return
    const message = messages[index] as UI
    if (message.role !== 'assistant') return
    chat.messages = [...messages.slice(0, index), ...messages.slice(index + 1), message]
  }

  const refetch = async (): Promise<void> => {
    missedStore = false
    const first = await page()
    if (first === undefined || chat === undefined) return
    const fetched = first.messages as UI[]
    const hasOlder = first.nextBefore !== undefined
    let tail = replaceTail(chat.messages, fetched, hasOlder)
    if (tail.check) {
      const older = await page(first.nextBefore)
      if (chat === undefined) return
      // when the older page cannot be read, fall back to appending the page (no gap handling)
      tail =
        older === undefined
          ? replaceTail(chat.messages, fetched)
          : replaceTail(chat.messages, fetched, hasOlder, older.messages as UI[])
    }
    chat.messages = tail.messages
    const state = store.get()
    if (tail.gap) {
      // more than a page was stored while away: "load older" fills the hole
      nextBefore = first.nextBefore
      patch({ hasOlder: true, notice: null })
    } else if (nextBefore === undefined && !state.hasOlder) {
      nextBefore = first.nextBefore
      patch({ hasOlder: first.nextBefore !== undefined, notice: null })
    } else patch({ notice: null })
  }

  /**
   * Messages stored while this tab streamed its own turn (kind messages such as events or notices,
   * the steps of the turn) were announced but not shown (`storedElsewhere` is skipped while busy), and
   * the optimistic user message still has the id AI SDK made up. When the turn is over, show what
   * is stored.
   */
  const flushMissed = async (): Promise<void> => {
    if (missedStore) await refetch()
  }

  /** The last `interruptOnce` failed in a way a retry cannot fix (not authorised). */
  let lastInterruptDefinitive = false
  /** One interrupt request; `true` when the server answered (or has no such session: nothing to stop). */
  const interruptOnce = async (): Promise<boolean> => {
    lastInterruptDefinitive = false
    try {
      await client.sessions.interrupt(sessionId)
      return true
    } catch (e) {
      if (isHarnessHttpError(e)) {
        if (e.status === 404) return true
        if (e.status === 401 || e.status === 403) lastInterruptDefinitive = true
      }
      return false
    }
  }

  const clearChatError = (): void => {
    if (chat !== undefined && chat.status === 'error') chat.clearError()
  }

  const follow = async (): Promise<void> => {
    if (store.get().following || chat === undefined) return
    patch({ following: true, problem: null })
    try {
      for (let attempt = 0; ; attempt++) {
        netError = null
        moveStreamingMessageLast((await snapshot())?.messageId)
        try {
          await chat.resumeStream()
        } catch (e) {
          onError(e as Error)
        }
        if (lastNetError() === null || attempt >= 3) break
        await sleep(400 * (attempt + 1))
      }
      const gaveUp = lastNetError()
      if (gaveUp !== null) {
        patch({ problem: describeChatError(gaveUp, true) })
        netError = null
      }
    } finally {
      patch({ following: false })
    }
    await refetch()
    // a failed resume leaves the chat in `error`: storage is the truth now, so go back to ready
    clearChatError()
    refreshBusy()
  }

  /**
   * `Chat` calls `onError` BEFORE it sets its status to `error`, so a clear inside the handler is a
   * no-op. Clear now (for bridges that already flipped) and again once the status has been set.
   */
  function clearAfterStatus(c: ChatBridge<UI>): void {
    c.clearError()
    queueMicrotask(() => {
      if (c.status === 'error') c.clearError()
      refreshBusy()
    })
  }

  function onError(e: Error): void {
    const c = chat
    if (c === undefined) return
    if (isHarnessHttpError(e) && (e.isAlreadyAnswered || e.isDuplicate)) {
      // answered elsewhere, or the message was stored already: show what is stored, nothing else
      clearAfterStatus(c)
      void refetch()
      return
    }
    if (isHarnessHttpError(e) && e.isBusy) {
      // the optimistic user message was never accepted: drop it and restore the stored view
      if (c.messages.at(-1)?.role === 'user') c.messages = c.messages.slice(0, -1)
      clearAfterStatus(c)
      notify('error', describeChatError(e, false)?.message ?? e.message)
      return
    }
    if (isNetworkError(e)) {
      if (store.get().following) {
        // `follow` retries quietly and shows the banner when it gives up
        netError = e
        clearAfterStatus(c)
        return
      }
      // the connection of a turn this tab started broke after the reply began: the turn runs on
      // the server, so re-attach (full replay) instead of leaving a half reply and an error
      if (c.messages.at(-1)?.role === 'assistant') {
        clearAfterStatus(c)
        void follow()
        return
      }
    }
    const problem = describeChatError(e, store.get().following)
    if (problem === null) {
      clearAfterStatus(c)
      void refetch()
    } else if (store.get().following) {
      // a turn the server started (a report, a routine, another tab): an inline banner
      patch({ problem })
      clearAfterStatus(c)
    } else {
      notify('error', problem.message)
    }
    refreshBusy()
  }

  const chatInit: ChatInit<UI> = {
    id: sessionId,
    ...(options.messages === undefined ? {} : { messages: options.messages }),
    transport,
    onError: (e) => onError(e),
    onData: (part) => {
      if (part.type !== 'data-eh.status') return
      const state = (part.data as { state?: string } | undefined)?.state
      patch({
        activity: state === 'thinking' || state === 'tool' || state === 'compacting' ? state : null,
      })
    },
    // after a respond() continuation ends, the stored message is the truth: refetch it
    onFinish: ({ message, isAbort, isError }) => {
      patch({ activity: null, ...(store.get().following ? {} : { notice: null }) })
      if (isAbort || isError) return
      if (message.role === 'assistant' && message.parts.some((p) => 'approval' in p)) {
        void refetch()
      }
    },
  }

  const steer = async (text: string, files: FileUIPart[]): Promise<void> => {
    const message = {
      id: crypto.randomUUID(),
      role: 'user',
      parts: [...files, { type: 'text', text }],
    } as UI
    try {
      const result = await client.sessions.send(sessionId, message, { ifBusy: 'steer' })
      if (result.kind === 'stream') {
        // 200: the server streams the running turn to this request as well; ours is already open
        void result.response.body?.cancel().catch(() => {})
      }
      patch({ notice: NOTICE_STEERED })
    } catch (e) {
      if (isNetworkError(e)) notify('error', 'Cannot reach the server')
      else notify('error', describeChatError(e, false)?.message ?? 'Request failed')
    }
  }

  const session: ChatSession<UI> = {
    sessionId,
    chatInit,
    subscribe: store.subscribe,
    get: store.get,
    refreshBusy,

    bind(next) {
      chat = next
      refreshBusy()
    },

    init() {
      initPromise ??= (async () => {
        if (!store.get().loaded) {
          const first = await page()
          if (first !== undefined && chat !== undefined) {
            chat.messages = replaceTail(chat.messages, first.messages as UI[]).messages
            nextBefore = first.nextBefore
            patch({ hasOlder: first.nextBefore !== undefined })
          } else if (first === undefined) notify('error', 'Could not load the conversation')
          patch({ loaded: true })
        }
        const snap = await snapshot()
        if (snap?.running === true) await follow()
      })()
      return initPromise
    },

    follow,
    refetch,

    async followServerTurn() {
      if (!store.get().loaded || busyNow()) return
      for (let i = 0; i < 4; i++) {
        const snap = await snapshot()
        if (busyNow()) return
        if (snap?.running === true) return follow()
        await sleep(250 * (i + 1))
      }
      await refetch() // it already ended: show what was stored
    },

    async storedElsewhere() {
      if (!store.get().loaded) return
      if (busyNow()) {
        missedStore = true
        return
      }
      await refetch()
    },

    async checkStalled() {
      if (store.get().stopping) {
        // a stop the server did not confirm: ask again until it says the turn is over
        const snap = await snapshot()
        if (snap === undefined) return // unreachable: keep waiting
        if (snap.running) {
          if (await interruptOnce()) patch({ stopping: false })
          return
        }
        patch({ stopping: false })
        await refetch()
        return
      }
      if (!busyNow()) {
        idlePolls = 0
        return
      }
      const snap = await snapshot()
      if (snap === undefined) return // the server is unreachable: keep waiting
      if (snap.running || !busyNow()) {
        idlePolls = 0
        return
      }
      if (++idlePolls < 2) return
      idlePolls = 0
      await chat?.stop()
      patch({ following: false })
      await refetch()
      clearChatError()
      refreshBusy()
    },

    async loadFull(messageId) {
      try {
        const full = (await client.sessions.message(sessionId, messageId)) as UI
        if (chat !== undefined) {
          const index = chat.messages.findIndex((m) => m.id === messageId)
          if (index !== -1) {
            chat.messages = [
              ...chat.messages.slice(0, index),
              full,
              ...chat.messages.slice(index + 1),
            ]
          }
        }
        return full
      } catch {
        notify('error', 'Could not load the full message')
        return undefined
      }
    },

    async loadOlder() {
      const state = store.get()
      if (state.loadingOlder || nextBefore === undefined || chat === undefined) return 0
      patch({ loadingOlder: true })
      try {
        const older = await page(nextBefore)
        if (older === undefined) {
          notify('error', 'Could not load older messages')
          return 0
        }
        const before = chat.messages.length
        chat.messages = mergeOlder(chat.messages, older.messages as UI[])
        nextBefore = older.nextBefore
        patch({ hasOlder: older.nextBefore !== undefined })
        return chat.messages.length - before
      } finally {
        patch({ loadingOlder: false })
      }
    },

    async send(text, files = []) {
      if (chat === undefined) return
      if (running()) return steer(text, files)
      queued = false
      sending = true
      refreshBusy()
      try {
        await chat.sendMessage(files.length > 0 ? { text, files } : { text })
      } finally {
        sending = false
        refreshBusy()
      }
      if (queued) {
        queued = false
        // the turn runs on another instance: follow its stream, then refetch the stored messages
        await follow()
      } else await flushMissed()
    },

    async stop() {
      patch({ stopping: true })
      let confirmed = false
      for (let attempt = 0; attempt < STOP_ATTEMPTS; attempt++) {
        if (attempt > 0) await sleep(300 * attempt)
        const outcome = await interruptOnce()
        if (outcome) {
          confirmed = true
          break
        }
        if (lastInterruptDefinitive) break // 401/403: retrying cannot help
      }
      // reading stops either way; the server turn may still run when the interrupt failed
      await chat?.stop()
      if (confirmed) {
        patch({ stopping: false })
        await flushMissed()
      } else {
        notify('error', 'Could not stop the run on the server; it may still be running.')
        refreshBusy()
      }
    },

    continueTurn: () => session.send(CONTINUE_TEXT),

    async retryTurn() {
      if (chat === undefined) return
      // the interrupted reply itself (not the recovery notice, which is a kind message of the same role)
      const last = interruptedTurn(chat.messages)
      if (last === undefined || busyNow()) return
      queued = false
      sending = true
      refreshBusy()
      try {
        await chat.regenerate({ messageId: last.id })
      } finally {
        sending = false
        refreshBusy()
      }
      if (queued) {
        queued = false
        await follow()
      } else await flushMissed()
    },

    async retry() {
      const retry = store.get().problem?.retry
      patch({ problem: null })
      if (retry === 'follow') await follow()
      else await refetch()
    },

    dismissProblem() {
      patch({ problem: null })
    },

    interrupted() {
      return chat !== undefined && interruptedTurn(chat.messages) !== undefined
    },
  }
  return session
}

function shallowEqual(a: ChatSessionState, b: ChatSessionState): boolean {
  for (const key of Object.keys(a) as (keyof ChatSessionState)[]) {
    if (!Object.is(a[key], b[key])) return false
  }
  return true
}
