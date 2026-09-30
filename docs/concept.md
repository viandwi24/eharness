# Concept

## One line

**eharness is a thin, idiomatic layer on top of AI SDK v7 that gives every agent harness the same
skeleton — plugins, context, messages, streaming, sessions, compaction — while letting the
developer plug in any storage, filesystem or infrastructure.**

## The problem

Every project that builds a serious agent on AI SDK ends up writing the same things again:

- a step loop around `streamText` with stop conditions, progress checks and cost caps,
- model limits and prices, to compact in time and to stop before the bill gets out of hand,
- system-prompt assembly from many sources,
- tools that need per-session state (files read, versions, credentials),
- skills (`SKILL.md` folders) and on-demand loading,
- MCP client lifecycle,
- a message history that survives restarts and gets compacted when it grows,
- a UI stream with custom data parts that the frontend can render,
- a way to extend all of the above without forking the core.

AI SDK gives excellent primitives (`streamText`, `tool()`, `UIMessage`, `createUIMessageStream`,
`toolSearch`, `@ai-sdk/mcp`). It deliberately does **not** give you the harness around them. AI SDK
**Harnesses** (`HarnessAgent`) solve a different problem: they *wrap existing harnesses* (Claude
Code, Codex, OpenCode, Pi, …) behind one surface. eharness is for building **your own** harness.

## Positioning

| | What it is | Relation to eharness |
|---|---|---|
| AI SDK core (`ai`) | Model calls, tools, streams, UI messages | eharness is built directly on it; no parallel types |
| AI SDK Harnesses (`@ai-sdk/harness`) | Adapter layer to run *existing* harness runtimes in a sandbox | Different layer. An eharness agent could later be exposed as a harness adapter |
| eve (Vercel) | Filesystem-first, opinionated agent framework with Vercel-native durability | eharness is code-first, unopinionated about infra, and much thinner |
| Mastra | Full framework (workspaces, memory, workflows, deployment) | eharness is a library, not a framework; borrow ideas (filesystem providers, resolver per request) |
| LangChain Deep Agents | Harness on LangGraph with pluggable filesystem backends | Similar ideas (backends, composite routing); eharness has no graph runtime dependency |

## What eharness is

- A **library** (`eharness` on npm), ESM-only, runs on Node ≥ 22 and Bun.
- A **skeleton**: core runtime + contracts + small reference plugins (`filesystem` with a memory
  adapter, `todos`) + an MCP tool source + memory storage adapters + conformance test suites.
- **Idiomatic AI SDK**: the stream is the AI SDK UI message stream; messages are `UIMessage`;
  tools are `tool()`; models are `LanguageModel`.
- **Adapter-driven where it matters**: message storage, session state, filesystems and skill
  sources are small contracts the developer implements for their own infrastructure.

## What eharness is not

- Not a framework that owns your server, routes, auth, users or chat list. It only knows
  `sessionId: string`.
- Not a storage product. It ships memory adapters and examples; Postgres/JSON/S3 adapters are the
  developer's code (the contracts are two or three methods).
- Not a pricing service. It computes cost estimates from prices the application supplies (a record,
  a function or the models.dev database the app fetched); it never fetches anything itself.
- Not a sandbox/shell runtime (v0). Sandboxing is a future plugin built on the same service model.
- Not a replacement for AI SDK Harnesses or for eve.

## Principles

1. **Primitives over wrappers.** If AI SDK has it, use it as-is.
2. **Skeleton over completeness.** Ship the contract + one good example; let developers add adapters.
3. **Static and dynamic are both first-class.** Anything (instructions, tools, skills, MCP) can be
   declared as a `const` in code or resolved by a loader at runtime. The agent does not care which.
4. **Storage is the extension point, compaction is fixed.** Compaction strategies in the wild are
   few; storage backends are endless. One well-tested compaction algorithm, a two-method storage
   contract (ADR-0004).
5. **Everything the model sees is a projection of stored `UIMessage`s.** Custom messages and data
   parts declare how (or whether) they project to the model.
6. **Stored order is model order.** What the model saw is stored exactly where it saw it (steers,
   approvals, interrupted tool calls); nothing is silently dropped or reordered, so a reload
   projects the same conversation (ADR-0011, ADR-0014).
7. **The server owns decisions.** Clients send input and answers; ids, pending state and metadata
   are server-side, and every approval is consumed exactly once (ADR-0012).
8. **Fail fast at boot, degrade gracefully at runtime.** Static conflicts throw when the agent is
   defined; dynamic conflicts at runtime produce a warning and a deterministic winner.
9. **Harness stays dumb.** The loop is a pipe. Intelligence lives in the model, the prompt and the
   tools. Plugins add capability, not orchestration magic.

## Glossary

| Term | Meaning |
|---|---|
| **Agent** | The value returned by `defineHarnessAgent`. Configuration + plugins. No live state. |
| **Session** | A live conversation identified by `sessionId`. Owns message history and state. |
| **Turn** | One run of the loop started by `send`, `respond`, `regenerate`, `edit` or a wake: writes one assistant message (possibly many steps). A `respond()` turn continues the pending message instead of creating a new one. |
| **Step** | One model call inside a turn (one `streamText` call with one step). |
| **Plugin** | A bundle of capabilities (tools, skills, instructions, hooks, services, data parts, message kinds) created by `definePlugin`. |
| **Service** | A typed object a plugin provides to other plugins (e.g. `fs`). One provider per service name. |
| **Adapter** | An implementation of a contract (`MessageAdapter`, `StateAdapter`, `FileSystem`, `SkillSource`). |
| **Source / loader** | A dynamic provider of tools or skills, resolved at runtime. |
| **Data part** | A typed custom `UIMessage` part (`data-<name>`), declared in a registry. |
| **Message kind** | A custom *message* (not model-generated) stored as a `UIMessage` with one data part and `metadata.eharness.kind`, e.g. `eh.compaction`. |
| **Projection** | Converting stored `UIMessage`s into the `ModelMessage`s the model sees. |
| **Boundary** | A message kind that starts the model context (the latest compaction marker). |
| **Transient** | A data part sent to the client stream but never stored or projected. |
| **Pending** | A session whose last turn stopped with `tool-pending`: approvals or client tool calls wait for `respond()`. |
| **Approval** | A per-call decision (`approved` / `denied` / `user-approval`) made by policy, risk rules, hooks and grants before a tool runs; every decision is reported to `approval.decided`. |
| **Risk** | A tool's class in its AI SDK metadata (`read` / `write` / `destructive`) that `approval.risk` maps to an approval status. |
| **Model catalog** | `models`: context window, max output and prices per model, supplied by the app. |
| **Budget** | A USD limit per turn or session (`budget`); a turn that uses it up stops with `cost-cap`. |
| **Progress guard** | The loop check that stops a turn repeating the same call or failing over and over (`stuck`). |
| **Wrap-up** | One tool-less step after the step budget runs out, in which the model summarizes what is left. |
| **Continuation** | An extra step requested by a `turn.beforeEnd` hook; refused after idle continuations. |
| **Grant** | A session-scoped "always / never" answer for a tool, set by `respond(… remember: 'session')`. |
| **Steer** | Input sent while a turn runs, delivered at the next step boundary as a `data-eh.input` part. |
| **Wake** | Starting a no-input turn from background work with `inject(…, { wake: true })`. |
| **Rewind** | An `eh.rewind` marker that hides a range of history (regenerate, edit) without deleting it. |
| **Reminder** | Volatile text sent to the model as a `<system-reminder>` user message for one turn or step; never stored, keeps the cached prefix stable. |
| **Commit point** | The moment in a turn after which it has side effects; failures before it persist nothing. |
| **Recovery** | Repairing a turn whose process died (`stop: 'interrupted'`), on the next operation. |
