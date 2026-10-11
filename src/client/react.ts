/**
 * `eharness/client/react`: React bindings by injection. There is no import of `react` here:
 * `createReactBindings(React)` takes the module, so the package has no React peer dependency.
 * `chatBridgeOf` adapts the result of `@ai-sdk/react` `useChat` to the {@link ChatBridge} of a
 * chat session.
 *
 * **Draft:** every symbol of this subpath is experimental and may change in a minor release
 * (docs/engineering/api-stability.md).
 *
 * @see docs/specs/27-client.md#7-react-eharnessclientreact
 */
import type { ChatStatus, FileUIPart, UIMessage } from 'ai'
import {
  type ActivityFeed,
  type ActivityFeedOptions,
  type ActivityFeedState,
  createActivityFeed,
} from './activity-feed.ts'
import {
  type AttentionList,
  type AttentionListOptions,
  type AttentionState,
  createAttentionList,
} from './attention.ts'
import {
  type ChatBridge,
  type ChatInit,
  type ChatSession,
  type ChatSessionOptions,
  type ChatSessionState,
  createChatSession,
} from './chat-session.ts'
import type { Store } from './store.ts'

/** The part of `React` the bindings use. */
export interface ReactLike {
  useSyncExternalStore<T>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ): T
  useEffect(effect: () => undefined | (() => void), deps?: readonly unknown[]): void
  useMemo<T>(factory: () => T, deps: readonly unknown[]): T
}

/** The part of the `useChat` result (`@ai-sdk/react`) the session needs. */
export interface UseChatResultLike<UI extends UIMessage = UIMessage> {
  messages: UI[]
  status: ChatStatus
  setMessages(messages: UI[] | ((messages: UI[]) => UI[])): void
  sendMessage(message: { text: string; files?: FileUIPart[] }): Promise<void>
  regenerate(options?: { messageId?: string }): Promise<void>
  resumeStream(): Promise<void>
  stop(): Promise<void>
  clearError(): void
}

/** `useChat` of `@ai-sdk/react`, as far as {@link ReactBindings.useChatSession} calls it. */
export type UseChatLike<UI extends UIMessage = UIMessage> = (
  init: ChatInit<UI>,
) => UseChatResultLike<UI>

/**
 * Adapt a `useChat` result to a {@link ChatBridge}. `get` returns the latest result (render after
 * render); a write to `messages` is visible to reads at once, before React re-renders.
 */
export function chatBridgeOf<UI extends UIMessage = UIMessage>(
  get: () => UseChatResultLike<UI>,
): ChatBridge<UI> {
  let seen: UseChatResultLike<UI> | undefined
  let shadow: UI[] | undefined
  const current = (): UseChatResultLike<UI> => {
    const result = get()
    if (result !== seen) {
      seen = result
      shadow = undefined // a new render caught up with our writes
    }
    return result
  }
  return {
    get messages() {
      const result = current()
      return shadow ?? result.messages
    },
    set messages(next: UI[]) {
      current()
      shadow = next
      get().setMessages(next)
    },
    get status() {
      return current().status
    },
    sendMessage: (message) => get().sendMessage(message),
    regenerate: (options) => get().regenerate(options),
    resumeStream: () => get().resumeStream(),
    stop: () => get().stop(),
    clearError: () => get().clearError(),
  }
}

/** The hooks {@link createReactBindings} returns. */
export interface ReactBindings {
  /** Subscribe a component to any store of this package. */
  useStore<T>(store: Store<T>): T
  /** The feed of `options.client` (created once per client; callbacks are always the latest). */
  useActivityFeed(options: ActivityFeedOptions): { state: ActivityFeedState; feed: ActivityFeed }
  /** The inbox of `options.client` (created once per client and scope). */
  useAttention(options: AttentionListOptions): { state: AttentionState; list: AttentionList }
  /**
   * A chat session around `useChat` (pass the hook from `@ai-sdk/react`): creates the session per
   * `client` and `sessionId`, calls `useChat(session.chatInit)`, binds it and runs `init()`.
   */
  useChatSession<UI extends UIMessage = UIMessage>(
    options: ChatSessionOptions<UI>,
    useChat: UseChatLike<UI>,
  ): { state: ChatSessionState; session: ChatSession<UI>; chat: UseChatResultLike<UI> }
}

/** Create the hooks for the `React` module of the app. */
export function createReactBindings(React: ReactLike): ReactBindings {
  function useStore<T>(store: Store<T>): T {
    return React.useSyncExternalStore(
      (onChange) => {
        let first = true
        return store.subscribe(() => {
          if (first)
            first = false // the synchronous initial call: React reads the snapshot itself
          else onChange()
        })
      },
      store.get,
      store.get,
    )
  }

  /** `options`, always the latest, behind a stable object. */
  function latest<T>(options: T): { current: T } {
    const holder = React.useMemo(() => ({ current: options }), [])
    holder.current = options
    return holder
  }

  return {
    useStore,

    useActivityFeed(options) {
      const ref = latest(options)
      const feed = React.useMemo(
        () =>
          createActivityFeed({
            ...options,
            onEvent: (r) => ref.current.onEvent?.(r),
            onResync: (reason) => ref.current.onResync?.(reason),
            onBoot: (id, restarted) => ref.current.onBoot?.(id, restarted),
            onError: (e) => ref.current.onError?.(e),
            isBusy: () => ref.current.isBusy?.() ?? false,
          }),
        [options.client],
      )
      return { state: useStore(feed), feed }
    },

    useAttention(options) {
      const ref = latest(options)
      const list = React.useMemo(
        () => createAttentionList({ ...options, onError: (e) => ref.current.onError?.(e) }),
        [options.client, options.sessionId],
      )
      React.useEffect(() => {
        void list.refresh()
        return undefined
      }, [list])
      return { state: useStore(list), list }
    },

    useChatSession<UI extends UIMessage>(
      options: ChatSessionOptions<UI>,
      useChat: UseChatLike<UI>,
    ) {
      const ref = latest(options)
      const session = React.useMemo(
        () =>
          createChatSession<UI>({
            ...options,
            notify: (level, text) => ref.current.notify?.(level, text),
          }),
        [options.client, options.sessionId],
      )
      const chat = useChat(session.chatInit)
      const holder = React.useMemo(() => ({ current: chat }), [session])
      holder.current = chat
      const bridge = React.useMemo(() => chatBridgeOf<UI>(() => holder.current), [holder])
      React.useEffect(() => {
        session.bind(bridge)
        void session.init()
        return () => session.bind(undefined)
      }, [session, bridge])
      return { state: useStore(session), session, chat }
    },
  }
}
