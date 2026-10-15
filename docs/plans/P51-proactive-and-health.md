# P51 — Proactive heartbeat and agent health

Status: done · Owner: agent

## Goal

Agents act on what they observe without rigid schedules, and the system notices its own problems
before people do. Team example only (no library change).

## Checklist

- [x] Heartbeat: an empty checklist is shown as "does nothing" with an editor and a suggestion
- [x] Heartbeat reads channels (read-only tools); modes `off` / `notes` / `speak`; `reportTo` (may be
      the observed chat), `maxPostsPerDay`, repeat check, posts through the proactive policy
- [x] Observation notes: append-only `/library/notes/heartbeat/<agent>/<day>.md` (`heartbeat_note`)
- [x] Beat decisions `note` / `say` / `escalate` with a reason, shown in the beat log; speak rubric
- [x] Early beats on chat activity (`wakeOnActivity`, `minGapMinutes`); no new activity, no call
- [x] Without a lead agent the digest still runs and urgent findings reach the owners
- [x] Health page: detectors for repeated denials, tool loops, repeated errors, waiting approvals,
      token spikes, oversized outputs, failed or partial runs, provider errors; bell once per finding
- [x] Program authority suggestions in the Decision Center from repeated denials
- [x] The daily digest lists open health findings

## Open questions

- Routes have no owner/admin role check (the app has one trust level).
- The activity-wake debounce is per process.
