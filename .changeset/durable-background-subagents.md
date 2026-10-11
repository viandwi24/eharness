---
"eharness": minor
---

Durable background subagents in `approvals: 'park'` mode (ADR-0046). `subagent({ approvals: 'park', background })` no longer throws: `run_in_background: true` (or `background.default`) starts the child through its durable inbox and answers the parent's call at once, so the lead stays free to chat and a new user message no longer cancels the delegation. The child's report (and a status event when it waits for a person) reaches the lead as an `eh.event` through storage, from whichever instance finishes the child. `data-subagent.run` is now written for every park call (with the child session id, `background` flag), `agent_output` / `agent_stop` / `send_message` work on these children, `maxConcurrent` is counted from the stored child index, and `subagentChild()` gains `maxReportChars` / `outputToolName`. See spec 20 §3.5.
