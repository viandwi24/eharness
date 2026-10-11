# Process scripts

Real-process checks of the multi-instance and restart behaviour (plan
`docs/plans/P32-team-example.md` §8). Each script spawns `bun examples/team/server/src/main.ts`
as separate OS processes over **one SQLite file** in a temp dir, so nothing is shared except the
database. The model is a **scripted model** (`TEAM_SCRIPTED_MODEL` = a JSON file the script
writes), so runs are deterministic and cost nothing. Run them one at a time from the repo root.
Each scenario prints `PASS` / `FAIL` / `SKIP` with a reason; the exit code is non-zero on failure.

| Script | What it does |
|---|---|
| `two-instances.ts` | Instances A (:4101) and B (:4102). Scenarios: resume A's running stream from B (chunk sequences must be identical); abort A's turn from B; a message sent to B during a turn on A is steered (202) and shows up in the turn; the Lead parks on A, the role agent's approval is listed and answered on B, the task completes, the Lead's reply is stored, and B's `/events/stream` carried the events; A and B agree on `/approvals` afterwards. |
| `kill-restart.ts` | `SIGKILL` (no graceful close) of A, then B on the same file: a parked delegation is listed on B, answered, and completes; a kill during a streaming turn is recovered (`EH_TURN_INTERRUPTED` notice, no tool re-run) and the session is usable again; routines (skipped with a message until `/routines` is in `shared/openapi.json`); with a stable `TEAM_INSTANCE_ID`: a kill mid-turn is recovered by the restarted instance at boot (no SQL ageing), Continue and Retry work at once; a kill while a background child works gives the lead one `interrupted` report and an `interrupted` task. |
| `smoke-real.ts` | Optional, **costs money**: one real OpenRouter turn where the Lead delegates a tiny research task, auto-approves what the role agent asks, prints the transcript, tasks and cost. Reads `OPENROUTER_API_KEY` from the environment or the repo root `.env`, never prints it. |

```bash
bun examples/team/scripts/two-instances.ts
bun examples/team/scripts/kill-restart.ts              # ages the dead turn's heartbeat and lock by SQL
bun examples/team/scripts/kill-restart.ts --wait-stale # really waits ~2 min (staleMs 120 s)
bun examples/team/scripts/smoke-real.ts                # real model, costs money
```

`KEEP_DIR=1` keeps the temp directory (database, scripts) after a run. `lib.ts` holds the shared
spawn/HTTP/SSE helpers. A killed streaming turn is only recovered after its heartbeat is older than
`recovery.staleMs` (120 s) and the session lock lease (30 s) expired, so the default mode shortens
both with SQL; `--wait-stale` is the honest variant.
