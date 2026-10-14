# Spec 30 — Identity (`eharness/identity`)

Status: **Draft**. Module: `src/identity/*`, conformance suite `src/testing/identity.ts`. Builds on
spec 10 (errors) and the team design in `docs/plans/P43-team-people.md`.

One **person**, many **platform accounts**, one **role**. Products that need it: team chat, live
chat, automation. The module is runtime-neutral (Web Crypto only), imports core only through
`src/index.ts` and ships a memory adapter; databases are the app's adapters.

## 1. Model

- `Person`: `id`, `displayName`, `nickname`, `status` (`active` | `suspended` | `left`), `role`
  (`string | null`, app-defined; `null` = the app's default), `divisions`, `fields`
  (`Record<string,string>`), `notes`, `memberId`, `createdBy`, timestamps. `DefaultRole`
  (`owner | admin | member | guest`) is a type helper; the library does not restrict role names.
- `PersonAccount`: `platform` (family, e.g. `telegram`), `nativeId` (the platform's stable user id),
  `label` (display only), `status` (`linked` | `revoked`), `linkedVia` (`owner` | `pairing` |
  `migration` | any string), `linkedBy`, `linkedAt`, `revokedAt`.
- `PersonEvent`: `kind` (`create`, `update`, `role`, `status`, `link`, `unlink`, `pair`, `delete`),
  `actor`, `detail`, `at`.

## 2. Security rules

1. **Stable ids only.** Accounts are keyed by `(platform, nativeId)`. Usernames, display names and
   platform admin badges are display data, never keys and never grant a role.
2. **Never link from chat text.** What somebody says ("I am Ana") links nothing.
3. **Owner or pairing only.** An account is linked by an owner action (`linkedVia: 'owner'`) or by a
   pairing code redeemed from the new account by the person themselves (`'pairing'`).
4. **One account, one person.** Linking an account that belongs to another person rejects
   `ACCOUNT_LINKED_ELSEWHERE`; moving it needs an unlink first.
5. **Suspended or left means guest** (`resolveRole`), whatever the stored role.
6. **Audit events are kept**, including after `delete`.

## 3. `PersonStore`

All methods are async. `now` and `actor` are passed in.

```ts
get(id); list({ q?, limit?, offset? }) -> { items, total }          // newest-updated first
create(input, actor, now); update(id, patch, actor, now)            // fields merge, null removes a key
delete(id, actor, now) -> boolean       // accounts and pending codes go; events stay + a 'delete' event
byAccount(platform, nativeId) -> { person, account } | undefined    // linked accounts only
accounts(personId, includeRevoked?); link(personId, account, via, actor, now)
unlink(accountId, actor, now); setLabel(accountId, label, actor, now); events(personId, limit?)
issueCode(personId, now, ttlMs = 1h) -> { code, expiresAt } | { error }
redeemCode(code, now) -> personId | undefined
```

Rejections are `IdentityError` (`code`: `ACCOUNT_LINKED_ELSEWHERE`, `PERSON_NOT_FOUND`,
`INVALID_PERSON`; guard `isIdentityError`). Re-linking to the same person only updates the label.
`memoryPersonStore({ ids? })` is the reference adapter; `personStoreConformance(factory)` from
`eharness/testing` (when exported) is the contract for others.

## 4. Pairing

`generatePairingCode()` returns 8 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no `0 O 1 I L`).
Codes are stored only as SHA-256 hex (`hashPairingCode`, after `normalizePairingCode`: upper case, no
spaces or dashes). At most 3 unused unexpired codes per person. `redeemCode` is single use
(compare-and-set; SQL adapters use `UPDATE ... WHERE used_at IS NULL` and check the change count).
`pairingGuard({ maxFailures: 5, windowMs: 3_600_000 })` is an in-memory limiter the app keys by
account (`allowed`, `failure`, `success`); call `allowed` before `redeemCode`.

## 5. Roles

`resolveRole({ person, legacyRole?, defaultRole })`: no person → `legacyRole ?? defaultRole`; person
not `active` → `'guest'`; otherwise `person.role ?? defaultRole`.

`decideByRisk(role, risk, policy?, toolName?)` → `{ allowed, reason? }`. The table
`DEFAULT_ROLE_POLICY` is data: owner and admin every risk (`read`, `write`, `external`,
`destructive`); member `read` only; guest nothing; unknown roles use the guest row. `policy`
overrides per role, field by field (`risks`, `allow`, `deny` by tool name). Order: deny, allow, risk.
A missing or unknown risk counts as `write`. Own writes for members are granted by listing the tool
names in `allow` (the app knows which tools act on the requester only).

## 6. Not in scope

Storage beyond memory, UI, platform adapters, deciding who the owner is, and mapping `Person` to a
turn requester (apps do that with `resolveRole`).
