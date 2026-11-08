---
"eharness": minor
---

Add the subpath `eharness/codes`, which exports `STOP_REASONS`, `NOTICE_CODES` and the types `KnownStopReason` and `NoticeCode` (the same objects the package root exports). A UI that talks to a core over HTTP (the Keith TUI) renders `eh.notice` messages and stop reasons, and had to re-type the code strings by hand because the constants were only reachable from the root, which pulls the whole runtime; `eharness/client` may not re-export them (ADR-0059). The new entry imports nothing at runtime (ADR-0072).
