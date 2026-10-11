---
"eharness": minor
---

`subagent({ approvals: 'park' })` now offers `send_message`, the `name` field of `agent`, `agent_output` and `agent_stop`. The agent directory is rebuilt from storage (`selfAgent`), messages travel over the durable inbox (`child.enqueue`, steer for a running child, a new turn for a finished one, `main` through `parentAgent`), and the report of a resumed child is enqueued into its launcher through storage. See ADR-0041 and spec 20 §5.9.
