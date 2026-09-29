# Approvals and interaction

Everything a user does to a session besides "send a message": approve tool calls, answer
client-side tools, regenerate or edit, talk to the agent while it works, and wake it from
background work. All of it works over `useChat`'s protocol through `handleChatRequest`, and keeps
one invariant: **stored history is exactly what the model saw, in that order**. Contract: spec 11.
Runnable round trip: [`examples/next-route.demo.ts`](../../examples/next-route.demo.ts).

## Tool approval

```ts
import { defineHarnessAgent } from 'eharness'

const agent = defineHarnessAgent({
  model,
  approval: {
    policy: {
      delete_file: 'user-approval', // always ask
      write_file: (input: { path: string }) =>
        input.path.startsWith('/config/') ? 'user-approval' : 'approved',
    },
    secret: process.env.APPROVAL_SECRET, // optional: HMAC-signs approval requests
    onNewInput: 'deny', // default: a new message denies what is still pending
  },
})
```

The policy has AI SDK's `ToolApprovalConfiguration` shape (per-tool map or one function). Plugins
add `tool.approve` hooks; the core combines policy, hooks and session grants with **most
restrictive wins** (`denied` > `user-approval` > `approved`), and a throwing hook denies.

Two rules, because AI SDK re-validates approved calls when the conversation continues:

- **`tool.before` hooks must be deterministic** (same input → same result), otherwise the approved
  call is rejected as invalid input and never executed.
- **Policies and `tool.approve` hooks must be side-effect free**: they run again for approved
  calls.

## When a call needs approval

The turn ends with `stop: 'tool-pending'`. The assistant message keeps the tool part in state
`approval-requested`; `run.result.pending`, `session.stats()` and the `pending` session event
name the waiting calls. Nothing runs until someone answers.

**In a web app** nothing extra is needed on the server: `useChat` sends the answers and
`handleChatRequest` calls `respond()`.

```tsx
const { messages, addToolApprovalResponse } = useChat<ChatMessage>({
  transport: new DefaultChatTransport({ api: '/api/chat' }),
  sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
})
// on a part with part.state === 'approval-requested':
addToolApprovalResponse({ id: part.approval.id, approved: true })
```

**Server-side** (a Slack button, a CLI prompt):

```ts
const run = session.respond({
  approvals: [{ id: 'approval-id', approved: false, reason: 'Not in production', remember: 'session' }],
})
const result = await run.result
if (result.stop === 'error') console.log(result.error?.details?.reason) // 'unknown-id' | 'incomplete' | 'stale'
```

- `respond()` **continues the same assistant message**: approved tools run first, denials are
  reported, then the model continues. The UI message id does not change.
- Every pending approval (and client tool) must be answered in one call; the answers are checked
  against server-side pending state and consumed atomically, so a replayed or stale request never
  runs a tool.
- `remember: 'session'` records a grant (`always` / `never` for that tool name) for the rest of the
  session; `session.clearGrants()` forgets them.
- Exactly-once across **several server instances** needs a `SessionLock` or a `StateAdapter` with
  `setIf` ([storage guide](writing-a-storage-adapter.md)); within one process it is guaranteed.
- Check who may approve (auth) in your route before calling `respond()` / `handleChatRequest`.

**What the model sees after a denial.** In the continuation's first step AI SDK sends the denial as
`execution-denied` with your reason. In later turns the stored `output-denied` part is projected
as a tool error result carrying the same reason. The model gets the same information, but the
two encodings differ, so the prompt cache misses once after a denial. This is expected.

## Client-side tools

A tool without `execute` runs on the client. The turn stops with `tool-pending` until its output
arrives:

```tsx
const { messages, addToolOutput } = useChat<ChatMessage>({
  sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  onToolCall: ({ toolCall }) => {
    if (toolCall.toolName === 'get_location') {
      addToolOutput({ tool: 'get_location', toolCallId: toolCall.toolCallId, output: 'Oslo' })
    }
  },
})
```

Server-side: `session.respond({ toolOutputs: [{ toolCallId, output }] })` (or `errorText`). Client
outputs pass `tool.after` hooks and output limits like server outputs.

## New input while something is pending

With `onNewInput: 'deny'` (default) a new `send()` / `regenerate()` / `edit()` first answers the
pending calls as denied (reason text in `DENIED_NEW_INPUT`) and then runs; the model sees the
denials followed by the new message. With `'reject'` the run fails with `EH_PENDING_RESPONSE`.

## Regenerate and edit

```ts
session.regenerate() // answer the last user message again
session.edit(userMessageId, 'Actually, use metric units') // replace a user message and answer it
```

`useChat`'s `regenerate()` and editing a message (`sendMessage({ text, messageId })`) reach the
same operations through `handleChatRequest`. Old messages are not deleted: an `eh.rewind` marker
hides them from the model and from `session.messages()` (pass `{ includeHidden: true }` to see
them). Plugin state and external side effects (files written, APIs called) are not rolled back.

## Talking to a running agent

```ts
session.send('Also check the tests', { ifBusy: 'steer' }) // delivered at the next step boundary
session.send('Then write docs', { ifBusy: 'queue' }) // runs as its own turn afterwards
```

- **Steer:** the text is stored as a `data-eh.input` part inside the running assistant message,
  exactly where the model saw it, and the turn continues even if the model was about to finish.
  If the turn stops first with `tool-pending` or `aborted`, the input is not used and an
  `input-dropped` event lets the UI put the text back into the input box.
- **Queue:** FIFO per session and process; queued turns wait while approvals are pending.
- In a route: `handleChatRequest(session, body, { ifBusy: 'steer' })`.
- `session.abort()` stops the running turn (partial output is saved with `stop: 'aborted'`) and
  drops queued turns.

## Background events and wake-ups

```ts
await session.inject('eh.event', { name: 'ci.finished', text: 'CI is green on main.' })
// → stored now, the model sees it at the next turn

await session.inject('eh.event', { name: 'ci.failed', text: 'CI failed.' }, { wake: true })
// → idle: starts a turn now; running: delivered into the running turn at the next step
```

Custom kinds (`defineMessageKind`) work the same way. A wake is never lost: if it cannot be
delivered inline, a turn is queued (and waits for pending approvals).

## Reconnecting

`session.attach()` replays the running turn's stream from its first chunk and follows it (the
`GET` route in the Next.js example; `useChat({ resume: true })`). A `respond()` continuation
buffers only the continuation, so a client that resumes it should re-fetch the message with
`session.messages()` when the `turn-end` event arrives.
