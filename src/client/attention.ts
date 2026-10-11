/**
 * `createAttentionList`: the approvals / questions inbox of the principal (`GET /attention`),
 * kept fresh by activity events. Answers are optimistic (the item leaves the list at once and
 * returns when the answer failed), refetches are debounced, and a generation guard keeps a list
 * fetched before a newer event from overwriting what that event applied.
 *
 * @see docs/specs/27-client.md#6-attention-list
 */
import type { ActivityRecord } from '../activity/index.ts'
import type { AnswerResponse, AttentionAnswerWire, AttentionItemWire } from '../http/index.ts'
import type { ActivityFeed } from './activity-feed.ts'
import { type Clock, systemClock } from './clock.ts'
import { type CallOptions, type HarnessClient, isHarnessHttpError } from './http-client.ts'
import { createStore, type Store } from './store.ts'

/** What the list needs of an item (the library's `AttentionItem` has more; apps may add fields). */
export interface AttentionKey {
  id: string
  sessionId: string
}

/** The observable state of an {@link AttentionList}. */
export interface AttentionState<Item extends AttentionKey = AttentionItemWire> {
  items: readonly Item[]
  /** The first list arrived. */
  loaded: boolean
  /** The last refresh failed (`null` after a success). */
  error: unknown
}

/** Options of {@link createAttentionList}. */
export interface AttentionListOptions<Item extends AttentionKey = AttentionItemWire> {
  client: HarnessClient
  /**
   * Where the list comes from. Default: `client.attention.list()` (`GET /attention`, whose items
   * carry the app's `attention.decorate` output as `extra`). An app with its own enriched view
   * passes it here and sets `Item` to the row type; rows need `id` and `sessionId` (and may carry
   * `rootSessionId`, used by `sessionId` scoping).
   */
  list?: (options?: CallOptions) => Promise<readonly Item[]>
  /**
   * Activity event types that refetch the list. Default {@link ATTENTION_EVENTS}; pass
   * `[...ATTENTION_EVENTS, 'task-changed']` to add app events.
   */
  events?: readonly string[]
  /** Debounce of event-triggered refetches (ms). Default 250. */
  debounceMs?: number
  /** Keep only the items of this session and of the sessions below it (`rootSessionId`). */
  sessionId?: string
  /** A refresh failed. */
  onError?: (error: unknown) => void
  clock?: Partial<Clock>
}

/** The attention inbox. */
export interface AttentionList<
  Item extends AttentionKey = AttentionItemWire,
  Answer = AttentionAnswerWire,
> extends Store<AttentionState<Item>> {
  /** Fetch the list now. */
  refresh(): Promise<void>
  /**
   * Answer an item. Optimistic: it leaves the list at once and returns on failure, except when it
   * was answered elsewhere (it stays gone). Rejects with the `HarnessHttpError`.
   */
  answer(item: Item, answer: Answer): Promise<AnswerResponse>
  /** Feed an activity record (debounced refetch for the events that change the list). */
  handleActivity(record: ActivityRecord): void
  /** The stream reconnected or missed events: refetch now. */
  handleResync(): void
  /** Wire this list to a feed (events and resyncs); returns the detach function. */
  attach(feed: ActivityFeed): () => void
}

/** The activity event types that refetch the list by default. */
export const ATTENTION_EVENTS: readonly string[] = [
  'pending-changed',
  'approval-decided',
  'attention-answered',
  'turn-ended',
  'session-recovered',
  'child-reported',
]

const same = (a: AttentionKey, b: AttentionKey): boolean =>
  a.id === b.id && a.sessionId === b.sessionId

/** Create the inbox of one principal. */
export function createAttentionList<
  Item extends AttentionKey = AttentionItemWire,
  Answer = AttentionAnswerWire,
>(options: AttentionListOptions<Item>): AttentionList<Item, Answer> {
  const { client } = options
  const listEvents = new Set(options.events ?? ATTENTION_EVENTS)
  const fetchItems = async (): Promise<readonly Item[]> =>
    options.list !== undefined
      ? await options.list()
      : ((await client.attention.list()).items as unknown as readonly Item[])
  const clock: Clock = { ...systemClock, ...options.clock }
  const debounce = options.debounceMs ?? 250
  const store = createStore<AttentionState<Item>>({ items: [], loaded: false, error: null })
  const scope = options.sessionId
  const visible = (items: readonly Item[]): Item[] =>
    scope === undefined
      ? [...items]
      : items.filter(
          (i) =>
            i.sessionId === scope || (i as { rootSessionId?: unknown }).rootSessionId === scope,
        )

  // A list fetched while a newer event arrived is stale: it must not overwrite what that event
  // applied. `gen` counts events; a fetch that saw a later event refetches, and only the newest
  // request may write.
  let gen = 0
  let req = 0
  let scheduled = false
  // items decided while a list is in flight: the response may still contain them
  let decided = new Set<string>()
  const keyOf = (i: { id: string; sessionId: string | null }): string =>
    `${i.sessionId}\u0000${i.id}`

  const later = (): void => {
    if (scheduled) return
    scheduled = true
    clock.setTimeout(() => {
      scheduled = false
      void refresh()
    }, debounce)
  }

  async function refresh(): Promise<void> {
    const atGen = gen
    const mine = ++req
    decided = new Set()
    try {
      const items = await fetchItems()
      if (mine !== req) return // a newer request writes
      const left =
        decided.size === 0
          ? items
          : items.filter(
              (i) => !decided.has(keyOf(i)) && !decided.has(keyOf({ id: i.id, sessionId: '*' })),
            )
      store.set({ items: visible(left), loaded: true, error: null })
      if (atGen !== gen) later()
    } catch (error) {
      if (mine !== req) return
      store.set({ ...store.get(), error })
      options.onError?.(error)
    }
  }

  const list: AttentionList<Item, Answer> = {
    subscribe: store.subscribe,
    get: store.get,
    refresh,

    async answer(item, answer) {
      const before = store.get().items
      const index = before.findIndex((x) => same(x, item))
      gen++
      decided.add(keyOf(item))
      store.set({ ...store.get(), items: before.filter((x) => !same(x, item)) })
      try {
        const response = await client.attention.answer<Answer>(item.id, {
          sessionId: item.sessionId,
          answer,
        })
        later()
        return response
      } catch (error) {
        // answered elsewhere (404 / 409): the item stays gone. Any other failure puts it back.
        const gone = isHarnessHttpError(error) && (error.isAlreadyAnswered || error.isNotFound)
        if (!gone) decided.delete(keyOf(item))
        if (!gone && index >= 0) {
          const now = store.get().items
          if (!now.some((x) => same(x, item))) {
            const restored = [...now]
            restored.splice(Math.min(index, restored.length), 0, item)
            store.set({ ...store.get(), items: restored })
          }
        }
        later() // the server is the truth: refetch
        throw error
      }
    },

    handleActivity(record) {
      if (!listEvents.has(record.type)) return
      gen++
      if (record.type === 'approval-decided' && typeof record.payload.id === 'string') {
        // decided by a person in any tab, a classifier or a remembered grant: the card goes at
        // once, never offered again; the refetch below confirms
        const id = record.payload.id
        decided.add(keyOf({ id, sessionId: record.sessionId ?? '*' }))
        const items = store
          .get()
          .items.filter(
            (i) =>
              !(i.id === id && (record.sessionId === null || i.sessionId === record.sessionId)),
          )
        if (items.length !== store.get().items.length) store.set({ ...store.get(), items })
      }
      later()
    },

    handleResync() {
      gen++
      void refresh()
    },

    attach(feed) {
      const offEvents = feed.subscribeEvents((r) => list.handleActivity(r))
      const offResync = feed.subscribeResync(() => list.handleResync())
      return () => {
        offEvents()
        offResync()
      }
    },
  }
  return list
}
