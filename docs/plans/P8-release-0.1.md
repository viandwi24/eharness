# P8 — Examples, README, 0.1.0 release

Status: done · Branch: `phase/P8-release`

## Goal

Make eharness usable by someone who has never seen this repo, and publish `0.1.0`.

## Owns

`examples/**`, `README.md`, `docs/guides/**` (new), release housekeeping.

## Checklist

1. [x] `examples/basic-cli.ts` — agent + filesystem(memoryFs) + terminal rendering via
   `readUIMessageStream` (`@ai-sdk/tui` needs the `Agent`-interface adapter, roadmap).
2. [x] `examples/next-route.ts` — POST `handleChatRequest` + GET attach route handlers,
   `useChat<InferHarnessUIMessage>` snippet with approvals (`sendAutomaticallyWhen`) and a
   `data-eh.input` renderer. `examples/next-route.demo.ts` drives the routes offline with AI
   SDK's `AbstractChat` + `DefaultChatTransport` (submit → approval → approve → continuation).
3. [x] `examples/json-file-storage.ts` — `MessageAdapter` + `StateAdapter` on JSON files (Node),
   passing conformance.
4. [x] `examples/postgres-storage.ts` — spec 05 §10 schema, adapter, advisory-lock `SessionLock`,
   passing conformance when `DATABASE_URL` is set (skipped otherwise). Written against a
   two-method `SqlPool` interface (no driver dependency); the runner uses Bun's built-in `SQL`.
   Verified locally on Postgres 17 (conformance 18/18 + lock + a locked turn).
5. [x] `examples/custom-fs-adapter.ts` — a `FileSystem` over a key-value store, passing conformance.
6. [x] `examples/plugin-authoring.ts` — a small plugin with a service, data part, hook, state.
   Also `examples/subagent-tool.ts` (child session, preliminary results, `addUsage`) and
   `examples/quick-start.ts` (the README quick start).
7. [x] `docs/guides/`: getting-started, writing-a-plugin, writing-a-storage-adapter,
   rendering-data-parts, skills, approvals-and-interaction, subagents (tool + child session +
   preliminary results + `addUsage`). Short, runnable snippets only. Every `ts` snippet was
   typechecked against the real API (scratch extraction, not committed).
8. [x] README: install, 30-line quick start, links to guides/specs, status badge, compatibility
   table (eharness ↔ ai). The quick start is checked against `examples/quick-start.ts` by
   `examples/examples.test.ts`.
9. [x] Examples are typechecked in CI (`bun run typecheck` = `tsc --noEmit && tsc --noEmit -p
   examples`) and executed by `bun test` (`examples/examples.test.ts`, offline scripted models;
   Postgres through a CI service container, no secrets).
10. [x] Set every spec's status line to "Accepted (reviewed for 0.1.0)"; list anything that stays
    `experimental_`: **none** in the public API. Internally the core uses two AI SDK experimental
    options: `experimental_refineToolInput` (runs `tool.before`) and
    `experimental_toolApprovalSecret` (`approval.secret`) — they may change in AI SDK minors.
11. [x] Changeset `minor` → `0.1.0` with a summary of the feature set
    (`.changeset/release-0-1-0.md`); version PR #5 merged by the maintainer; provenance verified on
    npm (2026-09-29).

## Acceptance criteria

- [ ] Following getting-started from a clean directory works on Node 22 and Bun. **Bun: verified**
      (clean `bun init` project, packed tarball + `ai` + `zod`: the offline variant completes in
      3 steps, the gateway variant without a key ends with `stop: 'error'` without throwing, and the
      project typechecks). **Node 22:** CI `node-compat` (Node 22 and 24) is green on the packed
      tarball (imports, boot, a scripted turn, approval continuation); the full getting-started
      walkthrough on Node 22 is still open as MANUAL.md row 5.
- [x] `eharness@0.1.0` on npm with provenance; GitHub release created by the workflow.
      Verified 2026-09-29: npm `latest` = `0.1.0` with SLSA v1 provenance, tag and GitHub release
      `v0.1.0`.

## Open questions

Decided conservatively:

1. **Examples tsconfig.** `isolatedDeclarations` (a library-build rule) rejected
   `export const agent = defineHarnessAgent(…)` in examples. Examples now have
   `examples/tsconfig.json` (extends the root, `isolatedDeclarations`/`declaration` off) and the
   root `include` no longer lists `examples`; `bun run typecheck` checks both projects.
2. **Tool-factory context typing (fixed after review).** `ToolInput` used the default parts type,
   so `ctx.stream.data(…)` accepted only `never` in top-level tool functions and in tools a plugin
   contributes as functions. Now `ToolInput<DP>` / `ToolsInput<DP>` take the owner's part map:
   `PluginContribution<DP>.tools` is `ToolsInput<DP>`, and `HarnessAgentConfig<DP>` +
   `defineHarnessAgent<const C extends HarnessAgentConfig<DP>, const DP>(config: C & { dataParts?: DP })`
   infer the app's `dataParts` for top-level tools (both cases work; existing inference and a
   config typed as plain `HarnessAgentConfig` unchanged). Type tests:
   `src/agent/tool-context.test-d.ts`. Specs 01 §1/§2 and 04 §3, the plugin and rendering guides
   and the changeset updated. Related, unchanged for 0.1.0: P1 open question 3 (plugin tool parts
   are not in `AgentMessageOf` when the app declares static tools).
3. **`version` export drift.** `export const version` in `src/index.ts` was a literal that the
   version PR would not update (0.1.0 would have reported `0.0.2`). `bun run release:version`
   now runs `scripts/sync-version.ts` after `changeset version`, and `scripts/sync-version.test.ts`
   fails when the two differ. release.md §5 and release.yml comment updated.
4. **CI Postgres service.** The `check` job starts `postgres:17-alpine` (throwaway password in the
   workflow, not a secret) and sets `DATABASE_URL` for `bun test`, so the Postgres example's
   conformance runs in CI. Not yet exercised on GitHub (MANUAL.md row 9).
5. **Postgres JSON binding.** Bun's `SQL` JSON-encodes a string bound to a `jsonb` parameter a
   second time; the example binds `$n::text::jsonb` and selects `::text` (driver-agnostic). Noted
   in spec 05 §10.
6. **Model in examples.** `examples/shared/model.ts`: a real AI Gateway model when
   `AI_GATEWAY_API_KEY` is set (`EXAMPLE_MODEL`, default `anthropic/claude-sonnet-4.6`), else a
   `scriptedModel` script. Tests unset the key, so they never touch the network. Live runs are a
   maintainer check (MANUAL.md row 8).
7. **Guides vs. roadmap.** The React `useChat` code is shown in comments / `tsx` blocks only (no
   React dependency); its protocol is exercised by `next-route.demo.ts` with AI SDK's own
   `AbstractChat`.

## Requests to other phases

- From P7 (review): the approvals guide must mention that a denied call reaches the model as
  `execution-denied` in the first step of the continuation (AI SDK) but as an `error-text` result
  (the denial reason) when projected in later turns (`output-denied` part) — one prompt-cache miss
  after a denial; not a correctness issue.

- From P2: before releasing 0.1.0, verify that no code path uses `EH_NOT_IMPLEMENTED` (P3/P7 remove
  their stubs) and remove it from `HarnessErrorCode` (spec 10 §1: development only) — a breaking
  type change that is fine before 0.1.0.
- From P3: `scriptedModel` (`src/testing/scripted-model.ts`) implements only `doStream`, but the
  compaction summarizer calls `generateText` (`doGenerate`). Consider letting `scriptedModel` also
  answer `doGenerate` calls from the same script (recorded in `calls`), so users can test
  compaction with a single scripted model; P3's tests use a separate mock
  (`src/compaction/test-kit.ts`).
- From P5: `scripts/check-imports.ts` (P0-owned) was relaxed so that **test files** of a subpath
  may import other subpaths (e.g. `src/filesystem/*.test.ts` → `src/testing`), never core
  internals; non-test files keep the strict rule. Mention it in `docs/engineering/conventions.md`
  if you touch that file. Examples: `filesystem({ fs: memoryFs(seed), skills: { root: '/skills' } })`
  plus `classifyToolResult` for terminal rendering of tool results.

Handled in P8:

- P7 (approvals guide): denial encoding (`execution-denied` in the continuation vs. `error-text`
  from `output-denied` later, one cache miss), deterministic `tool.before`, side-effect-free
  approval logic, exactly-once across instances (`SessionLock` / `setIf`), the continuation resume
  caveat (re-fetch `session.messages()` at `turn-end`) and `ifBusy: 'steer'` in the route — all in
  `docs/guides/approvals-and-interaction.md` and `examples/next-route.ts`.
- P2: `EH_NOT_IMPLEMENTED` is gone from `src/`, specs and scripts (removed from
  `HarnessErrorCode` in P7; repo grep finds only plan history).
- P3: `scriptedModel` answers `doGenerate` from the same script (recorded in `calls` /
  `prompts`); tested with `generateText` and verified with `session.compact()`.
- P5: the relaxed import rule for subpath test files is already in `docs/engineering/conventions.md`;
  examples use `filesystem({ fs: memoryFs(seed), skills: … })` and `classifyToolResult` for
  terminal rendering (`basic-cli.ts`, `next-route.ts`).
