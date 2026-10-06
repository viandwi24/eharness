# P29 — Docs, guides and 0.5.0 handoff

Status: todo · Owner: agent · Branch: `main` (direct commits; P21–P29 ship together as **0.5.0**)

Source: the 0.5 prior-art analysis (maintainer-only, `docs/tmp/`, not committed) — items #1–#8.

Process (0.5.0): runs after P21–P28 are done; one gate at the end; then the consolidated review
of the whole release (below) before the version PR.

## Goal

Everything shipped in P21–P28 is documented for users: README, guides, reference, roadmap and
the production-patterns guide reflect 0.5.0; every new subpath and option is in
`docs/guides/reference.md`; and the 0.5.0 results notes (kept outside the repository) (English) maps the eight
prior-art items to what shipped, the final API, deviations from the plans and what stays app
policy. The consolidated review finds spec/code drift before the release.

## Specs / docs to read

- All phase files P21–P28 (final Design sections, decided open questions, "Requests to other
  phases" aimed at P29)
- `docs/specs/*` as changed by P21–P28, new specs 15 (guard), 16 (group), 17 (openapi); ADRs
  0025–0032 (those that exist)
- `docs/plans/P20-production-guide.md` and the 0.4.0 results notes (kept outside the repository) (shape of the handoff)
- `README.md`, `docs/README.md`, `docs/guides/README.md`, `docs/guides/reference.md`,
  `docs/guides/production-patterns.md`, `docs/plans/roadmap.md`
- `docs/engineering/release.md` (version PR, changesets), `docs/engineering/api-stability.md`
  (type-level additions in a minor)

**AI SDK verified (2026-10-06):** latest `ai` **7.0.128**, `@ai-sdk/mcp` **2.0.67**
(`https://registry.npmjs.org/ai/latest`, `https://registry.npmjs.org/@ai-sdk/mcp/latest`); no
server-side API change relevant to eharness since 7.0.127 (CHANGELOGs at
`https://raw.githubusercontent.com/vercel/ai/main/packages/ai/CHANGELOG.md` and
`…/packages/mcp/CHANGELOG.md`). **Re-check both at the start of this phase**; if still true, bump
only the **devDependencies** to the latest patch (CI hygiene, optional) and keep the peer floors
`ai@^7.0.127` / `@ai-sdk/mcp@^2.0.66` (raising them narrows compatibility for no gain). Note:
AI SDK now has an experimental `@ai-sdk/harness` (`HarnessAgent`, adapters for external agent
runtimes) — mention the positioning in the results file, no code.

## Owns

`README.md`, `docs/README.md`, `docs/guides/**` (index, reference, production-patterns, links to
the guides written by P23–P28), `docs/plans/roadmap.md`, `docs/plans/README.md` (board),
the 0.5.0 results notes (kept outside the repository) (new), `package.json` devDependency versions (optional bump +
`bun install`), a `patch` changeset only if the bump or doc-adjacent code changes need one.

## Checklist

- [ ] Collect every "Requests to other phases → P29" item from P21–P28; tick each here.
- [ ] README: feature list (external risk, inbox dead-letter, external waits, frontend tools and
      page context, budget ledger, `eharness/guard`, `eharness/group`, `eharness/openapi`),
      subpath table, route snippet with `clientTools` / `pageContext`.
- [ ] `docs/guides/README.md` index + `reference.md` entries for every new export, option,
      warning, event, fixed text and stop-reason detail; `production-patterns.md` sections:
      poison items and alerting, long waits and webhooks, cross-session budgets, guard in
      production, group bots.
- [ ] Verify every guide written by P23–P28 links back to its spec section and runs (snippets
      match the final API; examples in `examples.test.ts`).
- [ ] Roadmap: move the 0.5.0 rows to a "0.5.0" section (struck through in the open tables:
      "Approval classifier guard", "Inbox poison-item limit"; partial: "Durable execution",
      "Budget pre-flight estimate"); add items found during 0.5.0.
- [ ] the 0.5.0 results notes (kept outside the repository): table #1–#8 → verdict, what shipped (API), what stays app
      policy, deviations from the plan files and why, follow-ups.
- [ ] Optional devDependency bump (see above); run the full gate after it.
- [ ] Board: P21–P29 `done`.
- [ ] Gate: `bun run lint && bun run typecheck && bun test && bun run build && bun run
      check:package && bun run check:imports`.

## Consolidated review (end of release)

One review agent, no code changes, reads all of P21–P28 against `docs/specs/*` and lists, with
`file:line`: spec/code deviations, missing checklist tests, public API without TSDoc or explicit
return types, changeset / semver mistakes (type-level additions documented per phase), new
subpaths missing from `check-imports` / tsdown / exports / smoke / CLAUDE.md, and any persisted
shape change without a golden or schema-evolution note (spec 03 §9). Findings are fixed in
`fix(<area>): …` commits before the version PR.

## Acceptance criteria

- [ ] Every new public symbol of 0.5.0 appears in `reference.md`; every new subpath in README and
      CLAUDE.md.
- [ ] the 0.5.0 results notes (kept outside the repository) covers all eight items.
- [ ] Consolidated review findings resolved or recorded as roadmap items.
- [ ] lint, typecheck, test, build, check:package, check:imports green.

## Changeset

None for docs. A devDependency-only bump still touches `package.json`, so it needs an **empty**
changeset (`bunx changeset add --empty`, `docs/engineering/release.md`); `patch` only if code or
peer/runtime fields change here.

## Open questions

1. Peer floor bump to 7.0.128? Pick: no (see AI SDK note).

## Requests to other phases

(none — this phase consumes the others' requests)

## Dependencies

**P21–P28** (all). Wave W5.
