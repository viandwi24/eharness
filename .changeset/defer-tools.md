---
"eharness": minor
---

`defer tools by name`: new agent config `deferTools: string[]` hides the named app, plugin or source tools until the model finds them with `tool_search` (spec 02 §3.3). When any tool is deferred, the core adds a turn reminder (`core:tools`) that lists the deferred tools by name with a one-line description, so the model knows they exist. Deferred tools no longer count toward `session.stats()` token totals (`session.tools()` still reports their size).
