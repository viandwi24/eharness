---
"eharness": minor
---

Two permissions/judge changes.

**Recursive reads (`eharness/permissions`, `eharness/filesystem/node`).** New optional engine option `containsProtected(realDir, patterns)` and a Node implementation `nodeContainsProtected` (bounded breadth-first walk: 32 levels, 50 000 entries, 2 s; fail closed; never follows symlinks). With it, `decideAsync` looks into every directory a command reads recursively (`grep -r/-R`, `rg`, `ag`/`ack`, `find -exec`, `cp -r`, `rsync -r`, `tar`, `zip -r`) and asks when a built-in ask path (`.env*`) or protected path (`.git` by default) is below it, or denies when a `Read` deny rule matches there. Without the option behaviour is unchanged (lexical). Wire it next to `realpath: nodeRealpath`. With the default `protectedPaths`, a recursive `grep -r` from a repository root now asks when the option is set.

**One judge input limit (breaking, Draft).** `guard()` and `modelClassifier()` now both expose `maxCallChars`, the longest call input that is judged (longer asks a person), with one default, `DEFAULT_JUDGE_MAX_CALL_CHARS` = 8 000 (new core export; the judge's own default moves from 4 000 to it). Transcript limits stay separate (`transcript.maxChars` / `maxContext.maxChars`). Behaviour changes: the guard no longer takes the call limit from `transcript.maxChars` (it was 12 000 by default; set `maxCallChars: 12_000` to keep it), and `modelClassifier()`'s fixed 4 000 becomes 8 000 and configurable.
