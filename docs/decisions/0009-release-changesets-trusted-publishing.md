# ADR-0009: Release with Changesets and npm trusted publishing

Status: **Accepted** · Date: 2026-09-29

## Context

We need predictable semver, generated changelogs and no long-lived npm tokens.

## Decision

Changesets v3 with `changesets/action` v2 sub-actions (select-mode → version PR / pack → publish).
Publishing uses npm trusted publishing (OIDC, `id-token: write` only on the publish job),
provenance is automatic. The very first version is published manually once, then the trusted
publisher is configured and token publishing is disallowed. The workflows use only the built-in
`GITHUB_TOKEN`: the version PR is opened with it, and the maintainer approves the CI run GitHub holds
on such PRs ("Approve workflows to run"). Details: engineering/release.md.

Amended 2026-09-29: dropped the release GitHub App (client ID + private key) and the
`RELEASE_ENABLED` gate. GitHub now runs `pull_request` workflows on `GITHUB_TOKEN`-opened PRs after
a one-click approval, so the App only saved that click; the gate only guarded the window before
the first manual publish, which is done.

## Consequences

+ No secrets in CI; provenance on every release; reviewable version PRs.
− First publish is a manual step; trusted publisher config must match the workflow file name.

## Alternatives considered

- semantic-release (rejected: commit-message driven, less explicit); manual `npm publish` (rejected).
- GitHub App or PAT for the version PR so CI starts without approval (rejected: extra secrets and
  setup for one click per release).
