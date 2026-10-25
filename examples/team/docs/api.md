# API

The server's HTTP API is declared with `createRoute` and named zod schemas, so the OpenAPI document
is complete and is the reference. This page covers what the document cannot say well.

## Where to read it

- `GET /docs`: interactive reference (Scalar).
- `GET /openapi.json`: OpenAPI 3.1, generated from the routes.
- `shared/openapi.json`: the same document, exported by `bun run openapi` (in `server/`) and
  committed. The web generates its types from it, so regenerate it after any route or schema change.

Tags: `system`, `agents`, `chats`, `library`, `memory`, `settings`, `routines`, `tasks`,
`approvals`, `events`.

Chat, session reads, the attention answers and the event feed are **`eharness/http`** (spec 26,
[guide](../../../docs/guides/http-server.md)), mounted on this app in `http/routes/harness.ts`
(`createHarnessHttp` in `infra/eh/harness-http.ts`). Their OpenAPI entries are documentation only
(hand-written in `http/schemas/harness.ts`); the library validates and answers those routes.

## Auth

If `TEAM_TOKEN` is set, every route except `GET /health`, `/docs`, `/openapi.json` and
`GET /oauth/callback` (the browser returns there from a provider, it cannot send the header; it only
completes a flow that was started with a token) needs `Authorization: Bearer <token>` (compared in
constant time). Unset means open: the server then listens on `127.0.0.1` only and refuses a
non-loopback `TEAM_HOST`. The `Host` header must be loopback, `TEAM_HOST`, the host of
`TEAM_PUBLIC_URL` or listed in `TEAM_ALLOWED_HOSTS` (else `403 FORBIDDEN_HOST`; DNS rebinding guard). There is one token and one user (`actor` = `owner`); a browser `<img>` cannot send
the header, so the web fetches library bytes with `fetch` and uses object URLs.

### Password login

With `BASIC_AUTH_PASSWORD` set, every route except `GET /health` and `/auth/*` needs the
`team_session` cookie or the bearer `TEAM_TOKEN`; `/docs`, `/openapi.json` and `/oauth/callback` are
protected too (the callback is a top-level GET, so the `SameSite=Lax` cookie reaches it). A missing
session is `401 AUTH_REQUIRED` (a wrong bearer token without login stays `UNAUTHORIZED`).
`GET /auth/session` -> `{ required, authenticated }`; `POST /auth/login { password }` sets the cookie
(`401 INVALID_PASSWORD`, `429 LOGIN_LOCKED` with `Retry-After` after 5 failures);
`POST /auth/logout` clears it. State-changing requests still pass the Origin check. These endpoints
are not in `openapi.json`.

## Errors

One shape for every failure, including request validation:

```json
{ "error": { "code": "VERSION_CONFLICT", "message": "...", "details": { "currentVersion": 7 } } }
```

`details` is optional. The library routes use the same shape with `EH_*` / `EH_HTTP_*` codes
(`EH_HTTP_INVALID_BODY`, `EH_HTTP_ALREADY_ANSWERED`, `EH_HTTP_DUPLICATE_REQUEST`, `EH_SESSION_BUSY`,
...; spec 26 §3); `DomainError` thrown inside their hooks keeps its status and code. Domain errors map `invalid` 400, `not_found` 404, `conflict` 409,
`forbidden` 403. eharness errors keep their code: `EH_SESSION_BUSY` / `EH_SESSION_CLOSED` /
`EH_PENDING_RESPONSE` 409, `EH_INVALID_INPUT` 400, `EH_STORAGE` 503. Bodies over the limit are 413.

## Optimistic concurrency

Agent edits and library / memory writes use versions. A stale library edit (`ifVersion`) is
`409 VERSION_CONFLICT` with `details.currentVersion`; an agent edit that raced another is the same
code. Reload and retry.

## Secrets

Connection secrets (API keys, header values, OAuth tokens, OAuth app credentials) are write-only:
responses carry `{ set, hint }` only. A `PATCH /connections/{id}` that omits a secret (or sends `""`
or `{ "keep": true }`) keeps the stored value. Connect flows (`/connections/flows`) never echo a
secret either; a form value comes back as `{ set, hint }`.

## Connectors

`GET /connectors` (catalog), `GET /connections`, `POST /connections/flows` + `GET|POST
/connections/flows/{id}[/act]` (server-driven connect flow: render `view` by `type`, quote its
`viewId`; a stale view is `409 STALE_VIEW` carrying the current `flow`), `GET /oauth/callback`
(public; redirects to the web app), `PATCH|DELETE /connections/{id}`, `PUT /connections/{id}/access` (`{ mode: all|selected, agentIds }`; `GET /connections` returns `access`), `POST /connections/{id}/test`,
`GET|PUT /agents/{id}/connectors` (what an agent uses and how freely: Allowed / Ask first / Off),
`PUT|DELETE /connectors/{id}/oauth-client` (OAuth app credentials of a connector). Agents carry
`connectors` (their own choices) instead of `tools` / `mcpServers`; `GET /tools` is gone.

## Streaming endpoints

The chunk shapes belong to the AI SDK (UI message stream protocol, header
`x-vercel-ai-ui-message-stream: v1`), not to this app.

A **session id** is `dm:<agentId>` (the DM chat of an agent; `dm:<slug>` is accepted) or the
`sessionId` of a task row (`GET /tasks`). URL-encode the colon or leave it: both work.

| Endpoint | Use |
|---|---|
| `POST /sessions/{id}/chat?ifBusy=` | send, answer an approval, regenerate or edit (DM sessions only). Body is a `useChat` request whose `id` is the session id. `200` streams the turn; `202` means the message was steered into a turn on another instance; `409` busy (`ifBusy=reject`, or approve / regenerate / edit while busy); `409 EH_HTTP_ALREADY_ANSWERED` for a stale approval answer; `409 EH_HTTP_DUPLICATE_REQUEST` for a repeated message id / `Idempotency-Key`. `ifBusy` is `steer` (default) or `reject` |
| `GET /sessions/{id}/chat/stream?from=` | resume the running turn from chunk `from` (also `Last-Event-ID`); `204` when idle. Works across instances and for task sessions |
| `POST /sessions/{id}/interrupt` | stop the turn on any instance; says `local`, `remote`, `idle` or `unsupported`. Works for task sessions |
| `GET /sessions/{id}` | stored state: `running`, `busy`, `activeTurn`, `pending`, `usage` |
| `GET /sessions/{id}/messages?before&limit` | stored messages, newest page first (`nextBefore` absent at the start) |
| `GET /approvals` | **app route**: everything waiting for a person with agent name, task and question texts |
| `GET /attention` | the library queue (`listAttention`, no app fields) |
| `POST /attention/{id}/answer` | answer an approval or a question: `{ sessionId, answer }`; `answer` is `{ kind: 'approval', approved, reason?, note?, remember? }` or `{ kind: 'question', answers }`. `200 { status: 'recorded' \| 'resumed' \| 'already-answered', remaining? }`; `404` item gone; `409` a turn of the session runs |
| `GET /activity/stream?after=` | SSE feed of changes (`message-added`, `task-changed`, `pending-changed`, `approval-decided`, `routine-fired`, `file-changed`, ...; session events come from `eharness/activity`) with `seq` as the event id; JSON variant `GET /activity?after=&limit=` |
| `GET /events`, `GET /events/{id}`, `GET /events/catalog` | the unified event stream (chat and app events, filters, cursor paging); see [events.md](events.md) |

Chat on a task session is `409 TASK_SESSION` (a person talks to a task through `POST
/tasks/{id}/messages`, the durable inbox); an archived agent's DM is `409 AGENT_ARCHIVED` for chat
and still readable. `GET /health` is the team's own route (it carries `name` and `time` next to
`boot`; the library `/health` is not mounted).

### AI SDK client contract

The web uses the `Chat` class of `@ai-sdk/svelte` (the `useChat` contract) with `DefaultChatTransport`:

- `api: /api/sessions/dm:{agentId}/chat` (body `id` = the session id); send only the last message (`prepareSendMessagesRequest`): the
  server never rebuilds from client history and ignores everything but `text` / `file` parts.
- Approvals: `addToolApprovalResponse` plus `sendAutomaticallyWhen` re-post the assistant message
  to the same endpoint; the continuation streams **into the same message id**.
- Reload: the Svelte `Chat` has no `resume` option, so the app calls `chat.resumeStream()` (with `prepareReconnectToStreamRequest` pointing at `GET .../chat/stream`); on `204` read `GET /sessions/{id}/messages`.
  A continuation after an approval replays only the continuation, so refetch the message at the end.
- Errors after the stream started (model failure, stale answer) arrive as an `error` chunk, not a
  status. Statuses are only for failures before the turn commits.
- Approvals of **other** sessions (a role agent's task, a routine run) are not in a chat stream:
  list them with `GET /approvals` and answer with `POST /attention/{id}/answer`; the continuation
  runs server side and shows up in the activity feed.

A non-browser client works the same way: POST the body, read the SSE stream, remember the index of
the last chunk, and resume with `from`.
