## What

<!-- One or two sentences. Link the plan task: docs/plans/Pn-….md -->

## Checklist

- [ ] `bun run lint && bun run typecheck && bun test` pass locally
- [ ] Touches exports? `bun run build && bun run check:package` pass
- [ ] Changeset added (`bunx changeset`) — or not needed (docs/tests/CI only)
- [ ] Spec updated in this PR if behaviour or API changed (`docs/specs/…`)
- [ ] ADR added/updated if a decision changed (`docs/decisions/…`)
- [ ] Breaking change? Follows `docs/engineering/api-stability.md` (changeset says **BREAKING** + migration)
- [ ] Plan checklist and board updated (`docs/plans/`)
