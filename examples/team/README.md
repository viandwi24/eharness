# examples/team

A team-agent app on the public eharness API: a lead agent plus role agents, a web UI, and a
server that runs everything (deployment profile "web + server"). Plan:
[`docs/plans/P32-team-example.md`](../../docs/plans/P32-team-example.md). Never published.

```
server/   Hono + @hono/zod-openapi + Drizzle on bun:sqlite   (M1-M2 done: agents API, SQLite adapters, agent factory)
web/      SvelteKit UI
shared/   generated: openapi.json (`bun run openapi` in server/)
docs/     architecture and run notes
```

## Run the server

```bash
bun install                      # at the repo root (workspaces)
cd examples/team/server
OPENROUTER_API_KEY=... bun run start      # or AI_GATEWAY_API_KEY, or TEAM_SCRIPTED_MODEL=steps.json
```

| Variable | Meaning |
|---|---|
| `TEAM_DB` | database file, default `./data/team.db` (WAL; two processes may share it) |
| `TEAM_TOKEN` | bearer token. **Unset = the API is open**: use it on localhost only |
| `PORT` | default 4000 |
| `OPENROUTER_API_KEY` / `AI_GATEWAY_API_KEY` | model provider (`TEAM_PROVIDER`, `TEAM_MODEL` override the choice) |
| `TEAM_SCRIPTED_MODEL` | JSON array of scripted steps (`eharness/testing`): offline runs and tests |

- API reference: `GET /docs` (Scalar). Machine-readable: `GET /openapi.json` (OpenAPI 3.1),
  exported to `shared/openapi.json` by `bun run openapi`.
- Errors: `{ "error": { "code", "message" } }`. `/health`, `/docs` and `/openapi.json` need no token.
- Migrations are generated (`bun run db:generate`) and applied at boot.

## Tests

```bash
cd examples/team/server && bun test    # layering, HTTP, agent factory, adapter conformance suites
```

The SQLite adapters (`infra/eh/storage.ts`, `infra/eh/library-fs.ts`) run the library's conformance
suites from `eharness/testing` (messages, state, inbox, budget ledger, filesystem).
