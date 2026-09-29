# Prior art and lessons learned

## The predecessor harness (internal, production)

eharness generalises an internal harness that ran a production coding agent (virtual filesystem,
Postgres sessions, plugins). What it proved, and how eharness keeps or changes it:

| Proven there | In eharness |
|---|---|
| Manual loop, one `streamText` per step | Kept (ADR-0002) |
| "Harness is dumb": model + prompt + tools carry intelligence | Kept (concept.md) |
| Everything dynamic is injected (model, prompt, tools, storage) | Generalised into plugins + static/dynamic registry |
| Compaction: prune + summarize, flat-text transcript for the summarizer (raw tool markup made some providers continue the markup) | Kept as the fixed algorithm (spec 06) |
| `sanitizeMessages` after compaction (orphan tool calls rejected by providers) | Kept as the always-on guard |
| Working history vs full append-only log | Kept: stored history is never rewritten; model context is a projection |
| File tools: return errors as strings, read-before-edit, content-hash versions, STALE with fresh content, smart replace cascade, optimistic lock | Kept verbatim in the filesystem plugin (spec 08) |
| Skills in a store separate from the workspace, opened with `read_skill` | Kept; generalised to `SkillSource` with relative addressing (spec 07) |
| Tool-emitted custom data parts via a per-turn `emit` | Replaced by namespaced `ctx.stream` + declared data parts (spec 04) |
| `attach()`: snapshot + live events for reconnect | Kept as `session.attach()` replaying the turn buffer |
| Fail-fast merge of tool/command names at boot | Kept (boot validation) |
| Loop guard with auditor at step checkpoints | Deferred to a plugin (roadmap) |

What we changed on purpose:

- **Own event and turn types** (`Part`, `Turn`, `AgentEvent`) and converters → replaced by
  `UIMessage` + UI message stream everywhere (ADR-0001, ADR-0003).
- **Storage adapter abstraction built too early** in another predecessor added complexity →
  eharness ships memory adapters only and two-method contracts (ADR-0004, ADR-0008).
- **Session snapshot blobs** → per-message upserts + small state object.
- **Web UI as an extension of core** created tangled dependencies → core is headless; UIs consume
  the stream.

## Other frameworks studied (2026-09)

| Project | Idea we borrowed | Idea we avoided |
|---|---|---|
| AI SDK Harnesses (`HarnessAgent`) | session `detach/stop/suspendTurn` semantics; settings fixed per turn; skills as `{ name, description, content, files }`; secrets (`toolsContext`) never persisted | wrapping external runtimes (different layer) |
| eve (Vercel) | skills vs subagents distinction; channels as entry points | filesystem-first discovery, platform-coupled durability |
| Mastra workspaces | filesystem provider per request (resolver); skills discovered from any filesystem provider; custom skill source | framework-sized surface |
| LangChain Deep Agents | pluggable filesystem backends; composite routing (`/memories/` persistent); evicting large tool results to files | LangGraph runtime dependency |
| OpenCode plugins | plugin = function returning hooks; `tool.execute.before/after`; compaction prompt hook | global event bus as the only extension mechanism |
