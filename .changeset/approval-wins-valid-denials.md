---
"eharness": patch
---

Fix a stored message being dropped (`W_INVALID_MESSAGE`) after a person approved a call that the re-validation of the `respond()` continuation then denied: `output-denied` tool parts now always have `approval.approved: false` (persistence, projection), and cold load repairs the known inconsistency with `W_REPAIRED_MESSAGE` instead of dropping the message. In `auto` mode a call a person approved is never classified again (`noteApproval(toolCallId)`, called by the permissions plugin), so the classifier cannot overrule an approval.

`modelClassifier` now sends `maxOutputTokens` (default `DEFAULT_CLASSIFIER_MAX_OUTPUT_TOKENS` = 1024) and `temperature` 0 (both configurable), and throws `ClassifierUnavailableError` when the judge could not run: the action is still denied (`auto: 'unavailable'`, `unavailable` auto event) but no longer counts as a block towards the repeated-blocks pause. See ADR-0055, spec 03 §6-7, spec 18 §12.

New in `eharness/testing`: `schemaCheckedMessages(adapter)` / `assertValidUIMessage(message)` fail a save of a schema-invalid `UIMessage`.
