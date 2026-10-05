---
"eharness": minor
---

Context pruning, compaction thrash detection and skill versions (0.4.0).

- New `compaction.prune` (off by default; `{}` turns it on with `keepTurns: 2`, `minChars: 2_000`): view-only pruning of old tool outputs before summarizing. Tool outputs of completed turns older than `keepTurns` and larger than `minChars` are replaced in the request by `TOOL_OUTPUT_PRUNED` (`[output of <tool> pruned: <n> chars]`) or a pure `replaceWith(part: ToolResultPart)`; `exclude` lists tools never pruned. Stored messages never change, errors and denials are never pruned, tool calls keep their results. The summarizer runs only if the pruned context is still above `summarizeAt`. `ContextStats` gains `pruned?: { outputs, chars }`. New exports: `PruneConfig`, `TOOL_OUTPUT_PRUNED`.
