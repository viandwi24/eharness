# Release process

eharness is released with **Changesets v3** and published to npm with **trusted publishing**
(OIDC, no npm tokens in CI) and automatic provenance. See ADR-0009.

## 1. Overview

```
feature PR (+ .changeset/*.md) ──merge──▶ main
                                           │ release.yml: select-mode = version
                                           ▼
                        "chore(release): version packages" PR  (bumps version, writes CHANGELOG.md)
                                           │ review + merge
                                           ▼
                                         main
                                           │ release.yml: select-mode = publish
                                           ▼
                pack (build + checks + npm pack) ─▶ publish (npm, git tag, GitHub release)
```

Nothing is published without a reviewed version PR. Publishing happens only from `main` (latest)
or `next` (prerelease channel).

## 2. Versioning policy (short)

Full rules: [api-stability.md](api-stability.md).

| Change | 0.x bump | ≥ 1.0 bump |
|---|---|---|
| Breaking (API, persisted format, contract semantics, peer `ai` major) | **minor** | major |
| New feature, non-breaking | patch | minor |
| Bug fix | patch | patch |

The changeset for a breaking change starts with `**BREAKING:**` and includes a migration snippet.

## 3. Writing changesets

```bash
bunx changeset            # pick bump type, write a user-facing summary
```

- Required when files matching `changedFilePatterns` change (source under `src/`, excluding tests
  and golden files, plus `package.json`); CI runs `changeset status --since=origin/<base>` on PRs.
- Docs, tests, CI, examples: no changeset needed.
- A `package.json` change that does not affect users (e.g. a devDependency bump) still matches the
  pattern: add an empty changeset with `bunx changeset add --empty`.
- Write for users: what changed and what they must do. Not implementation details.

```md
---
"eharness": minor
---

**BREAKING:** `MessageAdapter.load` now requires `fromId` to be inclusive.
Migration: if your adapter used `id > fromId`, change it to `id >= fromId`.
```

## 4. One-time setup (maintainer)

Do these once, in order. Values: GitHub `OWNER/eharness`, npm package `eharness`.

1. **Repository settings**
   - Actions → General → Workflow permissions: "Read repository contents" (default) and **enable
     "Allow GitHub Actions to create and approve pull requests"**.
   - Environments → create `npm`; **Deployment branches and tags → Selected branches: `main`,
     `next`** (so a manual dispatch from another branch can never publish); optionally add
     required reviewers (= manual release approval).
   - Branch protection on `main` (optional): require PR, require the `CI` checks, squash merge.
   - Nothing else: the workflows use only the built-in `GITHUB_TOKEN` (no GitHub App, PAT or npm
     token).
2. **Changesets config** (created by `bunx changeset init` in P0, then edited):
   ```jsonc
   {
     "$schema": "https://unpkg.com/@changesets/config@<installed>/schema.json",
     "baseBranch": "main",
     "access": "public",
     "changelog": ["@changesets/changelog-github", { "repo": "OWNER/eharness" }],
     "commit": false,
     "changedFilePatterns": [
       "src/**",
       "!src/**/*.test.ts",
       "!src/**/*.int.test.ts",
       "!src/**/*.test-d.ts",
       "!src/**/__golden__/**",
       "package.json"
     ]
   }
   ```
3. **First publish (manual, once).** npm trusted publishing can only be configured for a package
   that already exists on the registry, so the first version is published by hand:
   No Node/npm needed locally; Bun reads the npm auth token from `~/.npmrc`:
   ```bash
   bun pm whoami                  # must print the npm account (2FA enabled); if not, add an
                                  # npm token to ~/.npmrc or NPM_CONFIG_TOKEN
   bun install && bun run build && bun run check:package
   bun publish --access public    # publishes the current version (0.0.1 placeholder from P0);
                                  # 2FA prompts in the browser (or pass --otp <code>)
   ```
4. **Configure the trusted publisher** on npmjs.com → package → Settings → Trusted publishing →
   GitHub Actions: repository `OWNER/eharness`, workflow `release.yml`, environment `npm`, and
   **check "Allow npm publish"** (otherwise only `npm stage publish` is allowed and the publish job
   is rejected).
   (Equivalent CLI, needs npm ≥ 11.15:
   `npm trust github eharness --repo OWNER/eharness --file release.yml --env npm --allow-publish`.)
   The workflow file name (`release.yml`) and environment (`npm`) must match exactly.
5. **Lock down tokens:** npmjs.com → package → Settings → Publishing access → "Require two-factor
   authentication and disallow tokens". From now on only the workflow can publish.
6. Revoke any automation tokens you created for the first publish.
## 5. Normal release

1. Merge feature PRs with changesets into `main`.
2. `release.yml` opens/updates **"chore(release): version packages"** PR (`bun run
   release:version`: `changeset version`, then `scripts/sync-version.ts` copies the new version
   into `export const version` of `src/index.ts`; a test fails if they ever differ).
3. On that PR click **"Approve workflows to run"**: GitHub holds CI on PRs opened with
   `GITHUB_TOKEN` until someone with write access approves it. Wait for CI to pass, then review
   the generated `CHANGELOG.md` and version. Edit wording in the PR if needed.
4. Merge it. `release.yml` runs `pack` then `publish`:
   - `npm publish` via OIDC with provenance,
   - git tag `vX.Y.Z` (Changesets tags single-package repos as `v<version>`),
   - GitHub Release with the changelog entry.
5. Verify: `npm view eharness version`, provenance badge on npmjs.com.

## 6. Workflows

| File | Trigger | Jobs | Permissions |
|---|---|---|---|
| `.github/workflows/ci.yml` | PR, push main/next | `check` (lint, typecheck incl. `examples/`, test incl. the examples with a Postgres service container, build, publint+attw, import rule, changeset status), `node-compat` (Node 22 & 24: pack tarball → clean install → `scripts/smoke.mjs`) | `contents: read` |
| `.github/workflows/release.yml` | push main/next, manual (main/next only) | `select-mode` → `version` (`GITHUB_TOKEN`) or `pack` → `publish` (environment `npm`) | least privilege per job; `id-token: write` only on `publish` |
| `.github/dependabot.yml` | weekly | actions + bun deps; peer majors ignored | — |

## 7. Prereleases (`next` channel)

Used before a breaking minor (0.x) or major.

```bash
git switch -c next main
bunx changeset pre enter next      # commit .changeset/pre.json
git push -u origin next
```

Merging changesets into `next` produces version PRs like `0.4.0-next.0` published under the
`next` dist-tag (`npm i eharness@next`). To finish: `bunx changeset pre exit` on `next`, merge
`next` into `main`, and the normal flow publishes the stable version.

## 8. Hotfix for an older minor (0.x)

Rare in 0.x (users are expected to move to the latest minor). When needed, it is a **manual,
maintainer-only** procedure so the automated workflow never publishes an old line as `latest`:

```bash
git switch -c release/0.3 v0.3.4           # branch from the tag
# fix + changeset (patch) via PR into release/0.3, CI must pass
bunx changeset version                      # → 0.3.5 + CHANGELOG, commit, push
bun run build && bun run check:package
bun publish --tag v0.3-latest              # interactive 2FA publish (tokens stay disallowed)
git tag v0.3.5 && git push --tags
```

Never publish an old line without `--tag`, or it becomes `latest`.

## 9. Emergency procedures

- **Bad release:** publish a fixed patch immediately. Use `npm deprecate eharness@x.y.z "<reason>"`.
  Unpublish only within npm's 72-hour window and only for security/legal issues.
- **Compromised workflow:** delete the trusted publisher on npmjs.com (stops all publishing),
  investigate, re-create it.
- **Release failed half-way** (tag exists, npm missing): re-run the `publish` job; Changesets skips
  versions that already exist on npm.

## 10. Release checklist (version PR review)

- [ ] CHANGELOG entries are user-facing and mention BREAKING + migration where relevant
- [ ] Specs touched by the release are marked with the new status (Frozen after 1.0)
- [ ] `README.md` snippets match the current API (the quick start is checked against
      `examples/quick-start.ts` by `examples/examples.test.ts`; other snippets are not compiled)
- [ ] Peer dependency ranges (`ai`, `zod`, `@ai-sdk/mcp`) are correct
