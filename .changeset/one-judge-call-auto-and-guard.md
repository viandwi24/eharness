---
"eharness": minor
---

One judge call when permissions auto mode and `guard()` are both active (ADR-0060 amendment, spec 15 §7, spec 18 §12): with the same judge model and view limits, the auto classifier answers the guard's policy in its own call (`{ auto, guard }` verdict) and the guard records its half without a second model call; outcomes are unchanged (most restrictive wins). New core `judgeCoordinator(scope)` and the `JudgeParticipant`/`JudgeCoordinator` types (Draft), `Judge.combinable`/`cachedVerdict`/`limits`, `JudgeContext.alongside`/`precomputed`, `AutoClassifierContext.coordinator`/`toolCallId`/`risk`, and `guard({ combineWithAutoMode })` (default `true`; `false` keeps two calls).
