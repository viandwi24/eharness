# Web client

`eharness/client` is the browser counterpart of [`eharness/http`](http-server.md): a typed client
for its routes, the AI SDK chat transport, the logic every chat UI needs around `useChat` / `Chat`
(history paging, re-attaching to a running turn, steering while busy, recovery after a dropped
connection or a restart), the activity feed and the approvals inbox. Contract:
[spec 27](../specs/27-client.md). It runs in the browser, Node and Bun; its only runtime import is
`ai`.

```ts
import { createHarnessClient } from 'eharness/client'

const client = createHarnessClient({
  baseUrl: '/api',
  headers: () => ({ authorization: `Bearer ${getToken()}` }), // resolved on every request
})
```

Stores (`session`, `feed`, `list`) follow the Svelte store contract (`subscribe` calls back
synchronously, `get()` returns a stable snapshot), so they work with `$store` in Svelte and with
`useSyncExternalStore` in React. The feed starts with its first subscriber and stops one second
after the last.

## Svelte

No Svelte-specific code ships; `Chat` from `@ai-sdk/svelte` is the chat object.

```svelte
<script lang="ts">
  import { onMount } from 'svelte'
  import { Chat } from '@ai-sdk/svelte'
  import { createActivityFeed, createAttentionList, createChatSession } from 'eharness/client'
  import { client } from './client'

  let { sessionId } = $props<{ sessionId: string }>()

  const session = createChatSession({
    client,
    sessionId,
    transportOptions: { ifBusy: 'steer' }, // the server must allow it in `chat.ifBusy`
    notify: (level, text) => toast(level, text),
  })
  const chat = new Chat({ ...session.chatInit }) // id, transport, onError, onData, onFinish
  session.bind(chat)

  // one feed for the app; the attention list reacts to its events
  const feed = createActivityFeed({
    client,
    isBusy: () => $session.busy, // ping /health while a turn runs: catches a killed server
    onEvent: (e) => {
      if (e.sessionId === sessionId && (e.type === 'turn-started' || e.type === 'message-saved')) {
        void session.followServerTurn()
      }
    },
    onResync: () => void session.refetch(), // reconnect, restart, missed events
  })
  const attention = createAttentionList({ client })
  attention.attach(feed)

  onMount(() => {
    void session.init() // history, then follow a running turn
    const stalled = setInterval(() => void session.checkStalled(), 4000)
    const stop = feed.subscribe(() => {}) // starts the feed
    return () => (clearInterval(stalled), stop())
  })
</script>

{#each chat.messages as message (message.id)}…{/each}
{#if $session.problem}
  <Banner onretry={() => session.retry()} ondismiss={() => session.dismissProblem()}>
    {$session.problem.message}
  </Banner>
{/if}
<form onsubmit={() => session.send(text)}>…</form>
<button onclick={() => session.stop()}>Stop</button>
{#each $attention.items as item (item.sessionId + item.id)}
  <button onclick={() => attention.answer(item, { kind: 'approval', approved: true })}>Allow</button>
{/each}
```

`session.send` steers the message into a running turn instead of starting another one;
`session.interrupted()` is true after a crashed turn (offer `continueTurn()` / `retryTurn()`);
`session.loadOlder()` pages up.

## React

React is passed in, so the package has no React peer dependency.

```tsx
import * as React from 'react'
import { useChat } from '@ai-sdk/react'
import { createReactBindings } from 'eharness/client/react'

export const { useStore, useActivityFeed, useAttention, useChatSession } = createReactBindings(React)
```

```tsx
function Chat({ sessionId }: { sessionId: string }) {
  const { session, state, chat } = useChatSession({ client, sessionId }, useChat)
  const { list, state: inbox } = useAttention({ client })
  useActivityFeed({
    client,
    isBusy: () => state.busy,
    onEvent: (e) => { if (e.type === 'pending-changed') list.handleActivity(e) },
    onResync: () => { void session.refetch(); list.handleResync() },
  })

  return (
    <>
      {chat.messages.map((m) => <Message key={m.id} message={m} />)}
      {state.problem && <Banner onRetry={() => session.retry()}>{state.problem.message}</Banner>}
      <Composer onSend={(text) => session.send(text)} onStop={() => session.stop()} />
      {inbox.items.map((item) => (
        <button key={item.sessionId + item.id}
          onClick={() => list.answer(item, { kind: 'approval', approved: true })}>
          Allow {item.toolName}
        </button>
      ))}
    </>
  )
}
```

`useChatSession(options, useChat)` creates the session per client and session id, calls
`useChat(session.chatInit)`, binds it through `chatBridgeOf` and runs `init()`. Callbacks passed to
`useActivityFeed` are always the latest (no stale closures). Call `session.checkStalled()` on an
interval while `state.busy` for the dead-connection check.

## What the client does for you

- **Sends** only the last message with an `Idempotency-Key`; a retried request whose turn still runs
  re-attaches to it instead of failing.
- **Reconnects** the feed with backoff and `Last-Event-ID`, falls back to polling, drops a silent
  connection, and notices a restarted server (new boot id) within about 5 s while busy; every
  reconnect asks you to refetch (`onResync`).
- **Recovers** a chat: a dropped connection after the reply began re-attaches (the server replays
  the turn from the start), a stale answer or duplicate refetches quietly, a busy `409` removes the
  optimistic message.
- **Answers** approvals optimistically and puts the card back only when the answer failed for a
  reason other than "answered elsewhere".

## Server requirements

CORS (headers to allow and expose) and proxy buffering are described in the
[HTTP server guide](http-server.md#cors). For `steer`, include `'steer'` in `chat.ifBusy`.
