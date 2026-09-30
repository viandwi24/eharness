# Roadmap (after 0.1.0)

Not scheduled. Each item needs a spec (or spec change) and, where it changes a decision, an ADR
before implementation.

| Item | Notes |
|---|---|
| **Sandbox plugin** (`eharness/sandbox`) | Provides `fs` + `shell` services (conflicts with `filesystem` by design), shell tools, skill materialization via `skill.load` + `locate()`, driver contract (local, Docker, Vercel Sandbox via `@ai-sdk/sandbox-vercel`, AI SDK `experimental_sandbox`). |
| **Loop guard plugin** | Deterministic detection is in core since 0.2 (progress guard, spec 05 §3.2). Remaining: step checkpoints, optional cheap-model auditor. |
| **Subagents plugin** | Ready-made `subagent()` tool: child session with `SessionOptions.parent`, streamed progress via preliminary results, summary return, `addUsage`, depth limit. The core hooks exist in v0. |
| ~~Todos plugin~~ | Done in 0.2 (`eharness/todos`, spec 13). |
| **Code mode / cache-preserving tool discovery** | Support `@ai-sdk/code-mode` with `toolDiscovery: 'conversation'`. |
| **AI SDK `Agent` interface adapter** | `agent.asAgent(session)` implementing `agent-v1` so `createAgentUIStream` and `@ai-sdk/tui` work directly. |
| **HarnessAgent adapter** | Publish `@ai-sdk/harness`-compatible adapter so an eharness agent can run behind `HarnessAgent`. |
| **Binary files** in `FileSystem` | `readBytes` / `writeBytes`, media types, file parts to the model. |
| **Cross-process resumable streams** | Turn buffer adapter (Redis etc.) for `attach()` across instances. |
| **Durable execution** | Suspend/resume a turn across processes (continuation state without secrets), compatible with Workflow DevKit. |
| **Memory plugin** | Long-term memory tools on top of `FileSystem` (`/memories/`), optional provider-defined memory tools. |
| **Package split** | Only if an extension needs its own release cadence (ADR-0007). |
| **Fork** | `session.fork(atMessageId)` → new session id with a copied prefix (needs adapter support or a copy loop). |
| **Prune stage** | Cheap pre-compaction pruning of old tool outputs (opencode-style) before summarizing. |
| **Output guardrails** | Validate the final answer (schema, policy) and retry with feedback; builds on `turn.beforeEnd`. |
| ~~USD budget~~ | Done in 0.2 (spec 12). |
| **Immediate steer** | Interrupt the current model stream for urgent input instead of waiting for the step boundary. |
| **Cross-process queue / wake** | Queue and wake-up delivery across instances (via the application's job queue contract). |
| **Continuation replay on resume** | `attach()` of a `respond()` continuation replays the stored prefix so `useChat` resume needs no re-fetch. |
| **Partial approval answers** | `respond()` with a subset of pending approvals. |
| **Rule-based grants** | `remember` scoped to an input pattern (e.g. `bash: git *`) instead of a whole tool. |
| **Approval classifier guard** | `tool.approve` plugin with an LLM reviewer on a stripped transcript (user messages + tool calls), timeout and denial circuit breaker that fall back to a human. |
| **Goal plugin** | Outer loop: re-prompt after a turn until a goal is met (judge model or `update_goal` tool), paused after empty turns and by budgets. |
| **Compaction thrash detection** | Stop when the context is full again within ~2 steps after a compaction. |
| **Shared task lists** | Todos shared across subagents/sessions (`listId`, owners, dependencies). |
