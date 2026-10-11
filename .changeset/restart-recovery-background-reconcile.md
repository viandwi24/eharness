---
"eharness": minor
---

Restart recovery and background-child reliability (ADR-0056). `recovery.instanceId` (stable owner id: a restarted process recovers its own orphaned turns at once instead of after `staleMs`), `session.recover()` (repair an interrupted turn at boot; open text parts are closed too), `inject({ key })` (idempotent kind messages) and `reconcileBackgroundChildren` from `eharness/subagent` (delivers missing reports of ended / crashed / never-started / timed-out children and one reminder for children waiting for a person; new `background.timeoutMs`, `stopOnTimeout`, `startGraceMs`, `waitingReminderMs`, `reconcileEveryMs`). Report events carry `data.turnId` and new `data.status` values `interrupted`, `timed_out`, `not_started`; the hook retries delivery.
