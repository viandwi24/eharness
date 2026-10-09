---
"eharness": minor
---

`eharness/permissions`: `auto` permission mode (P31).

- `PermissionMode` gains `'auto'`; the engine option `classifier: AutoClassifier` decides the calls no rule or read-only check settles (allow, or block with a reason the model reads; a failing classifier blocks). `engine.decideAsync()` runs it, `decide()` stays sync and marks such calls `auto: 'classify'`. Without a classifier `setMode('auto')` throws `EH_CONFIG_INVALID`.
- Repeated blocks (3 in a row, 20 in total) pause auto mode until a person approves an action: `autoState()`, `subscribeAuto()`, `noteApproval()`, `resumeAuto()`.
- `modelClassifier({ model, instructions?, environment?, ... })` (AI SDK `generateText` with structured output) and `AUTO_CLASSIFIER_INSTRUCTIONS`.
- `modeCycleFor({ bypass, auto })` slots `bypassPermissions` then `auto` after `plan`.
- `permissionsPlugin` awaits the classifier in `tool.approve` and resumes auto mode on a person's approval.
