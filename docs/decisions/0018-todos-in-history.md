# ADR-0018: Todos live in the conversation, reminders are volatile

Status: **Accepted** · Date: 2026-09-30

## Context

A todo list keeps long tasks on track (Manus "recitation", Anthropic's long-running harness
guidance). Implementations differ on where the list lives: Codex re-reads it from the last
`update_plan` call, opencode and Claude Code keep a side store, Cline a file. Side stores go stale on
branching — Cline restores a checkpoint but keeps the newer todo file (issue #6578). A fork of
opencode put the live list in the system prompt and broke the prompt cache on every update. Plugins
that force continuation while todos are open loop forever without a progress check (opencode
#7187).

## Decision

- The list is the input of the last successful `todo_write` on the current branch (read from the
  wire), plus a `data-todos.list` part for UIs. Plugin state only carries it across compaction.
- Reminders are step reminders (volatile, trailing), never instructions.
- Enforcement is opt-in and stops when a nudge changed neither the list nor produced new tool
  results; the core's idle-continuation rule (ADR-0015) is the backstop.
- Shipped as `eharness/todos`, public API only.

## Consequences

+ Correct under regenerate/edit/rewind without extra bookkeeping; prompt-cache friendly.
+ Cannot loop without progress.
− After a compaction plus a rewind behind the marker the carried list can be stale.
− Shared lists across subagents (Claude Code Tasks) are not covered.

## Alternatives considered

- Store keyed by session (rejected: stale on branching).
- List in the system prompt (rejected: cache busting).
- File in the virtual filesystem (rejected: needs the filesystem plugin, same branching problem).
