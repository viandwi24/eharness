---
"eharness": minor
---

Gaps found by the team example. `agent.peek(sessionId)` is a side-effect-free read handle (messages, stats, busy, pending state, children, parent) that runs no `session.start` hook, recovery or reconcile (spec 05 §2.2). `ParentInfo` / `ChildSessionInfo` carry the child's `agent`, `name` and `description` (index entries without them still read), also returned by `pendingSubagentApprovals`. `subagents({ childSession, parentSession })` and `subagentChild({ parentSession })` pass session options (`lock`, `runtime`, `storage`) to the sessions the plugin opens, and `subagents({ maxChildren })` caps the children a session may start. The plugin's own reads of child and parent sessions now use `peek`. See spec 20 §2.3–2.4.
