# Manual steps for the maintainer

Steps the orchestrator cannot do (they need the maintainer's GitHub/npm account, SSH key or
secrets). Phases continue locally; do these when convenient, in order.

| # | Step | Needed for | Status |
|---|---|---|---|
| 1 | Push `main` (phase merges are local `--no-ff` merges): `git push origin main`. Optionally push the `phase/*` branches too. | CI on the merged phases | todo |
| 2 | Do **not** merge a "chore(release): version packages" PR before P8. Changesets from P1–P7 are `patch`; until P2 removes `EH_NOT_IMPLEMENTED`, a release would ship a stub (spec 10 §1). If the bot opens a version PR after a push, leave it open: it updates itself and becomes `0.1.0` once P8's `minor` changeset lands. | Correct `0.1.0` release | todo |
| 3 | Optional: npmjs.com → eharness → Settings → Publishing access → "Require two-factor authentication and disallow tokens". | Lock down publishing | todo |
| 4 | After pushing `main`, check CI `node-compat` (Node 22/24) is green: P2's acceptance criterion "Node smoke test" was only verified under Bun locally (no Node on the orchestrator machine). | P2 acceptance | todo |
