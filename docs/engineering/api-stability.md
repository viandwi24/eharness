# API stability

## What is public API

Everything a user can observe without reading our source:

1. Every symbol exported from `eharness` and its subpaths, including types:

   | Subpath | Stability | Since | Notes |
   |---|---|---|---|
   | `eharness` | Accepted (specs 01-11) | 0.1 | core; the model catalog and cost (spec 12), `createJudge` and `observe` are Draft |
   | `eharness/filesystem`, `eharness/filesystem/memory` | Accepted (spec 08) | 0.1 | `projectInstructions()` is Draft |
   | `eharness/filesystem/node` | Accepted | 0.7 | Node-only (ADR-0036) |
   | `eharness/storage/memory` | Accepted (spec 05) | 0.1 | |
   | `eharness/mcp` | Accepted (spec 09) | 0.1 | optional peer `@ai-sdk/mcp` |
   | `eharness/todos` | Draft | 0.3 | spec 13 |
   | `eharness/memory` | Draft | 0.4 | spec 14 |
   | `eharness/guard`, `eharness/group`, `eharness/openapi` | Deprecated (ADR-0062) | 0.5 | specs 15-17; removed at 1.0 unless a product adopts them |
   | `eharness/permissions`, `eharness/subagent`, `eharness/ask`, `eharness/web` | Draft | 0.7 | specs 18, 20-22 |
   | `eharness/shell` | Draft | 0.7 | spec 19; Node-only (ADR-0036) |
   | `eharness/code` | Draft | 0.9 | spec 28; runtime-neutral |
| `eharness/scheduler`, `eharness/identity`, `eharness/channels`, `eharness/handoff` | Draft | 0.9 | specs 29-32; ADR-0062, 0063 |
| `eharness/limits`, `eharness/clock` | Draft | 0.9 | specs 33-34 |
| `eharness/browser`, `eharness/browser/node` | Draft | 0.9 | spec 35, ADR-0064; `browser/node` is Node-only (ADR-0036) |
   | `eharness/web/node` | Draft | 0.8 | `nodeResolveHost` for `webFetch`; Node-only (ADR-0036) |
   | `eharness/providers` | Draft | 0.8 | spec 23 |
   | `eharness/connectors` | Draft | 0.8 | spec 24 |
   | `eharness/activity` | Draft | 0.8 | spec 25 |
   | `eharness/http` | Draft | 0.8 | spec 26 |
   | `eharness/client`, `eharness/client/react` | Draft | 0.8 | spec 27; imports only `ai` at runtime |
   | `eharness/testing` | Accepted | 0.1 | conformance suites and mocks; new suites arrive with the module they test |
2. **Persisted formats:** `metadata.eharness`, core data part types and payloads (`eh.*`),
   core message kinds and payloads, `SessionStateSnapshot`, plugin data parts of shipped plugins.
3. **Stream shape:** order and types of chunks the core writes (spec 04 §2).
4. **Model-visible text** of built-in tools (names, input schemas, result prefixes such as
   `STALE:`), the skills index block, the compaction marker projection.
5. Error and warning codes, stop reasons.
6. Hook names and the order in which they run.
7. Adapter contracts (`MessageAdapter`, `StateAdapter`, `InboxAdapter`, `FileSystem`, `SkillSource`,
   `ToolSource`, `SessionLock`).

Not public: anything under `src/internal`, the wording of instruction, nudge and preamble texts
(progress nudges, the structured-output instruction, the guard prompt, plugin protocol prompts; the
*structure* is public and options such as `instructions`, `reminder` and `preamble` override the
default), log messages, performance characteristics. These texts, and implementation helpers, are
**not exported** from the package. Result texts that land in stored messages or tool results and
that a UI may need to recognise (`INTERRUPTED_*`, `DENIED_NEW_INPUT`, `WAIT_TIMED_OUT`,
`TOOL_OUTPUT_TRUNCATED`, the `GUARD_*` denial reasons, …) are exported constants and public:
changing one is a minor change.

The proposed 1.0 classification of every export (stable / experimental / internal-candidate) is in
[stability-1.0.md](stability-1.0.md); error and warning codes are mapped in [errors.md](errors.md).

### The export snapshot

The runtime export list of every entry point is a committed snapshot
(`scripts/exports.snapshot.json`), derived from `package.json#exports`. `bun test`, the Node smoke
test and `check:package` compare the real exports with it, so every addition or removal is a
reviewed diff (`bun scripts/exports-snapshot.ts --write` regenerates it; testing.md). The public
surface is plugin factories and option types, ports and adapters, tool-name constants, stored-text
constants and documented helpers. An implementation helper that only a shipped plugin needs is
shared through an internal module, not exported; if users need it, document it first, then export it.

## Semver policy

| Version range | Change | Bump | Notes |
|---|---|---|---|
| `0.x` (now) | breaking | **minor** (`0.2.0 → 0.3.0`) | npm caret `^0.2.0` does not cross minors, so users are safe |
| `0.x` | new feature (subpath, option, hook, method) | **minor** | the repository has always released features as minors (see `CHANGELOG.md`) |
| `0.x` | bug fix, wording tweak | patch | never breaking |
| `≥ 1.0` | breaking / feature / fix | major / minor / patch | standard semver |

Additionally:

- A new **AI SDK major** (`ai@8`) requires a new eharness breaking release, even if our code does
  not change, because `ai` is a peer dependency.
- Changing a **persisted format** incompatibly is breaking *and* must ship an upgrader (`upgrade`
  on the data part / kind, or a `metadata.eharness.v` migration).
- Changing **model-visible text** of built-in tools is a minor change in 0.x (behavioural), a
  major after 1.0 if it changes names/schemas; wording tweaks are patch-level with a changeset note.

## Experimental API

- Named with an `experimental_` prefix and marked `@experimental` in TSDoc.
- May change or disappear in any minor release (and patch in 0.x). Changeset must mention it.
- Graduating removes the prefix; the prefixed alias stays as deprecated for one minor.

### Experimental dependencies on the AI SDK

Two of our features sit on AI SDK options that are still `experimental_` upstream. They are marked
`@experimental` in TSDoc and may change in any release if `ai` renames them:

| eharness | AI SDK option |
|---|---|
| `approval.secret` (agent config) | `experimental_toolApprovalSecret` |
| the `tool.before` hook | `experimental_refineToolInput` |

`src/ai-sdk-experimental.test.ts` asserts that both options take effect, and the `compat` CI job
runs the suite against `ai@latest` and the lowest supported `zod`, so an upstream rename fails CI
before users see it.

## Draft modules and sections

A spec marked **Draft** is public but not settled: its API, model-visible texts and persisted
payloads may change in a **minor** release in 0.x (never in a patch), with a changeset that says so
(breaking ones start with `**BREAKING:**`). Draft sections of otherwise Accepted specs are marked
in their heading and carry `@experimental` TSDoc on the main exported symbols; the symbols keep their
plain names (no `experimental_` prefix). Everything else follows the rules above.

Draft areas introduced in 0.7 (still Draft):

- Specs 18–22 as modules (`eharness/permissions`, `eharness/shell`, `eharness/subagent`,
  `eharness/ask`, `eharness/web`), and specs 12–17 as before.
- The `auto` permission mode and its classifier (`classifier`, `modelClassifier()`, the auto-pause
  counters; spec 18 §12).
- Agent messaging in `eharness/subagent`: `send_message`, named agents, resume, the roster reminder,
  the `<agent-message>` frame (spec 20 §5).
- The deferred-tools turn reminder format (spec 02 §3.3); the `deferTools` option itself is stable.
- The `<untrusted-content>` frame format and the helpers `untrustedContent()` and
  `UNTRUSTED_CONTENT_INSTRUCTIONS` (spec 03 §10).
- `projectInstructions()` frames and defaults (spec 08 §13).

Draft areas introduced in 0.8 (still Draft):

- The modules `eharness/providers`, `eharness/connectors`, `eharness/activity`, `eharness/http`,
  `eharness/client` and `eharness/client/react` (specs 23-27).
- In otherwise Accepted specs: the `message.saved` hook (spec 05, 25); partial resolution of pending
  approvals (`TurnResult.partial`, spec 11 §4.3); `session.recover()` and `recovery.instanceId`
  (spec 05); the `model.call` hook and `observeModel()` (spec 12 §7); `reconcileBackgroundChildren`
  and background subagents in park mode (spec 20); `StreamLogAdapter`, `attachRemote()` and
  `handleResumeRequest()` (spec 04 §6); `enqueue` timers, ids and metadata (spec 05 §12); the model
  catalog and cost functions (spec 12); `config.observe` and its event names (spec 01); the shared
  judge engine `createJudge()` (spec 15, ADR-0060).
- The `@experimental` marker is how a Draft symbol of the core shows up in TSDoc (`observeModel`,
  `handleResumeRequest`, `attachRemote`, `StreamLogAdapter`, the model catalog and cost, `createJudge`);
  Draft subpaths carry an "all symbols are experimental" header instead of a marker per symbol.

Names derived from Claude Code are intentionally kept and are not renamed for style:
`bash_output`, `kill_shell`, `agent`, and the camelCase permission modes (`acceptEdits`,
`dontAsk`, `bypassPermissions`). They are as stable as any other public name.

## Deprecation

1. Mark with `@deprecated <replacement> — removal in <version>` and, where cheap, a one-time
   runtime warning (`W_DEPRECATED`).
2. Keep it for at least one minor (0.x) / one major (≥ 1.0).
3. List it under "Deprecated" in the changeset.

## What counts as breaking (checklist for reviewers)

- Removing/renaming an export (the snapshot diff shows it), option, hook, tool, data part, kind, error code.
- Narrowing accepted input types or widening returned types in a way that breaks `tsc` for users.
- Changing defaults that alter behaviour materially (`summarizeAt`, `keepLast`, `maxSteps`,
  `persistEachStep`, tool result formats).
- Changing adapter contract semantics (ordering, inclusivity of `fromId`, upsert).
- Changing the order of hooks or of prompt assembly.

## 1.0 criteria

- All specs **Frozen**; conformance suites stable.
- At least two independent production applications running a release candidate for four weeks
  without contract changes.
- Sandbox and subagents plugin designs settled (implemented or explicitly out of 1.0).
