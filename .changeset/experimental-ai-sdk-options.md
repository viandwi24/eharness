---
"eharness": patch
---

`approval.secret` and the `tool.before` hook are marked `@experimental`: they rely on the AI SDK options `experimental_toolApprovalSecret` and `experimental_refineToolInput`. A contract test and a CI job against `ai@latest` and the lowest supported `zod` now catch an upstream rename.
