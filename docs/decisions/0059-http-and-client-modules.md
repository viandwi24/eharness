# ADR-0059: `eharness/http` and `eharness/client`: the HTTP surface and its browser counterpart

Status: **Accepted** · Date: 2026-10-11 · Builds on: [ADR-0001](0001-build-on-ai-sdk-primitives.md), [ADR-0008](0008-plugins-adapters-dogfooding.md), [ADR-0012](0012-approvals-server-owned-pending.md), [ADR-0039](0039-resumable-streams-stream-log.md), [ADR-0058](0058-activity-feed-and-attention-queue.md)

The `eharness/http` part is implemented in this release. The `eharness/client` part (spec 27) lands
in the same release; its decisions are recorded here so the two modules stay one design.

## Context

Every harness server wrote the same routes around `handleChatRequest`: authenticate, pick a session,
whitelist the body, answer a stale approval with a 409, steer into a busy turn, resume a stream,
abort, page messages, tail the activity feed, list and answer approvals. The team example has
~1 500 lines of it, and its web app a matching amount (an SSE parser, liveness checks, a chat
bridge with retry and recovery, an optimistic approvals list). Each of these had bugs the library
had already fixed once (trusting client metadata, `actor` from the body, answered-twice races).

## Decision

### `eharness/http`

1. **One handler object, Web APIs only.** `createHarnessHttp(agent, options)` returns
   `fetch(Request)`, `match`, per-route `handlers` and a `routes` table. No framework dependency; Hono
   is `app.all('/api/*', c => http.fetch(c.req.raw))`, Bun is `Bun.serve({ fetch })`. Node needs an
   adapter that streams, forwards `res.on('close')` as an abort and does not buffer or compress
   `text/event-stream` (guide).
2. **`authorize` is required and runs first.** It runs before the body is read and before a session
   is opened (a 401/403 costs no storage read). It returns a principal or a denial (`Response` or
   `{ deny }`); denial is a return value, not an exception. `openAccess` exists for development and
   is documented as unsafe. An optional `chat.authorizeKind` runs after classification.
3. **Server decides everything but the user's words.** The body is whitelisted (last message only,
   `text` and `file` parts, `metadata` dropped, assistant messages reduced to decision parts);
   `actor`, `runtime`, `ifBusy`, `model`, `maxSteps`, `output`, `endTurn` are never read from the
   body. `ifBusy` comes from an allow-listed query parameter.
4. **Idempotency without a new store.** The key (`Idempotency-Key` or the user message id) is looked
   up as `metadata.eharness.clientId` in the last 40 stored messages (a send that was stored is a
   `409 EH_HTTP_DUPLICATE_REQUEST` with `{ turnId, messageId, active }`, so a client can reconnect
   to an active turn); a steer uses `enqueue({ id })` and answers `202 { duplicate: true }`. A
   persistent key store is deferred; the window is documented.
5. **Stale answers are a 409, not a turn.** A `respond` whose ids are all answered or gone is
   `EH_HTTP_ALREADY_ANSWERED`, decided from the stored pending state before the turn starts.
6. **Statuses follow the core** (`EH_PENDING_RESPONSE` is 400 as in spec 04 §7.1); 5xx answers carry
   generic messages and no details; the real error goes to `onFailure`; `onError` maps first.
7. **Attention ownership is explicit.** The server decides the roots; an answer is allowed only for a
   session under the principal's roots (default: walk `parentInfo()` up, depth 8; never depends on
   `listAttention`), else a `404` (does not reveal that the session exists). "See everything" is an
   explicit `canAnswer: () => true`.
8. **Missing sessions read as empty**, not 404, because reads go through `SessionPeek`; apps that
   must hide existence deny in `authorize`.
9. **Paths:** `/sessions/:id/chat` (+ `/chat/stream`), `/sessions/:id/interrupt`, `/attention`,
   `/activity`. Compaction, tools, stats and uploads stay app routes. No CORS in the library: the
   guide lists the headers to allow. OpenAPI: the library exposes the `routes` table only.
10. **Imports:** `src/http` imports core through `src/index.ts` and `eharness/activity` (an
    `allowedImports` pair, like ADR-0049); `eharness/testing` may import `http` for `httpConformance`.

15. **App hooks instead of wrapping the module (amendment).** Migrating the team example showed
    what an app otherwise works around by cloning requests or wrapping `open` / `respond`:
    `chat.validate` (after sanitising; may deny or return a normalised body), `attention.decorate`
    (`item.extra`, `null` hides; the wire stays generic), `parseAnswer` receiving `defaultParse`
    (or returning `undefined`) so the whitelist limits keep working, `attention.agentId` as a
    function of the session, and `attention.onSettled` after the continuation of an answer. A turn
    of another instance is a `409 EH_SESSION_BUSY` for send-with-reject / respond / regenerate / edit
    (checked from `peek.busy()`); a lock held elsewhere on a send held behind an inbox drain is the
    same `409`, which needed the core fix that a deferred run forwards the `accepted` of the turn it
    becomes (spec 04 §7.1 rule 5).

### `eharness/client` (spec 27, same release)

11. **Runtime imports only `ai`.** Everything from `src/http` and `src/activity` is `import type`
    (guarded by `check:imports` and a post-build check). The client builds on AI SDK's
    `DefaultChatTransport` / `AbstractChat`, never a parallel chat implementation.
12. **Stores follow the Svelte store contract** (`subscribe` calls back synchronously, `get()`),
    which `useSyncExternalStore` also accepts; snapshots are immutable and stable; feeds start on the
    first subscriber and stop after the last (1 s grace).
13. **Svelte and React by injection.** No Svelte subpath (`new Chat({ ...session.chatInit })`);
    `eharness/client/react` takes React as an argument (`createReactBindings(React)`), no peer
    dependency. The default transport replays resume from cursor 0 (`from` stays server-side).
14. **Default `canAnswer`, activity filter and body limits** are conservative; widening them is
    explicit in the app.

## Consequences

- The team example deletes its chat, resume, abort, messages, approvals and event routes and keeps
  its domain hooks (`authorize`, `canAnswer`, `parseAnswer`, `describe`, `onError`).
- The wire types become public API (Draft until 1.0, like `eharness/activity`).
- A deployment behind a proxy must not buffer `text/event-stream` (documented, not enforceable).
- The idempotency window (last 40 messages) is a known limit; a store can be added later without
  changing the wire.

## Amendment note (2026-10-11)

Update (0.8, P39): `authorize` fails closed (a result that is not a `Response`, a `{ deny }` or an object answers `401 EH_HTTP_UNAUTHORIZED`), client file parts are accepted only as `data:` URLs unless `chat.allowFileUrls` is set, `run.toResponse()` is the safe HTTP answer and `run.toStreamResponse()` streams at once, and `eharness/client` no longer re-exports `http` and `activity` types except documented aliases or its SSE parser and store internals.
