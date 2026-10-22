# P54 — Alarms: no silent failure

> P55 note: the Health page became the "Needs attention" page (`/attention`): alarms, health findings and consistency findings in one list, one Dismiss. See `P55-consolidation.md`.

Status: in progress · Owner: agent session · Branch: main

## Goal

The owner used to learn about failed scheduled or background work only through model-written
heartbeat beats and digests, and the heartbeat is silent by default. After this phase every such
failure is a stored alarm, raised by the server with no model call, shown on the Health page under
"Needs attention" until acknowledged, and pushed to the owner in plain short text: what failed, why,
and the one concrete next step.

## Where it lives (`examples/team/server`)

| Piece | File |
|---|---|
| Pure rules: kinds, texts, rate limit, batch text, stuck-run predicate | `src/domain/alarms.ts` |
| Raise, sweep, clear, deliver, ack | `src/app/alarms.ts` |
| Table `alarms` (migration `0039_graceful_human_fly`) and store | `src/infra/db/alarms-repo.ts`, `schema.ts` |
| `GET /alarms`, `POST /alarms/{id}/ack` | `src/http/routes/alarms.ts` |
| Owner push (`ChannelGateway.notifyOwners`) | `src/infra/channels/gateway.ts` |
| Health page section | `web/src/routes/health/+page.svelte` |
| Setting `stuckRunMinutes` (default 45, 5-1440) | `src/domain/settings.ts` |

## What raises an alarm

| Kind | Source | Incident key | Clears when |
|---|---|---|---|
| `run-failed` | sweep: a program, routine or work-queue task ended `failed`, `interrupted` or `timed_out` (automatic retries exhausted: a waiting retry is never alarmed; a later good run of the same program supersedes; only runs that ended in the last 6 h) | `run:<task>:<endedAt>` | the run is `done` / running again / retrying, or the program's newest run is `done` |
| `run-stuck` | sweep: a background task `running` with no activity for `stuckRunMinutes` (a run parked on an open decision is waiting, not stuck). It is aborted through the Stop path (in-flight tools get `Interrupted:` results, ADR-0014) and never run again by itself | `stuck:<task>` | the task is `done`, queued or retrying, or shows new activity |
| `routine-paused` | `routine-service` `noticePaused` (max failures) and the `unrunnable` pause | `routine-paused:<id>:<run>` | the routine is not paused any more |
| `approval-expired` | `gateway.expireApprovals` through `onApprovalExpired` | `approval:<id>` | manual Ack |
| `connection-broken` | sweep over `connectors.connections()`, plus Telegram bot and Telegram user `onNeedsAuth` | `connection:<id>:<n>` (a recurring incident: none while one is open) | the connection is `connected` |
| `system` | `raiseSystemAlarm(step, error)`: logs a warning and alarms once per step and local day. Used by `main.ts` (providers load, connectors startup, reconcile, queued-task dispatch, health scan, repair of program authorities, decision announcement) and the Telegram services (`problem`) | `system:<step>:<day>` | manual Ack |

The sweep (`sweepAlarms`, every minute, `alarms.everyMs`) also clears alarms whose cause is gone
(acknowledged as `auto`; the record stays) and delivers what waits.

## Delivery

One alarm per incident (unique key). `deliverAlarms` sends one message with every alarm that is due:
a subject that got a message in the last 10 minutes waits and goes out later in one batch ("N things
need attention", at most 8 lines). Destination: the owners of the people directory, in their direct
chat, through the channels outbox (`notifyOwners`, first connection that reaches each owner). No
owner, no linked account, no transport or a failing push: the bell (`alarm:<id>` notification, the
first sentence as the title). Acknowledging removes the bell entry. `deliveredAt` is set either way.

## Supervisor

`app/supervisor.ts` reads the unacknowledged alarms: a failed run that has one keeps its retry
verdict but is marked "the owner already has an alarm" (do not ask the same thing again); a stuck run
or a broken connection with an alarm is not listed again.

## Swallowed errors

`main.ts` and the Telegram services no longer drop failures with `.catch(() => undefined)`: a logged
warning and a `system` alarm. Kept silent on purpose (commented): teardown in `close()` and `halt()`,
the best-effort dialog refresh and the stop of a backfill job while an account is dropped.

## Tests

`test/alarms.test.ts` (one alarm per incident, dedupe, rate limit and batch, stuck-run interrupt, Ack,
auto-clear, delivery fallback, supervisor overlap), `test/alarms-channels.test.ts` (owner DM through the
gateway, approval expiry), `web/src/lib/health/model.test.ts`.

## Open questions

- Per-program run timeouts do not exist (the budget has no time limit), so "stuck" uses the setting
  only. A per-program limit would be a program field.
- A run stopped as stuck ends `stopped` (the Stop path), not `interrupted`.
- The `stuckRunMinutes` setting has no input on the Settings page yet (PATCH `/settings` works).
- Approvals of web-only runs (program, routine, task, heartbeat) never expire by themselves; the
  existing `approval-waiting` health finding covers them. Only chat approvals expire.
