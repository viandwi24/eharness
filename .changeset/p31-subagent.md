---
"eharness": minor
---

New subpath `eharness/subagent`: the `subagents()` plugin (the `agent` tool) and nested approvals.

- **`subagents({ agents, approvals, answer?, policy?, maxDepth?, maxConcurrent?, background?, childSessionId?, timeoutMs?, parentAgent? })`** runs a subagent as a child session: progress as preliminary outputs (`SubagentProgress`), child usage and cost added to the parent turn, a depth limit, a per-depth concurrency cap, abort propagation, the persisted `data-subagent.run` part (`{ toolCallId, sessionId, agent, status }`), and `run_in_background` (the report is injected as an `eh.event` with `wake: true`).
- **Approval strategies** for the child (ADR-0034, ADR-0035): `'inline'` (an `answer` callback in process), `'policy'` (`'deny'` or `'approve'`, no human) and `'park'` (the parent parks as an external wait; the app answers the child session from any instance, the child's `turn.end` hook resolves the parent's wait).
- **`subagentChild({ parent })`** (the hook for child agents of a `'park'` parent), **`pendingSubagentApprovals(session, agent)`** (child sessions with pending approvals, for a web UI) and **`subagentWaitId()`**.
- Contract: spec 20; guide: `docs/guides/subagents.md`.
