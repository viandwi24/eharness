---
"eharness": patch
---

A foreground `approvals: 'park'` subagent whose parent call was cancelled by a new user message (or answered `Interrupted:`) now reports to the lead when it finishes, like a durable background child (`eh.event` `subagent`, woken), instead of finishing silently. See spec 20 §3.5, ADR-0046.
