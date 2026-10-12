# Team e2e environment (test fixture)

A disposable environment for end-to-end runs of `examples/team` through the web UI. Not part of the
library, not published. Plan: [SCENARIOS.md](./SCENARIOS.md) (95 scenarios in 12 suites).

- `tracker/` is **Tracker (demo)**: an in-memory task tracker (Bun + Hono) with a deterministic seed
  (6 people, 3 projects, 12 tasks, 2 overdue), an MCP endpoint over Streamable HTTP at `/mcp`
  (hand-written JSON-RPC, no new dependency), `GET /state` for assertions and `POST /reset`.
  Read tools carry `readOnlyHint`, writes do not, `delete_task` carries `destructiveHint`.
- `fixtures/` has files to upload in scenarios (CSV, TXT, MD, PDF, PNG).
- `start.ts` starts everything.

```bash
bun examples/team/e2e/start.ts            # Tracker on 4991, team server + built web on 4990
bun examples/team/e2e/start.ts --reset    # wipe the temp data dir first
bun examples/team/e2e/start.ts --build    # rebuild the web first (otherwise built only if missing)
bun examples/team/e2e/start.ts --tracker-only   # or --team-only: run the halves separately
```

Then open <http://localhost:4990>, paste the content of the printed token file on Settings and
add the Tracker (`http://localhost:4991/mcp`) as a custom connector. Ctrl+C stops everything.

Environment: `E2E_MODEL` (default `deepseek/deepseek-v4.1-flash`), `E2E_BUDGET` (default 20 USD),
`E2E_DIR` (default `<os tmp>/eharness-team-e2e`). The model key is read from `examples/team/.env`.
The server runs with `TEAM_ALLOW_PRIVATE_MCP=1`, `TEAM_ROUTINE_TICK_MS=2000`, `TZ=Asia/Jakarta`.

Tracker checks: `curl -s localhost:4991/state | jq '.tasks[] | select(.id=="T-05")'`,
`curl -s -X POST localhost:4991/reset`.
