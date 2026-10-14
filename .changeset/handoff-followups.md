---
"eharness": minor
---

`eharness/handoff` (draft): `resolveHandoff` takes `output`, `resume` and `metadata`; a losing answer no longer re-delivers (use the new `redeliverHandoff` for crash recovery); `HandoffStore.answer` takes `extras.metadata`, applied in the same compare-and-set; new `startHandoff` building block for apps with their own `externalTool()`.
