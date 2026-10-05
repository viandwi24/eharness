# ADR-0022: Memory on FileSystem; provider memory tools are app-supplied

Status: **Proposed** · Date: 2026-10-05

## Context

Agents that work across conversations need long-term memory: what a user prefers, what was
decided, how far a long task got. Every harness re-implements it — a vector store, a key-value
"facts" table, or plain files the model reads and edits (Anthropic's memory tool,
`memory_20250818`; Claude Code's `CLAUDE.md`; Manus's file-based context). Multi-tenant
applications additionally need namespaces (per user, contact, organisation) and must decide who
may read whose memory. Putting memory text into the system prompt breaks the prompt cache for
every user (ADR-0013).

## Decision

- **Files on the `FileSystem` service** (spec 08). Memory is a set of small text files under
  application-chosen **roots** (`roots(ctx)`, resolved once per turn, each read-only or
  writable). No new storage contract: any `FileSystem` adapter (Postgres, S3, a sandbox disk)
  stores memory, and conformance already exists. Files are inspectable and editable by humans.
- **The Anthropic command contract.** Commands `view`, `create`, `str_replace`, `insert`,
  `delete`, `rename` with the exact input shape of `memory_20250818`. Models are trained on it;
  the six `memory_*` tools mirror it, and the same executor (`executeMemoryCommand`) runs a
  provider-defined memory tool unchanged.
- **Provider tools are app-supplied.** The `tool` option receives the bound executor and returns
  any `Tool` (e.g. `(execute) => anthropic.tools.memory_20250818({ execute })`). eharness takes
  no dependency on `@ai-sdk/anthropic` (rule 10) and stays provider-neutral.
- **`onWrite` is a plugin option, not a core hook.** Core hook names are a closed set (spec 01
  §5, §7); an audit callback that only this plugin can fire belongs to its options. Its errors
  are `W_HOOK_FAILED` and never change the tool result.
- **Volatile context in the turn reminder.** Roots and pinned file contents differ per user, so
  they go into a turn-refresh instruction (turn reminder). The protocol instruction and the tool
  definitions are identical for every user and turn.
- **Optimistic concurrency, no read-before-write.** Every command re-reads the file and writes
  with `ifVersion`; a concurrent writer yields `CONFLICT:`. Renames use the new optional atomic
  `FileSystem.move` and fall back to write + delete.
- Shipped as `eharness/memory`, public API only (ADR-0008); the `FileSystem` contract is mirrored
  structurally (`MemoryFileSystem`), as `eharness/testing` does.

## Consequences

+ Works with every existing `FileSystem` adapter; memory is plain, auditable text.
+ Prompt-cache safe: tools and block 1 are byte-identical across users.
+ The application owns access control completely (roots), and the audit trail (`onWrite`).
− No semantic search over memory; large memories must be organised by the model (or an app
  tool). A vector index is an application concern.
− The rename fallback without `move` is not atomic (a failure after the copy removes it again,
  best effort).
− `flushOnCompaction` (memory writes before a compaction) waits for the pre-compaction flush API
  of P15.

## Alternatives considered

- A dedicated `MemoryStore` contract (rejected: duplicates `FileSystem`, new adapters for users).
- Memory in the system prompt (rejected: busts the prompt cache per user, ADR-0013).
- Depending on `@ai-sdk/anthropic` for the provider tool (rejected: rule 10, provider lock-in).
- A core `memory.write` hook (rejected: the hook list is closed; only this plugin fires it).
