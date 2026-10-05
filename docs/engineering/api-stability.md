# API stability

## What is public API

Everything a user can observe without reading our source:

1. Every symbol exported from `eharness` and its subpaths (`/filesystem`, `/filesystem/memory`,
   `/storage/memory`, `/mcp`, `/todos`, `/memory`, `/testing`), including types.
2. **Persisted formats:** `metadata.eharness`, core data part types and payloads (`eh.*`),
   core message kinds and payloads, `SessionStateSnapshot`, plugin data parts of shipped plugins.
3. **Stream shape:** order and types of chunks the core writes (spec 04 §2).
4. **Model-visible text** of built-in tools (names, input schemas, result prefixes such as
   `STALE:`), the skills index block, the compaction marker projection.
5. Error and warning codes, stop reasons.
6. Hook names and the order in which they run.
7. Adapter contracts (`MessageAdapter`, `StateAdapter`, `InboxAdapter`, `FileSystem`, `SkillSource`,
   `ToolSource`, `SessionLock`).

Not public: anything under `src/internal`, exact wording of default prompts (the *structure* is
public), log messages, performance characteristics.

## Semver policy

| Version range | Breaking change goes into | Notes |
|---|---|---|
| `0.x` (now) | **minor** (`0.2.0 → 0.3.0`) | npm caret `^0.2.0` does not cross minors, so users are safe |
| `0.x` | patch for fixes and additive features | never breaking |
| `≥ 1.0` | **major** | standard semver |

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

## Deprecation

1. Mark with `@deprecated <replacement> — removal in <version>` and, where cheap, a one-time
   runtime warning (`W_DEPRECATED`).
2. Keep it for at least one minor (0.x) / one major (≥ 1.0).
3. List it under "Deprecated" in the changeset.

## What counts as breaking (checklist for reviewers)

- Removing/renaming an export, option, hook, tool, data part, kind, error code.
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
