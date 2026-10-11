# Spec 27: Client module (`eharness/client`)

Status: **Draft (0.8)**. Module: `src/client/*` (+ `eharness/client/react`). Decision record:
ADR-0059. Browser counterpart of `eharness/http` (spec 26); lifted from the team example's web app
(SSE reader, liveness, chat bridge, optimistic approvals).

```ts
import {
  createHarnessClient, createHarnessTransport, createChatSession, createActivityFeed,
  createAttentionList, createStore, HarnessHttpError, isHarnessHttpError, isNetworkError,
} from 'eharness/client'
import { createReactBindings, chatBridgeOf } from 'eharness/client/react'
```

## 0. Rules

- **Runtime imports: only `ai`** (plus files of `src/client`). Everything from `eharness/http`,
  `eharness/activity` and the core is `import type`. `scripts/check-imports.ts` rejects any other
  import (a statement-level `import type` is required; `import { type X }` is not enough because
  `verbatimModuleSyntax` keeps a side-effect import) and `scripts/check-client-bundle.ts`
  (part of `check:package`) asserts that `dist/client/*.js` and the chunks they reach import only
  `ai` and are not shared with other modules.
- Build on AI SDK primitives (ADR-0001): `DefaultChatTransport`, `ChatTransport`, `ChatInit`,
  `UIMessage`. The chat object is the app's (`@ai-sdk/svelte` `Chat`, `@ai-sdk/react` `useChat`);
  the module never implements a chat of its own.
- Web APIs only (`fetch`, `ReadableStream`, `TextDecoder`, `AbortController`, `crypto`). No DOM
  access, no `EventSource`, no `localStorage`.
- Errors of the server are `HarnessHttpError`; everything else (a dropped connection) is the
  platform's `TypeError`. Nothing in the module throws for an expected failure of a background
  refetch; it reports through callbacks and state.

## 1. Stores

```ts
interface Store<T> { subscribe(run: (value: T) => void): () => void; get(): T }
interface WritableStore<T> extends Store<T> { set(value: T): void; update(fn: (v: T) => T): void }
createStore<T>(initial: T, lifecycle?: { onActive?; onIdle?; graceMs?; timers? }): WritableStore<T>
```

- `subscribe` calls `run` **synchronously** with the current value, then on every change; it
  returns the unsubscribe (idempotent). This is the Svelte store contract (`$store`) and, with
  `get()`, what `useSyncExternalStore` needs.
- `get()` returns an **immutable, referentially stable** snapshot: the same object until the state
  changes. Objects and the arrays directly inside them are frozen. Setting the same value
  (`Object.is`) does not notify.
- A store with a lifecycle (the feed) starts work when the first subscriber arrives and stops
  `graceMs` (default 1000) after the last one left; a subscriber inside the grace period keeps it
  running.

## 2. `createHarnessClient`

```ts
createHarnessClient({ baseUrl, fetch?, headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>), credentials? }): HarnessClient
interface HarnessClient {
  baseUrl: string; url(path, query?): string; request(url, init?): Promise<Response>  // raw, no error mapping
  health(opts?): Promise<HealthResponse>
  sessions: { list, get, messages(id, { before?, limit? }), interrupt(id, reason?), send(id, message, { ifBusy?, idempotencyKey? }) }
  attention: { list(), answer(id, { sessionId, answer }) }
  activity: { page({ after?, limit? }) }
}
```

Every method except `request` rejects with `HarnessHttpError` for a non-2xx answer. `headers` is
resolved on every request (a token that rotates). `request` merges the client headers under the
per-request headers and applies `credentials`. `sessions.send` is the chat POST without a chat
framework: `{ kind: 'stream', response }` (`200`, the caller reads or cancels the body) or `{ kind:
'queued', queued }` (`202`); it sends `Idempotency-Key` (the message id when it is a valid key).

```ts
class HarnessHttpError extends Error {
  status: number; code: string; details?: Record<string, unknown>
  isAlreadyAnswered  // EH_HTTP_ALREADY_ANSWERED
  isBusy             // EH_SESSION_BUSY | EH_SESSION_CLOSED
  isDuplicate        // EH_HTTP_DUPLICATE_REQUEST
  isNotFound         // status 404
}
isHarnessHttpError(e, code?): e is HarnessHttpError
isNetworkError(e): boolean  // a dropped connection (TypeError, "failed to fetch", socket...), not an abort and not a server error
```

An answer that is not the documented `{ error }` body becomes `code: 'HTTP_<status>'`.

## 3. Chat transport

```ts
createHarnessTransport<UI>({ client, sessionId?: (chatId) => string, ifBusy?, body?, onQueued? }): ChatTransport<UI>
```

A `DefaultChatTransport` with these changes:

1. **Last message only**: the body is `{ id: sessionId, messages: [last], trigger, messageId?, ...body }`
   (the server reads nothing else, spec 26 §5.2). The URL is `/sessions/:id/chat[?ifBusy=]`.
2. **`Idempotency-Key: last.id`** when the id is a valid key (`[A-Za-z0-9_.:-]{1,128}`).
3. **`202`** (a steer into a turn of another instance): `onQueued(queued)` and a valid, empty UI
   message stream (`[DONE]` only), so the chat finishes cleanly.
4. **Non-OK** answers throw `HarnessHttpError` (not the AI SDK's generic error).
5. **`409 EH_HTTP_DUPLICATE_REQUEST` with `details.active: true`** (a retried request whose turn
   still runs) is answered by resuming that turn: the transport fetches `…/chat/stream` and returns
   its stream (an empty stream on `204`). A duplicate that is no longer active throws.
6. **Resume** goes to `/sessions/:id/chat/stream` and `resumeStreamIsReplay` is `true`: the
   server replays from chunk 0 and the AI SDK resets the message. The cursor `from` stays
   server-side.
7. `sessionId` maps the chat id to the session id (a chat id of `agent-1` can be the session
   `dm:agent-1`); the default is the identity. Headers and credentials come from the client.

## 4. Activity feed

```ts
createActivityFeed({ client, onEvent?, onResync?(reason), onBoot?(id, restarted), onError?, initialAfter?, isBusy?, backoff?, idleMs?, tickMs?, clock? }): ActivityFeed
interface ActivityFeed extends Store<{ status: 'idle'|'connecting'|'live'|'polling'|'stopped'; lastSeq: number | null; boot: string | null }> {
  start(); stop(); check(): Promise<void>
  subscribeEvents(fn): () => void; subscribeResync(fn): () => void
}
type ResyncReason = 'connect' | 'resync-event' | 'boot-changed' | 'poll-gap'
```

- **Transport**: one `fetch` reader of `GET /activity/stream` (not `EventSource`: it cannot send
  headers). Frames are parsed by `createSseParser` (CRLF, split chunks, multi-line data).
  Reconnects send `?after=<lastSeq>` and `Last-Event-ID`.
- **Dedupe**: a record with `seq <= lastSeq` is dropped (replay overlap). A `resync` frame sets
  `lastSeq` to the server's mark (also when it is lower: the log was reset) and reports
  `'resync-event'`.
- **Resync**: `onResync('connect')` runs whenever a stream (re)opens: state may have changed
  while it was down, so apps refetch. `'boot-changed'` replaces `'connect'` for the reconnect that
  a changed boot id triggered; `'poll-gap'` is a polled page flagged `resync`.
- **Boot**: the `boot` event and `GET /health` carry the server's boot id; `onBoot(id, restarted)`
  runs the first time and on every change.
- **Liveness**: no bytes (not even the 15 s keep-alive) for `idleMs` (default 20 s) drops the
  connection. Every second the feed checks `shouldPing`: while `isBusy()` is true it pings
  `/health` about every 5 s (and always when the stream is stale). A failed ping on a live stream,
  or a changed boot id, reconnects at once without waiting out the backoff. `check()` pings now
  (tab focus, network back).
- **Polling fallback**: while the stream is down the feed polls `GET /activity?after=&limit=200`
  between backoff pauses (default 250 ms growing to 5 s, jittered down by at most half). The first
  poll without a cursor pages to the head **without delivering** (history is not news).
- **Lifecycle**: starts with the first subscriber, stops one second after the last, or use
  `start()` / `stop()` (an explicit `start()` is not stopped by the subscribers leaving).
  A listener that throws is isolated (`onError`); it never drops the connection.
- `clock` (`now`, `random`, timers, `sleep`) is injectable for tests.

Pure helpers: `createSseParser`, `createLiveness`, `backoffDelay`, `parseActivityEvent`.

## 5. Chat session

```ts
createChatSession<UI>({ client, sessionId, messages?, pageSize?, transportOptions?, transport?, notify?, sleep? }): ChatSession<UI>
interface ChatSession<UI> extends Store<ChatSessionState> {
  chatInit: { id, messages?, transport, onError, onData, onFinish }   // spread into new Chat({...}) / useChat({...})
  bind(chat: ChatBridge<UI> | undefined)
  init(); follow(); followServerTurn(); storedElsewhere(); checkStalled(); loadOlder(); refetch()
  send(text, files?); stop(); continueTurn(); retryTurn(); retry(); dismissProblem(); interrupted(); refreshBusy()
}
interface ChatSessionState { loaded; hasOlder; loadingOlder; following; notice; problem; activity; busy }
interface ChatBridge<UI> { messages: UI[]; readonly status: ChatStatus; sendMessage({ text, files? }); regenerate({ messageId? }); resumeStream(); stop(); clearError() }
```

`ChatBridge` is what `@ai-sdk/svelte` `Chat` (an `AbstractChat`) satisfies structurally;
`@ai-sdk/react` `useChat` goes through `chatBridgeOf` (§7). The session never owns the messages: it
reads and writes `chat.messages`.

- **`init()`** (idempotent): load the newest page unless `messages` were given, then, when the
  session snapshot says a turn runs (`running` or `activeTurn`), `follow()`.
- **`follow()`**: `chat.resumeStream()` (replay then follow, also for a turn of another instance),
  retried quietly on a dropped connection (400 ms × attempt, three retries); when the retries run
  out `problem` is "Cannot reach the server" with `retry: 'follow'`. Then `refetch()` (storage is
  the truth) and a chat left in `error` is cleared.
- **`send`**: while a turn runs (status `submitted` / `streaming`) the message is **steered**
  (`sessions.send(..., { ifBusy: 'steer' })`; `notice` = "Sent to the running turn"); otherwise
  `chat.sendMessage`. A `202` from the transport (turn on another instance) then `follow()`s. The
  server must allow `steer` in `chat.ifBusy`.
- **Errors** (`chatInit.onError`): `ALREADY_ANSWERED` / `DUPLICATE_REQUEST` refetch quietly; a busy
  `409` drops the optimistic user message and notifies; a network error while following is retried
  by `follow`, after the reply began it re-attaches; others go through `describeChatError(e,
  serverTurn)`: a toast (`notify('error', ...)`) for a message the person sent, `problem` (inline,
  with Retry when it helps) for a turn the server started.
- **`checkStalled()`**: call every few seconds while the chat shows a running turn; when the server
  says no turn runs for two checks in a row, the reader is stopped, the stored messages are shown
  (a crashed turn appears as `interrupted`). An unreachable server keeps the reader.
- **`followServerTurn()`**: a turn this tab did not start (an event announced it): checks up to
  four times whether it is readable, follows it, else refetches. **`storedElsewhere()`**: refetch
  when idle.
- **`onFinish`**: a continuation (an assistant message with approval parts) refetches the stored
  message. **`onData`** tracks `data-eh.status` into `activity`.
- **Paging**: `loadOlder()` merges an older page (`mergeOlder` drops ids already present);
  `refetch()` replaces only the newest page (`replaceTail`, ids sort by creation time).
- **`stop()`**: `sessions.interrupt` then `chat.stop()`. **Interrupted turns**: `interrupted()` is
  true when the conversation ends with an assistant message of stop `interrupted` (kind messages
  do not count); `continueTurn()` sends `CONTINUE_TEXT`, `retryTurn()` regenerates that reply.
- `busy` = following, or a send in flight, or a running chat status; call `refreshBusy()` when the
  chat status changed outside the session.
- `transportOptions` (`ifBusy`, `body`) configure the default transport; with an own `transport`
  a `202` is not noticed.

Svelte recipe: `const session = createChatSession({ client, sessionId }); const chat = new Chat({
...session.chatInit }); session.bind(chat); session.init()`.

## 6. Attention list

```ts
createAttentionList({ client, debounceMs?, sessionId?, onError?, clock? }): AttentionList
interface AttentionList extends Store<{ items: readonly AttentionItem[]; loaded: boolean; error: unknown }> {
  refresh(); answer(item, answer: AttentionAnswerWire): Promise<AnswerResponse>
  handleActivity(record); handleResync(); attach(feed): () => void
}
```

- `refresh()` reads `GET /attention`. A **generation guard** keeps a list fetched before a newer
  event from winning: only the newest request writes, a response that saw a later event schedules a
  refetch, and an item decided while a request was in flight is filtered from its response.
- `answer(item, answer)` is **optimistic**: the item leaves at once, `POST /attention/:id/answer`
  carries `item.sessionId`, and a refetch is debounced after it (`debounceMs`, default 250). On
  failure the item returns at its place, except when it was answered elsewhere (`409
  EH_HTTP_ALREADY_ANSWERED` or `404`): it stays gone. The error is rethrown. A `200` with status
  `already-answered` is a result.
- `handleActivity` reacts to `pending-changed`, `approval-decided` (removes the card at once),
  `attention-answered`, `turn-ended`, `session-recovered` and `child-reported` with one debounced
  refetch; `handleResync` refetches now. `attach(feed)` wires both to a feed.
- `sessionId` keeps the items of that session and of the sessions below it (`rootSessionId`).

## 7. React (`eharness/client/react`)

No import of `react`: `createReactBindings(React)` takes the module (`useSyncExternalStore`,
`useEffect`, `useMemo`), so there is no peer dependency.

```ts
const { useStore, useActivityFeed, useAttention, useChatSession } = createReactBindings(React)
useStore(store)                                  // useSyncExternalStore over any Store
useActivityFeed({ client, onEvent, onResync })   // { state, feed }: one feed per client, latest callbacks
useAttention({ client, sessionId? })             // { state, list }: refreshes on mount
useChatSession({ client, sessionId }, useChat)   // { state, session, chat }
chatBridgeOf(() => useChatResult): ChatBridge
```

`useChatSession` calls the `useChat` hook you pass (`@ai-sdk/react`) with `session.chatInit`, binds
a bridge on mount and runs `init()`. `chatBridgeOf` reads the latest `useChat` result and shows its
own writes to `messages` at once (React would show them after the next render).

## 8. Out of scope

Uploads, compaction, tool lists and stats stay app routes; the client has no route for them. A
Svelte subpath is not shipped (the recipe above is the integration). `EventSource` is not used.
