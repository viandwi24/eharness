---
"eharness": patch
---

Subagent park mode: the parent of a finished child always continues. A continuation that could not start, or that failed before it stored anything (the session lock held by another instance, a storage failure), is retried with backoff for 15 minutes instead of being dropped silently; failed continuations are logged with the parent session id. `reconcileSubagentWaits()` now also continues a parent whose waits are all resolved but whose turn never continued.
