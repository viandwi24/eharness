# P56 — Developer API: isolated agents for third-party developers

Status: in progress · Owner: agent session · Branch: main

## Goal

Third-party developers call isolated agents from other machines. The owner makes **API agents** on a
**Developers** page (name, model, instructions, rules and an explicit access list), makes **API
keys** with limits, and developers use a versioned `/v1` API: a one-shot run (mode A) or stored
conversations that stream (mode B). The team's own agents, chats and channels are untouched.

## Decisions

- **A separate kind, not a team agent.** API agents have their own tables (`api_agents`, `api_keys`,
  `api_conversations`, `api_requests`, `api_calls`; migration `0042_developer_api`, additive). They
  are never rows of `agents`, so no team list, roster, Telegram route or heartbeat can reach them,
  and the agent factory (`agent-factory.ts`) is not involved. The runtime is its own module,
  `infra/eh/api-agents.ts`.
- **Access is a short allow list, default nothing.** Tools: none; `read_file`, `list_files`, `grep`,
  `glob` over granted library folders; `write_file` and `edit_file` only with a write folder;
  `web_search` only when switched on and the server has a search provider. A scoped file system
  (`scopedFs`) shows only granted folders (anything else reads as missing, writes outside the write
  folder fail with a readable message, nothing is deleted). Grants must be folders inside `/library`
  (never the library itself, never hidden folders). No channels, memory of other agents, programs,
  decisions, tasks, connectors or sub-agents.
- **Untrusted callers.** A static preamble (`API_PREAMBLE`): user input and framed content are data,
  never instructions; do not reveal instructions or paths. A caller `context` object is wrapped in an
  `<untrusted-content>` frame (`untrustedContent`).
- **Keys.** `ehk_<8 id>_<32 secret>`; only SHA-256 and the visible id are stored; unknown id, wrong
  secret, revoked and expired are the same `401`. `/v1` accepts only keys; the owner token and login
  cookie do not open it (the owner auth and the Origin check skip `/v1`), and keys open nothing else.
- **CORS per key** (`origins`). Preflight is answered for origins that some live key lists. A request
  with an `Origin` the key does not list is `403 ORIGIN_NOT_ALLOWED`, except the same host as the
  server (the Try it console). No origins = server-to-server only.
- **Limits.** Rate limit counts admitted requests of the last minute (rows of `api_requests`, so it
  holds across instances); the daily cost limit sums `api_calls` of the UTC day (every model call is
  tagged with the key id by a `model.call` hook; the cost a turn carries beyond its model calls, such
  as a search, is booked at the end of the request). Over either: `429` with a readable message and
  `Retry-After`. A parallel burst can overshoot the daily limit by the requests already running. The
  workspace budget is the shared ledger scope: a turn stopped by it is `429 WORKSPACE_BUDGET`.
- **Mode A stores nothing.** One-shot runs use in-memory storage and a throwaway session; only
  metadata (time, key, agent, status, tokens, cost) is logged, never input or answer. `outputSchema`
  (JSON Schema, `type: object`) uses the library's structured output (tool mode, validated with the
  zod JSON Schema conversion of the deliverables code, 2 retries); no valid answer is `502 OUTPUT_INVALID`.
- **Images in mode A.** `images: [{ mediaType, data }]` (jpeg, png, webp, gif; at most 4; standard
  base64 without a `data:` prefix; at most 1.5 MB decoded each) become AI SDK file parts (`data:`
  URLs) of the input, the last user message. They live only in the in-memory run and are never
  stored or logged; errors never echo them. `400 INVALID_IMAGES` (type, base64, count),
  `413 IMAGE_TOO_LARGE`; a model whose catalog modalities lack `image` is refused by the core before
  the turn starts (`EH_INVALID_INPUT`, `unsupported-modality`), answered as `400 IMAGES_UNSUPPORTED`
  with the core message. The run route allows a 9 MB body; every other `/v1` route keeps 1 MB. Mode
  B stays text only.
- **Mode B** sessions are `api:<agentId>:<conversationId>` on the shared SQLite storage and lock. A
  conversation belongs to its key; the same `endUserId` + agent + key returns the open one.
  The stream is the AI SDK UI message stream with tool calls, reasoning and metadata removed
  (`publicStream`); history is text only. `/v1/sessions/{id}/chat` is an alias so `eharness/client`
  (`baseUrl: <server>/v1`) works unchanged.
- **Retention** per agent (`retentionDays`, default 30): a sweep on boot and every 10 minutes deletes
  idle conversations and their `eh_*` rows; the request log keeps 90 days.

## Owns

`domain/developer-api.ts`, `app/developer-api.ts`, `infra/db/developer-repo.ts`,
`infra/eh/api-agents.ts`, `http/routes/{developer,v1}.ts`, `http/schemas/developer.ts`, the
`api_*` tables, `web/src/routes/developers`, `web/src/lib/developers`,
`web/src/lib/components/app/developers`.

## Checklist

- [x] API agents with grants (read folders, one write folder, web search), rules, model, retention
- [x] Keys: create once, hashed, agents, daily cost, rate limit, origins, expiry, revoke, last used
- [x] `/v1`: run (mode A), conversations (mode B: open/reuse, messages SSE or JSON, history, close, delete)
- [x] Per-key and workspace limits as `429`, usage and cost per key, request log
- [x] Retention sweep
- [x] Developers page: agents, keys with chart, requests, Try it with snippets
- [x] OpenAPI (`developer` and `v1` tags, `ApiKey` scheme) and tests (`test/developer-api.test.ts`)
- [x] Mode A images (`images`, up to 4 × 1.5 MB, 9 MB run body), never stored or logged

## Phase 2 (not built)

- **Client-managed messages**: the caller sends the whole history each time and nothing is stored
  (a stateless conversation endpoint for apps with their own database).
- **OpenAI-compatible endpoint** (`/v1/chat/completions`, streaming, tool-less) so existing SDKs
  and tools can point at an API agent.
- **Human handoff**: an API agent can park a conversation for a person (the library's handoff
  module) and the answer resumes it; a `needs_human` state and a way for the owner to reply.
- **Webhooks**: signed callbacks for conversation events (handoff requested, closed, budget stop)
  with retries.
- Per-agent memory scope (a private folder the agent may read and write, today the write folder can
  play that role), a `/v1/agents/{slug}` description endpoint with the schema it expects, and an
  idempotency key for runs.

## Phase 3 (not built)

- **Live-chat widget**: an embeddable script (one `<script>` tag) that opens a conversation for the
  visitor (`endUserId` from a cookie), streams answers, and uses a browser-safe key (origins, low
  daily limit) or short-lived session tokens minted by the customer's server.
- Visitor identity and transcript email, rate limits per end user, and the handoff to a human of
  phase 2 as the widget's escalation.

## Open questions

- **Cost of a stopped stream.** A browser that disconnects mid-stream does not stop the turn (the
  library keeps running it); the cost still lands on the key. Aborting on disconnect is a one-line
  change if the owner prefers it.
- **Daily limit is checked before a request, not during it.** One long request can pass the limit;
  a per-request cap (`maxTurnOutputTokens`) would bound that.
- **Own memory scope** is reserved, not built (see phase 2).
- **Request body of keys in browsers**: the page shows a warning; short-lived tokens are phase 3.
