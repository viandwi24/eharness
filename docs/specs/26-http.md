# Spec 26: HTTP module (`eharness/http`)

Status: **Draft (0.8)**. Module: `src/http/*`. Built only with the public core API and
`eharness/activity` (ADR-0008, ADR-0059). Lifted from the team example's server routes. The browser
counterpart is `eharness/client` (spec 27, same release).

```ts
import { createHarnessHttp, openAccess, sanitizeChatBody, classifyChatBody, httpError, statusOfCode } from 'eharness/http'
import type { SessionSnapshot, MessagesPage, ChatQueued, InterruptResult, AttentionListResponse, AnswerRequest, AttentionAnswerWire, HttpErrorBody, HttpErrorCode, SessionSummary } from 'eharness/http'
```

Web APIs only: `Request` in, `Response` out. The module is a `fetch` handler; mounting it in a
framework is one line (guide `docs/guides/http-server.md`).

## 1. `createHarnessHttp`

```ts
createHarnessHttp<P>(agent: HarnessAgent | undefined, options: HarnessHttpOptions<P>): HarnessHttp
interface HarnessHttp {
  fetch(request: Request): Promise<Response>        // routing + the pipeline; never rejects
  match(request: Request): { action: HttpAction; params: Record<string, string> } | null
  handlers: Record<HttpAction, (request: Request, params?: Record<string, string>) => Promise<Response>>
  readonly routes: readonly { method: 'GET' | 'POST'; path: string; action: HttpAction }[]
}
```

- `authorize` is **required** (`EH_CONFIG_INVALID` at creation when missing). `openAccess` allows
  everything and is for development and tests only.
- `agent` supplies the defaults of `session(id, ctx)` (`agent.session(id)`) and `peek(id, ctx)`
  (`agent.peek(id)`). Without an agent, a route that needs a hook that was not given is not
  mounted (404). Hooks receive `{ principal, request, action }` and may return another agent's
  session (multi-agent apps).
- `basePath` (default none) prefixes every route; a trailing slash on the request path is ignored.
- `maxBodyBytes` (default 4 MiB) limits every request body (§5.1).
- `headers` are added to every response (denials, errors and 404 included): the place for CORS.
- `routes` lists the routes **in effect**: `GET /sessions` exists only with `sessions.list`,
  `/attention*` only with `attention`, `/activity*` only with `activity`. Session routes need a
  session (chat) or peek (reads) source.

## 2. Routes

Paths are relative to `basePath`. `:id` is URL-decoded (`dm%3Aabc` is `dm:abc`). Every error is
`{ "error": { "code", "message", "details"? } }` (§3).

| Method and path | Action | Answer |
|---|---|---|
| `GET /health` | `health` | `{ ok: true, boot }` (`boot` = `activity.bootId`, else a random id per `createHarnessHttp`) |
| `GET /sessions?limit&cursor` | `session.list` | `{ sessions: SessionSummary[], next? }`; `limit` 1..200 (default 50) |
| `GET /sessions/:id` | `session.read` | `SessionSnapshot` |
| `GET /sessions/:id/messages?before&limit` | `session.messages` | `MessagesPage`; `limit` 1..200 (default 50), oldest first, `nextBefore` = id to pass as `before` |
| `POST /sessions/:id/chat?ifBusy=` | `chat` | `200` UI message stream, or `202 ChatQueued` |
| `GET /sessions/:id/chat/stream?from=` | `chat.resume` | `200` stream of the active turn, `204` when none; `Last-Event-ID` is accepted; malformed cursor `400` |
| `POST /sessions/:id/interrupt` | `chat.interrupt` | `InterruptResult` (`session.requestAbort`) |
| `GET /attention` | `attention.list` | `{ items: AttentionItem[] }` |
| `POST /attention/:id/answer` | `attention.answer` | `AnswerResponse`; `404` when not found |
| `GET /activity/stream?after=` | `activity.stream` | SSE (`handleActivityStream`) |
| `GET /activity?after&limit` | `activity.page` | `ActivityPage`; `limit` 1..500 (default 100) |

A known path with another method is `405` with `Allow`; an unknown path `404`. There is no `OPTIONS`
handling and no CORS (guide).

### 2.1 `SessionSnapshot`

`{ id, running, busy, activeTurn, pending, usage, info? }`. `running` is `busy !== null` (a turn
runs in any instance); `busy` is `SessionBusy | null`; `activeTurn` and `usage` come from the stored
state; `pending` is `{ messageId, approvals[{ approvalId, toolCallId, toolName, input?, answered }],
clientTools[…], externals[…] } | null`. `info` is `sessions.describe(id)` when configured. A session
that does not exist reads as an empty snapshot (not 404); an app that must hide existence denies in
`authorize`.

## 3. Errors

| Code | Status |
|---|---|
| `EH_INVALID_INPUT`, `EH_INVALID_MESSAGE`, `EH_PENDING_RESPONSE`, `EH_HTTP_INVALID_JSON`, `EH_HTTP_INVALID_BODY` | 400 |
| `EH_HTTP_UNAUTHORIZED` | 401 |
| `EH_HTTP_FORBIDDEN` | 403 |
| `EH_HTTP_NOT_FOUND` | 404 |
| `EH_HTTP_METHOD_NOT_ALLOWED` | 405 (with `Allow`) |
| `EH_SESSION_BUSY`, `EH_SESSION_CLOSED`, `EH_HTTP_ALREADY_ANSWERED`, `EH_HTTP_DUPLICATE_REQUEST` | 409 |
| `EH_HTTP_PAYLOAD_TOO_LARGE` | 413 |
| `EH_HTTP_UNSUPPORTED_MEDIA_TYPE` | 415 |
| `EH_COMPACTION_FAILED` | 502 |
| `EH_STORAGE` | 503 |
| other `EH_*`, `EH_INTERNAL` | 500 |

`statusOfCode(code)` is this table. A thrown `HarnessError` below 500 keeps its message and details;
a 5xx answer has a generic message and no details, and the real error goes to `onFailure(error,
{ request, action })`. `onError(error, { request, action? })` runs first for every thrown error
(hook errors included) and may return a `Response`. Failures after a stream started stay in the
stream. A `Response` returned by `authorize` is passed through (plus `headers`).

## 4. Authorization

`authorize({ request, action, sessionId?, attentionId? })` runs once per request, **before the body
is read** and before any session is opened, and returns a principal `P` or a denial: a `Response`, or
`{ deny: 401 | 403 | 404, code?, message? }` (a principal object must not have a numeric `deny`
key). It must not throw for a denial; a throw is an error (§3). `sessionId` is the `:id` of session
routes, `attentionId` the `:id` of the answer route. `chat.authorizeKind({ principal, kind, sessionId,
request })` runs after the chat body was classified (`send`, `respond`, `regenerate`, `edit`) and may
return a denial.

## 5. Chat

### 5.1 Body limits

`content-length` over `maxBodyBytes` is `413` without reading; otherwise the stream is counted, so a
missing or false header cannot pass the limit. A body that does not parse is `400
EH_HTTP_INVALID_JSON`; a content type that is not `application/json` (or `+json`) is `415`.

### 5.2 Body whitelist (`sanitizeChatBody`)

Errors are values (`{ ok: false, code, message, details? }`). Rules:

1. The body is an object whose `id` equals the path id (`EH_HTTP_INVALID_BODY`).
2. `trigger` is absent, `submit-message` or `regenerate-message`; `messageId` a non-empty string.
3. Only the **last** message is kept (a regenerate may have none).
4. A **user** message keeps `{ id, role, parts }`; parts are `text` (at most `maxTextBytes`, default
   64 KiB) and `file` (`url`, `mediaType`, `filename?`), at most `maxParts` (default 32); any other
   part type, or a violation, is `400 EH_INVALID_INPUT` (`details.reason`). Its `metadata` is dropped.
5. An **assistant** message (a `respond`) is reduced to the decision fields of tool parts
   (`approval-responded` with `approval.{id,approved,reason?}`, `output-available`,
   `output-error`); everything else is dropped.
6. `clientTools` / `pageContext` are read only with `chat.clientTools` / `chat.pageContext` enabled.
7. Never read from the body: `actor`, `runtime`, `toolsContext`, `ifBusy`, `maxSteps`, `model`,
   `settings`, `output`, `endTurn`. `ifBusy` comes from the query; `actor` from `chat.actorOf`;
   server options from `chat.sendOptions`.

`classifyChatBody(body)` returns `send | respond | regenerate | edit` with the dispatch of
`handleChatRequest`.

### 5.3 Pipeline

`authorize` → content type and body (§5.1) → sanitize (§5.2) → `authorizeKind` → idempotency key →
stale-answer check → busy policy → `handleChatRequest(session, body, options)` →
`await run.toHttpResponse()`. Stream responses carry `x-eharness-turn-id`, `x-eharness-session-id`,
`cache-control: no-cache, no-transform` and `x-accel-buffering: no`.

- **Idempotency.** The key is the `Idempotency-Key` header (invalid: `400`), else the id of the
  user message when it is valid; valid keys are `[A-Za-z0-9_.:-]{1,128}`. For a **send**, the last
  40 stored messages are searched for a user message with `metadata.eharness.clientId` equal to the
  key (also `collected` entries and steered `data-eh.input` parts): found is `409
  EH_HTTP_DUPLICATE_REQUEST` with `details { messageId, turnId?, active }` (`active`: that turn still
  runs, so a client reconnects with the resume route). A steer to a turn of another instance passes
  the key to `enqueue({ id })` and a repeat is `202` with `duplicate: true`.
- **Stale answer.** A `respond` whose approval ids / tool call ids are all answered or no longer
  pending is `409 EH_HTTP_ALREADY_ANSWERED` (`details.ids`) and starts no turn. A partially stale
  answer proceeds (stale ids are ignored by the core).
- **Busy policy** (send only; `respond`, `regenerate`, `edit` always `409` when busy). `?ifBusy=`
  must be in `chat.ifBusy` (default `['reject']`), else `400`; absent means `chat.defaultIfBusy`
  (default `reject`). `reject`: `409 EH_SESSION_BUSY`. `wait`: core `ifBusy: 'wait'`. `steer`: a turn
  of **this** instance gets core `ifBusy: 'steer'` (`200`, the stream follows the running turn); a
  turn of **another** instance gets `session.enqueue(message, { mode: 'steer' })` and `202
  ChatQueued { inboxId, delivered: 'steer', target, duplicate? }`.
- **Resume** (`GET …/chat/stream`) is `handleResumeRequest` for the session of the request (also when
  another instance runs the turn); the reader aborting never aborts the turn.
- **Interrupt** takes an optional JSON body `{ reason? }` (at most 200 characters) and answers
  `{ target: 'local' | 'remote' | 'idle' | 'unsupported' }`.

## 6. Options

```ts
interface HarnessHttpOptions<P> {
  authorize: Authorize<P>
  session?(id, ctx: { principal: P; request; action }): MaybePromise<HarnessSession>
  peek?(id, ctx): MaybePromise<SessionPeek>
  basePath?: string; maxBodyBytes?: number; headers?: HeadersInit
  chat?: { ifBusy?; defaultIfBusy?; clientTools?: false | ClientToolsOptions; pageContext?: false | PageContextOptions
           actorOf?(principal): ApprovalActor | undefined; authorizeKind?; sendOptions?(ctx); maxParts?; maxTextBytes? }
  sessions?: { list({ principal, request, query: { cursor?, limit } }): { sessions, next? }; describe?(id, { principal, request }) }
  attention?: { roots({ principal, request }); peek: AttentionPeekFn; open(id, { principal, request }); canAnswer?; parseAnswer?
                waits?; maxDepth?; store?; agentId?; allowRemember?: boolean; maxNoteChars?: number }
  activity?: { store: ActivityStore; bootId: string; filter(principal): ((r: ActivityRecord) => boolean) | 'all'; pollMs?; keepAliveMs?; retryMs? }
  onError?; onFailure?
}
```

## 7. Attention routes

- `GET /attention`: `listAttention` from `attention.roots(...)` (decided by the server) with
  `attention.peek`. The client never names roots.
- `POST /attention/:id/answer` body `{ sessionId, answer }`. `authorize` runs with `attentionId`; then
  `canAnswer({ principal, request, sessionId, attentionId })`. The default allows a `sessionId` that
  is one of the roots or a descendant (walks `peek(sessionId).parentInfo()` up, depth 8; it does not
  use `listAttention`). `false` answers `404 EH_HTTP_NOT_FOUND` (it does not reveal that the
  session exists); a `HttpDeny` is passed through. "See everything" is an explicit `() => true`.
- The answer is whitelisted: `{ kind: 'approval', approved, reason?, note?, remember? }` or `{ kind:
  'client-tool' | 'wait', output }` / `{ …, errorText }`. `note` at most `maxNoteChars` (2000);
  `remember` is `400` unless `allowRemember: true`; `endTurn` is never read. `parseAnswer({ item?,
  body })` replaces the whitelist for app-specific shapes (`item` is the pending item when found).
- Then `answerAttention(id, { sessionId, answer, open, peek, actor, store, agentId })`: `200
  AnswerResponse` (`resumed`, `recorded` with `remaining`, `already-answered`); `not-found` is `404`;
  a wrong kind is `400`; a busy session with a waiting item is `409`.

## 8. Activity routes

`activity.filter(principal)` returns `'all'` or a predicate applied to every record the principal
receives (the stream cursor still advances over filtered records). `GET /activity/stream` is
`handleActivityStream` with `store`, `bootId` and the timings; an invalid `after` is `400`. `GET
/activity` is `readActivityPage` (`after` default 0).

## 9. Runtime

Web APIs only; no `Bun.*`, no Node built-ins. Hono, Bun and Node recipes are in the guide.

## 10. Wire types

`src/http/wire.ts` holds every JSON shape (`SessionSnapshot`, `MessagesPage`, `ChatQueued`,
`InterruptResult`, `AttentionListResponse`, `AnswerRequest`, `AttentionAnswerWire`, `AnswerResponse`,
`HttpErrorBody`, `HttpErrorCode`, `SessionSummary`, `HealthResponse`, `HttpAction`). It has no runtime
code: `eharness/client` imports it with `import type`.

## 11. Conformance

`httpConformance(factory, { dispose? })` in `eharness/testing` returns cases for a handler (the
factory returns `{ fetch, baseUrl? }`; the agent behind it answers with a streamed reply of at least
250 ms and `authorize` allows the suite). It checks the route table (404, 405 with `Allow`), the
error shape and code of 415 / invalid JSON / id mismatch / forbidden part, that the first chunk
arrives before the turn ends, that the turn is stored and the session reads idle afterwards, that a
client abort ends the stream, messages paging errors, resume `204` / `400` and interrupt of an idle
session. Run it against `createHarnessHttp(...).fetch` and through a real server.
