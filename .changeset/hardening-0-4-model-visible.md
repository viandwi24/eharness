---
"eharness": minor
---

Model-visible changes of the 0.4.0 hardening (what the model reads or may send changes):

- `read_file` (`eharness/filesystem`) gains the input `charOffset` (character offset inside the first line of the window). A line longer than the window now ends with `(Line <n> continues; use offset=<n> charOffset=<c>.)` instead of the "Showing lines" hint, so very long lines (minified code, evicted single-line JSON outputs) are fully readable.
- `grep`: a line cut at 300 characters ends with ` (match at charOffset=<c>)`; patterns with nested quantifiers or backreferences, or longer than 512 characters, are refused with `ERROR: invalid pattern: …` (no catastrophic backtracking); only the first 10 000 characters of a line are matched. Adapters that push `grep` down should apply the same limits or use a linear-time engine (RE2).
- A file of an earlier turn whose URL can no longer be downloaded (e.g. an expired link) is replaced on the wire by the new fixed text `FILE_UNAVAILABLE` (`[file unavailable: <mediaType> <filename>]`) and the step is retried, instead of failing every later turn.
- A compaction summary cut at `maxSummaryTokens` (`finishReason: 'length'`) is no longer used: it is a compaction failure (`W_COMPACTION_FAILED` / `EH_COMPACTION_FAILED` with `details.reason: 'length'`).
