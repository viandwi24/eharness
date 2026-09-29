# ADR-0009: Release with Changesets and npm trusted publishing

Status: **Accepted** · Date: 2026-09-29

## Context

We need predictable semver, generated changelogs and no long-lived npm tokens.

## Decision

Changesets v3 with `changesets/action` v2 sub-actions (select-mode → version PR / pack → publish).
Publishing uses npm trusted publishing (OIDC, `id-token: write` only on the publish job),
provenance is automatic. The very first version is published manually once, then the trusted
publisher is configured, token publishing is disallowed, and the workflow is switched on with the
`RELEASE_ENABLED` repository variable. The version PR is opened with a GitHub App token so that CI
runs on it. Details: engineering/release.md.

## Consequences

+ No secrets in CI; provenance on every release; reviewable version PRs.
− First publish is a manual step; trusted publisher config must match the workflow file name.

## Alternatives considered

- semantic-release (rejected: commit-message driven, less explicit); manual `npm publish` (rejected).
