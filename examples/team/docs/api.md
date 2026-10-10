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

## Auth

If `TEAM_TOKEN` is set, every route except `GET /health`, `/docs` and `/openapi.json` needs
`Authorization: Bearer <token>` (compared in constant time). Unset means open: use that on
localhost only. There is one token and one user (`actor` = `owner`); a browser `<img>` cannot send
the header, so the web fetches library bytes with `fetch` and uses object URLs.

## Errors

One shape for every failure, including request validation:

```json
{ "error": { "code": "VERSION_CONFLICT", "message": "...", "details": { "currentVersion": 7 } } }
```

`details` is optional. Domain errors map `invalid` 400, `not_found` 404, `conflict` 409,
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
(public; redirects to the web app), `PATCH|DELETE /connections/{id}`, `POST /connections/{id}/test`,
`GET|PUT /agents/{id}/connectors` (what an agent uses and how freely: Allowed / Ask first / Off),
`PUT|DELETE /connectors/{id}/oauth-client` (OAuth app credentials of a connector). Agents carry
`connectors` (their own choices) instead of `tools` / `mcpServers`; `GET /tools` is gone.

## Streaming endpoints

The chunk shapes belong to the AI SDK (UI message stream protocol, header
`x-vercel-ai-ui-message-stream: v1`), not to this app.

| Endpoint | Use |
|---|---|
| `POST /agents/{id}/chat` | send, answer an approval, regenerate or edit. Body is a `useChat` request. `200` streams the turn; `202` means the message was steered into a turn on another instance; `409` busy (`ifBusy=reject`) |
| `GET /agents/{id}/chat/stream?from=` | resume the running turn from chunk `from` (also `Last-Event-ID`); `204` when idle. Works across instances |
| `POST /agents/{id}/chat/abort` | stop the turn on any instance; says `local`, `remote` or `idle` |
| `GET /events/stream?after=` | SSE feed of changes (`message-added`, `task-changed`, `approval-needed`, `routine-fired`, `file-changed`, ...) with `seq` as the event id; JSON variant `GET /events?after=` |

### AI SDK client contract

The web uses the `Chat` class of `@ai-sdk/svelte` (the `useChat` contract) with `DefaultChatTransport`:

- `api: /api/agents/{id}/chat`; send only the last message (`prepareSendMessagesRequest`): the
  server never rebuilds from client history and ignores everything but `text` / `file` parts.
- Approvals: `addToolApprovalResponse` plus `sendAutomaticallyWhen` re-post the assistant message
  to the same endpoint; the continuation streams **into the same message id**.
- Reload: the Svelte `Chat` has no `resume` option, so the app calls `chat.resumeStream()` (with `prepareReconnectToStreamRequest` pointing at `GET .../chat/stream`); on `204` read `GET /agents/{id}/messages`.
  A continuation after an approval replays only the continuation, so refetch the message at the end.
- Errors after the stream started (model failure, stale answer) arrive as an `error` chunk, not a
  status. Statuses are only for failures before the turn commits.
- Approvals of **other** sessions (a role agent's task, a routine run) are not in a chat stream:
  list them with `GET /approvals` and answer with `POST /approvals/{id}`; the continuation runs
  server side and shows up in the events feed.

A non-browser client works the same way: POST the body, read the SSE stream, remember the index of
the last chunk, and resume with `from`.
