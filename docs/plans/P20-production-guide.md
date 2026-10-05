# P20 — Production-patterns guide, docs and 0.4.0 handoff

Status: in progress · Owner: agent · Branch: `main` (direct commits; P13–P20 ship together as **0.4.0**)

Source: BTeams proposal item **U9**, the design-level risks of the 0.3.1 security audit, and the
"Results" handoff table of the proposal.

## Goal

Users of the library can find and apply the production patterns that already exist (and the new
0.4.0 features) without reading the source: a `docs/guides/production-patterns.md` guide, a
security section covering the audit's design-level risks, README / guides / reference updated for
every 0.4.0 feature, the roadmap cleaned up, and an English results document for the BTeams team
that states the final API of U1–U9 and every difference from their proposal.

## Specs / docs to read

- Every phase file P13–P19 (final state, open-question decisions, "differences" notes)
- `docs/specs/02-context-registry.md` §2, §5 (`refresh: 'turn'`, `step.prepare` reminder)
- `docs/specs/05-session-and-storage.md` §1, §3 step 8 (`input.submit` `context` is **stored**),
  §7–§9 (state, lock, recovery), new §9.1 (P16) and §12 (P19)
- `docs/specs/01-agent-and-plugins.md` §5 (`step.end` `context` is stored as `data-eh.input`;
  `compaction.after`)
- `docs/specs/06-compaction.md` §3 (`CompactionPayload.summary`)
- `docs/specs/11-interaction.md` §6.3 (`inject` + `wake`), §8 (security rules)
- `docs/specs/07-skills.md` §3 (custom `SkillSource`), `docs/specs/08-filesystem-plugin.md` §2
  (`hideSkillsRoot`, prefixes, `toolOutputs`)
- `docs/specs/12-models-and-cost.md` §4 (budgets are per turn / per session)
- `docs/guides/*` (all), `README.md`, `docs/guides/reference.md`, `docs/plans/roadmap.md`
- `docs/eharness-updated.md` (maintainer-only BTeams proposal, Indonesian; **read only, never
  commit or edit it**)

## Owns

`docs/guides/**`, `README.md`, `docs/plans/roadmap.md`, `docs/README.md`,
`docs/reviews/0.4.0-results.md` (new folder + file), `examples/` additions for the guide, the
board. No `src/` changes (if a doc gap reveals a bug, file it under "Requests to other phases" of
the owning phase or as a follow-up).

## Checklist

### Production-patterns guide (`docs/guides/production-patterns.md`)

- [x] **Ephemeral context:** `refresh: 'turn'` instructions and `step.prepare → { reminder }` for
      group context, live data and retrieved memories; explicit warning that `input.submit
      { context }` and `step.end { context }` are **stored** (they become part of history).
- [x] **Episodic memory** from `compaction.after({ marker })` (`CompactionPayload.summary`), and
      P15 flush + P17 memory as the "save before summarizing" pattern.
- [x] **Background events:** `inject(kind, data, { deliver, wake })` + `messageKinds` (job results,
      agent-to-agent messages, scheduled reminders).
- [x] **Multi-instance:** `SessionLock` (Postgres advisory lock example), `StateAdapter.setIf`,
      `lastId`, `recovery.staleMs`, cross-process abort (P16), inbox (P19), `ifBusy: 'wait'` /
      `idle()` and the 409 route (P13).
- [x] **Scheduling / heartbeat** is the application's job: a job runner calls
      `inject(…, { wake: true })`; the "silent OK" pattern (the agent answers nothing when there is
      nothing to do, e.g. via a `step.end` stop or a tool that ends the turn).
- [x] **Skills from a database** via a custom `SkillSource` with `version` (P14).
- [x] **Structured output** for pipeline workers (P18) and **prune** for tool-heavy agents (P14). (P18 part: planned shape only, "(see P18)".)
- [x] Offline example(s) for the patterns that have no example yet (e.g.
      `examples/background-events.ts`), registered in `examples/examples.test.ts`.

### Security section (in the guide, linked from README "Security")

Design-level risks from the audit — each with the risk, the default, and what the app must do:

- [x] **Session ownership / authorization:** eharness knows only `sessionId`; the POST and the
      attach **GET** route must check that the caller owns the session before
      `agent.session(id)` / `attach()` (the README GET example gets an ownership check).
- [x] **Runtime is shared per live session:** `runtime` passed to `agent.session(id, { runtime })`
      is replaced on the cached instance (spec 05 §1); per-request identity belongs in
      `SendOptions.runtime`, and authorization must not rely on the session-level runtime.
- [x] **Budgets are per turn / per session, not per user:** a user with many sessions is not
      capped; app-level quotas are needed.
- [x] **Path checks are exact-match prefixes:** `readonlyPrefixes` / `hiddenPrefixes` use
      normalized directory semantics; case-insensitive or symlinked backends must normalize in
      the adapter.
- [x] **Shared fs tool outputs:** `toolOutput.strategy: 'evict'` writes to the session's `fs`; if
      the fs resolver returns a shared fs, outputs of one session are readable by another — use a
      per-session/per-user fs or `toolOutputs: false`.
- [x] **`hideSkillsRoot: false`** lets the model write skills → a prompt-injection channel into
      future sessions; keep the default (true) unless skills are meant to be agent-authored, and
      then review them.
- [x] **Broad session grants:** `remember: 'session'` grants a whole tool for the session; prefer
      `'once'` for risky tools; `clearGrants()` on privilege change.
- [x] **Default logger sensitivity:** the default logger may print error causes; set `logger` and
      `toolErrorText` (P13) in production; `describeError` redaction (P13) is defence in depth.
- [x] **Provider-fetched URLs:** file parts with URLs are fetched by AI SDK/providers; P13's
      `inputFiles` policy limits protocols and sizes; SSRF-sensitive deployments should allow only
      `data:` or their own object store.
- [x] **Untrusted client input**: recap spec 05 §3 / 11 §8 (what the core already guarantees).

### Feature docs and reference

- [x] README: feature list and quick links for 0.4.0 (prune, flush, memory, structured output,
      cross-process abort, inbox, `ifBusy: 'wait'`); route examples with busy handling and an
      ownership check; README snippets still match `examples/quick-start.ts`.
- [x] `docs/guides/README.md` rows for new guides (`memory.md`, `structured-output.md`,
      `multi-instance.md`, `production-patterns.md`); cross-links between guides. (`structured-output.md` follows P18.)
- [x] `docs/guides/reference.md`: every new option, method, hook, stop reason
      (`'context-thrash'`, `'output-invalid'`), warning, error/notice code, data part and kind of
      0.4.0, checked against specs. (`output-invalid` and other P18 rows follow P18.)
- [x] `docs/README.md` reading order / module map (memory subpath, spec 14), `docs/architecture.md`
      module map if it lists subpaths.
- [x] `docs/engineering/api-stability.md` subpath list includes `/memory` and `/todos`; adapter
      contracts list includes `InboxAdapter`.

### Roadmap and handoff

- [x] `docs/plans/roadmap.md`: strike done items (Memory plugin, Prune stage, Output guardrails —
      schema part, Compaction thrash detection, Cross-process queue / wake) with "Done in 0.4.0";
      keep the out-of-scope items added during planning; update the "Shipped" line.
- [x] `docs/reviews/0.4.0-results.md` (English, for BTeams): one section per U1–U9 with status,
      version (`0.4.0`), final API (signatures), and **differences from the proposal**, at least:
      - U1: flush recorded as model-invisible `eh.flush` audit kind (proposal: no trace); usage
        source `compaction-flush`; approvals auto-denied; `trigger` also `'turn'`.
      - U2: prune off by default; summarizer transcript keeps original (capped) outputs;
        `replaceWith(part: ToolResultPart)`; cache prefix changes once per turn.
      - U3: final shape of the remote-enqueue API (P19 open question 1); `collect` also
        in-process; dedupe via `inboxId` + `state.core.inboxDelivered`.
      - U4: `requestAbort()` added, `abort()` signature unchanged; requires `setIf`; field
        `core.abortRequest` (turn-scoped); `abortPollMs`.
      - U5: `tool` option instead of `providerTool`; `onWrite` option instead of a
        `memory.write` hook; roots resolved per turn; pinned in the turn reminder.
      - U6: `final_answer` appended last for that turn only (cache note); native mode =
        AI SDK `Output.object`; Standard Schema needs JSON Schema support; no carry-over across
        `respond()`; retry source `plugin:eh.output`.
      - U7: version shown in `load_skill`, not in the index.
      - U8: stop `'context-thrash'`, `compaction.thrash` (default on).
      - U9: guide path and sections.
      Plus a short "also in 0.4.0" list of P13 fixes that affect BTeams (409 route, `ifBusy:
      'wait'`, stricter adapter conformance, `inputFiles`, `toolErrorText`).
- [ ] Board: P20 done; note that the version PR produces 0.4.0.

## Acceptance criteria

- [x] Every public symbol added in 0.4.0 appears in `reference.md` and at least one guide. (P18 symbols pending its merge.)
- [x] Every guide example compiles (`bun run typecheck` covers `examples/`) and every new
      example runs offline in `examples.test.ts`.
- [x] `docs/reviews/0.4.0-results.md` covers U1–U9 and matches the shipped specs. (U6 "pending P18 merge".)
- [ ] `docs/eharness-updated.md` is neither modified nor committed. (Not modified by P20; but it
      **is tracked** on `main` since the P14 merge `a4e300a` — maintainer decision, see Open questions.)
- [x] lint, typecheck, test green (docs-only phase: no changeset needed unless `src/` changed).

## Changeset

None (docs/examples only). If a doc fix needs a `src/` change, it goes into the owning phase's
changeset or an extra `patch` changeset.

## Open questions

- Should `docs/reviews/` hold future release handoffs too? Decision: yes, one file per release
  that has an external requester.

Notes from implementing P20:

- **P18-dependent parts left open on purpose:** the `structured-output.md` row in
  `guides/README.md`, `reference.md` rows for `output` / `'output-invalid'` / `W_OUTPUT_INVALID` /
  `data-eh.output`, results U6, the README "planned" bullet and the roadmap "Output guardrails"
  row. The production guide mentions structured output only through the planned shape "(see
  P18)". Whoever merges P18 updates them (see Requests to other phases).
- **Doc/code finding:** a `refresh: 'turn'` instruction (and a dynamic tool source) is evaluated
  at spec 05 §3 step 6, before input normalization (step 7) and `input.submit` (step 8), so
  `ctx.turn.input` is `undefined` there even for `send(text)`; the TSDoc of `TurnInfo.input`
  ("Undefined for respond/regenerate/wake and for `send()` without input") does not mention it.
  Verified with a scripted turn. The guide documents it and uses `step.prepare` for retrieval; no
  `src/` change in P20 (candidate: a TSDoc/spec 01 §4 note, or evaluate turn instructions after
  step 8).
- **`docs/eharness-updated.md` is tracked** since the P14 merge (`a4e300a`), although the plans say
  it is maintainer-only and never committed. P20 did not touch it; the maintainer decides whether
  to untrack it.
- `examples/next-route.ts`: per-request identity moved from `agent.session(id, { runtime })` to
  `handleChatRequest(…, { runtime })`, and the GET route got the ownership-check comment (security
  section).
- The results document's signature blocks are fenced as `text` (summaries, not compilable TS);
  every `ts` block added to the guide and README was typechecked against `src` with a scratch
  checker.

## Requests to other phases

- **P18 (on merge):** add `structured-output.md` to `docs/guides/README.md` and the README guides
  list; `reference.md` rows (`SendOptions.output`, `TurnResult.output`, `'output-invalid'`,
  `W_OUTPUT_INVALID`, `data-eh.output`, `metadata.eharness.output`); replace the "(see P18)"
  paragraph in `production-patterns.md` and the README "planned" bullet; fill U6 in
  `docs/reviews/0.4.0-results.md` (summary row + section with final API and differences); strike
  "Output guardrails" (schema part) in `roadmap.md` and drop "(P18, pending merge)" there.
- Every phase P13–P19 keeps its "differences from the proposal" up to date in its Open questions
  section; P20 copies them into the results document.

## Dependencies

**P13–P19** (last phase of 0.4.0).
