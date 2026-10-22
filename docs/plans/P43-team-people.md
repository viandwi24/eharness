# P43 — team: People directory (one person, many accounts)

Status: phases 1–3 done (2026-10-13); phase 4 proposed. Example app only (`examples/team`); no library change.

## Why

Roles lived per platform identity per connection (`ch_people`): a person with two accounts (two
Telegram accounts, later Telegram + WhatsApp) had two roles that could drift, and nothing said they
were the same human. Group members also often have no role at all. The agent needs
one place that says who somebody is (full name, nickname, fields, notes) and what they may do.

Research (competitor repos and the web, 2026-10-13): Paperclip links a chat principal to a user
with an admin-initiated single-use token confirmed out of band and re-checks authorization at the
mutation point; OpenClaw keeps per-channel ids and does not unify humans for authorization; Hermes
pairs with hashed short codes (TTL, pending cap, rate limit, lockout). Stable platform ids are the
only keys (Telegram user id; WhatsApp JID / LID / business-scoped id as aliases; Slack/Discord ids);
usernames, names and phones are soft attributes. Never auto-merge on a matching username or phone.
OWASP LLM06: authorization is code at the tool boundary, never the model.

## Model

- `people` — a Person: `display_name` (full name), `nickname`, `status` (`active` | `suspended` |
  `left`), `role` (`owner` | `admin` | `member` | `guest`, null = the connection default),
  `divisions` (node ids), `fields` (free key/value: position, branch, ...), `notes` (staff notes),
  `member_id` (the web team member, if any), timestamps.
- `people_accounts` — a platform account of a person: `platform` (family: `telegram`, `whatsapp`,
  `slack`, `discord`, `mock`), `native_id` (the platform's stable user id), `label` ("admin account"),
  `status` (`linked` | `revoked`), `linked_via` (`owner` | `pairing` | `migration`), `linked_by`,
  timestamps. One linked row per (platform, native id): an account belongs to one person; moving it
  needs an explicit unlink first. Every connection of the same platform family resolves through it
  (a bot and a user account of Telegram see the same user id).
- `people_events` — append-only audit: create, update, role, link, unlink, status, delete (kept
  after the person is deleted).
- `people_link_codes` — pairing: hashed 8-character code, person, expiry (1 h), attempts, used.

## Resolution (code, every turn and every tool call)

sender platform id → linked account → person: `suspended`/`left` → guest (never more); the
person's role and divisions when set; else the legacy per-identity entry; else the linked team
member; else the connection or chat default. Message text never takes part. The header
(`<message-meta>`) names the person (full name, nickname) so the model addresses them right.

## Linking (never from chat text alone)

1. Owner in the web app (People page): attach an observed account, set its label.
2. Owner in a chat: the `people` tool's `link` action asks first (the card names the account and the
   person); a "ya" from the owner confirms. Admins and members cannot link.
3. Self-service pairing: from an already linked account the person asks for a code (`people` tool,
   `pair` action, own person only); they send `/link <code>` from the new account (DM or group); the
   gateway links it before any model sees the message. Code hashed, single use, 1 h, 3 pending per
   person, 5 wrong tries lock pairing for the person for an hour.

## Agent tools

- `member_lookup` (existing) also shows the person (full name, nickname, label of the account).
- `people_find` (read; members and staff, never guests): without a query the whole directory (50 per
  page, `page`), with a query a search (name, nickname, field, account id), with `id` one person.
  Staff also see status, divisions, fields, notes, the recent changes of one person, and the accounts
  seen in chats that are no person yet (also searched by a query).
- `people` (allowed by rule, checked in code): `create`/`update` (owner or admin: name, nickname,
  fields, notes, divisions); `pair` (anybody with an active linked person, own person only, direct
  chat only: returns the code to send as `/link CODE` from the other account).
- `people_admin` (owner only, asks first: the approval card names the action and the person):
  `link`/`unlink` an account, `create_from_account`, `create_all` (a person for every unassigned
  account, optional role), `role` (admin, member, guest, default), `status` (active, suspended,
  left), `delete`. Owners and the owner themself are changed on the People page only.
- `person_role` (owner only, asks first) sets a role by platform user id; it writes the person.
- The `tool.approve` hook denies `people`/`people_admin` for the wrong role before any approval card.

## Roles of accounts

Only the person's role counts for a linked account (no role: the chat default). The per-account
entries of before P43 count only for an account that belongs to no person; they move to the person
when one is created from the account, and they are dropped when the account is unlinked or its
person is deleted (an unlinked account is a guest again until it is linked).

## Direct chats

A direct chat is answered for a linked web team member, or for an active person of the directory
whose role is above guest. Anybody else is recorded (who, never what) and gets no answer.

## Phases

1. Core: tables, migration from `ch_people` / linked identities, resolution, role writes go to the
   person, header. (this phase)
2. Web: People page (list, detail, accounts, fields, notes, audit, unassigned accounts).
   Web (as built): top-level section **People** (`/people`, `/people/[id]`). API: `GET/POST /people`
   (server paging by `page`/`limit`, `q`), `GET/PATCH /people/{id}`, `POST /people/{id}/accounts`,
   `PATCH/DELETE /people/{id}/accounts/{accountId}`, `POST /people/{id}/pairing-code` (code shown once),
   `DELETE /people/{id}` (204; the history stays), `GET /people/unassigned`, `GET /people/nodes` (chats and topics for divisions),
   `POST /people/from-account`. Port `PeoplePort` (`infra/channels/people-admin.ts`) over
   `gateway.directory`; every web change has the actor `web`; a `PersonError` is a 409 (404 for a
   missing person, 400 for invalid input) with its readable message. The list has two views: People
   (search, paging) and Unassigned accounts (create a person, or attach to one).
3. Tools and pairing command; e2e scenarios I-01..I-14 (impersonation, linking with approval,
   suspended person, one role for two accounts, `/link` pairing, `pair` only in a direct chat, direct
   chats from directory people, listing, delete, suspend, role, create all, web delete).
4. Later: manager role with division scope; task claims verified by another person.

## Open questions

- WhatsApp is not connected yet: aliases (JID/LID/BSUID) are modelled as extra accounts of the
  same person until a WhatsApp adapter exists.
