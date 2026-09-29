# Manual steps for the maintainer

Steps the orchestrator cannot do (they need the maintainer's GitHub/npm account, SSH key or
secrets). Phases continue locally; do these when convenient, in order.

| # | Step | Needed for | Status |
|---|---|---|---|
| 1 | Push `main` (phase merges are local `--no-ff` merges): `git push origin main`. Optionally push the `phase/*` branches too. | CI on the merged phases | done (2026-09-29) |
| 2 | Do **not** merge a "chore(release): version packages" PR before P8 is merged. Changesets from P1–P7 are `patch`; if the bot opens a version PR after a push (e.g. `0.0.3`), leave it open: it updates itself and becomes `0.1.0` once P8's `minor` changeset lands on `main`. (`EH_NOT_IMPLEMENTED` was removed in P7, so no stub ships.) | Correct `0.1.0` release | done (0.1.0 released) |
| 3 | Optional: npmjs.com → eharness → Settings → Publishing access → "Require two-factor authentication and disallow tokens". | Lock down publishing | todo |
| 4 | After pushing `main`, check CI `node-compat` (Node 22/24) is green: P2's acceptance criterion "Node smoke test" was only verified under Bun locally (no Node on the orchestrator machine). | P2 acceptance | done (CI green on Node 22 and 24) |
| 5 | Node 22 getting-started (P8 acceptance): in an empty directory `npm init -y && npm pkg set type=module && npm install eharness ai zod` (before the release: install the tarball from `bun run build && npm pack`), paste `agent.ts` from `docs/guides/getting-started.md` with the scripted model of its step 4 (no API key needed), run `node agent.ts` on Node ≥ 22.18 (22.6–22.17: `--experimental-strip-types`). Expect `complete after 3 steps` / `2 messages stored`. Verified under Bun only. | P8 acceptance (Node 22) | todo |
| 6 | After P8 is merged and pushed: approve CI on the "chore(release): version packages" PR, check it bumps to **0.1.0** (P8's `minor` changeset), that `src/index.ts` exports `version = '0.1.0'` (synced by `release:version`) and the CHANGELOG reads well; merge it. | 0.1.0 release | done (PR #5 merged) |
| 7 | After the publish job: `npm view eharness@0.1.0 version`, provenance badge on npmjs.com, git tag `v0.1.0` and the GitHub release exist. | P8 acceptance (npm + provenance) | done (npm 0.1.0 with provenance, tag and release v0.1.0) |
| 8 | Optional: run the examples against a real model: `AI_GATEWAY_API_KEY=… bun examples/basic-cli.ts` (and `next-route.demo.ts`, `subagent-tool.ts`, `plugin-authoring.ts`). CI runs them only with scripted models. | Live sanity check | todo |
| 9 | First CI run after pushing P8: the `check` job now starts a `postgres:17-alpine` service; confirm the `postgres-storage (DATABASE_URL)` tests ran (not skipped) and passed. | CI Postgres example | todo |
