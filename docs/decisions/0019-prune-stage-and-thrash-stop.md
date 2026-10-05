# ADR-0019: Prune stage and thrash stop

Status: **Proposed** · Date: 2026-10-05 · Amends ADR-0004

## Context

Tool-heavy agents fill the context with large tool outputs (file reads, search results, command
logs) that matter for a few turns and then only take space. Summarizing is the only way 0.3 frees
that space: it costs a model call, loses detail, and rewrites the prompt prefix. Other harnesses
(opencode, Claude Code) first *prune* old tool outputs — replace them by a short placeholder — and
summarize only when that is not enough.

A second failure mode: a turn whose context refills right after a compaction (a single step that
reads huge outputs, a summary that is barely smaller than what it replaced) compacts again and
again, burning money without progress — the same problem the progress guard solves for repeated
tool calls (ADR-0015).

## Decision

- **Prune is a setting of the fixed algorithm, not a strategy** (ADR-0004 stays: one algorithm,
  a few knobs). `compaction.prune` (off by default) replaces the output of `tool-result` parts of
  completed turns older than `keepTurns` and larger than `minChars` with a placeholder
  (`TOOL_OUTPUT_PRUNED` or a pure `replaceWith(part: ToolResultPart)`, AI SDK type, ADR-0001).
- **View-only and deterministic.** Prune runs when the turn wire is built (spec 06 §6); storage
  and UI history never change. The decision depends only on turn distance, size and tool name,
  so the same view gives the same wire and the prompt prefix changes at most once per turn
  (ADR-0013). Pairs stay intact: only outputs change; errors and denials are never pruned.
- **Prune before summarize.** Triggers and the skip rule measure the pruned wire; the summarizer
  runs only when the context is still above `summarizeAt`. The summarizer transcript keeps the
  original (capped) outputs: the summary is where information is condensed.
- **Thrash stop.** When a second automatic (mid-turn or overflow) compaction within
  `compaction.thrash.withinSteps` (default 2) model steps of the previous one ran (or was skipped
  as no-gain) and the context is still above `summarizeAt` afterwards, the turn stops with the new
  stop reason `'context-thrash'` (`W_CONTEXT_THRASH`, an `eh.notice` with code
  `EH_CONTEXT_THRASH`). The check runs after the compaction, not before it; pre-turn compactions
  do not start the window, so ordinary turns (compact at turn start, then one large tool output)
  behave as in 0.3. `thrash: false` restores 0.3 behaviour.
  *Amended in the 0.4.0 review:* the first version stopped whenever the context was above
  `summarizeAt` within the window (counting a pre-turn compaction as step 0) before compacting,
  which stopped ordinary turns that 0.3 completed.

## Consequences

+ Tool-heavy sessions reach the summarizer later or never; fewer summarizer calls, more verbatim
  recent context.
+ Prompt cache stays warm inside a turn; across turns one cache break per aged turn.
+ A thrashing turn stops after at most one compaction with a clear reason.
− Pruned outputs are gone for the model (it can re-run the tool); the placeholder says so.
− Thrash on by default is a behaviour change in a minor (0.x); the changeset calls it out.
− `StopReason` gains a member: exhaustive `switch` statements must add a case.

## Alternatives considered

- A pluggable `ContextStrategy` with a prune phase (rejected again: ADR-0004).
- Pruning by token distance inside the current turn (opencode): changes the prefix every step;
  out of scope, roadmap candidate.
- Pruning in storage (rewrite old messages): breaks history for UIs and audits (spec 06 §8).
- Thrash off by default: safer for 0.3 users, but repeated compaction in one turn has no upside.
