# Telegram user account: platform tools

Source: `server/src/infra/telegram-user/actions.ts` (reads, posts, moderation) and `manage.ts`
(managing chats). Tests: `server/test/telegram-user-admin.test.ts` and `server/test/telegram-user-manage.test.ts`. mtcute is pinned (`@mtcute/bun`), and
every call below was checked against the installed version.

The tools are deferred and named `telegram_user_<tool>`. Each has one static risk; the permission
engine asks for approval on write, external and destructive ones where the app's mode requires it.
Related: the bot connector has its own set (`telegram-bot-actions.md`).

## Who may

- Decided in code on the current requester, never by what a message says. A member or a guest of a chat
  gets no native tool at all; owners and admins get them by risk.
- **Owner only** tools are refused unless an owner asks. The signed-in web owner counts as owner.
  Autonomous runs have no requester and are unrestricted by design, as for every tool.
- **Destructive** and irreversible calls also need `confirm: true` (the agent asks the person first).
- Settings and member changes work on groups and channels the account **administers**, never on
  direct chats. Message-level tools work only on chats **chosen** for ingest. A chat this account
  creates is chosen automatically and wakes the agent on mention.
- Caps that protect the account: 20 people per `add_members` call and 60 a day, spaced 2.5 s apart;
  5 chats created a day; 3 joins a day; 5 username lookups a minute and 30 a day.

## Capability table

| Area | Tool | Risk | Who |
|---|---|---|---|
| Read | `list_dialogs`, `list_chats`, `get_chat`, `get_user`, `list_members` (admins with exact rights, banned and restricted with limits), `list_forum_topics`, `search_messages`, `get_message`, `admin_log`, `list_scheduled` | read | owner, admin |
| Read | `member_info`, `poll_results`, `post_stats` (views, forwards, comments, reactions), `list_join_requests`, `list_invite_links`, `list_contacts`, `resolve_chat`, `check_invite_link`, `chat_stats` | read | owner, admin |
| Send | `forward_message`, `copy_message` (no "forwarded" header), `send_poll` (poll or quiz via `correct_option`), `schedule_message`, `send_album` (2-10 library files), `comment_on_post` | external | owner, admin |
| Send | `cancel_scheduled`, `choose_chat`, `backfill`, `create_forum_topic`, `edit_forum_topic`, `manage_topic` (pin, unpin, hide or show General), `pin_message` (silent or notify, unpin, unpin all), `stop_poll`, `mark_read`, `manage_dialog` (mute, archive, pin in the list) | write | owner, admin |
| Moderate | `ban_member`, `unban_member`, `kick_member` (can rejoin), `restrict_member`, `delete_member_messages` | destructive | owner |
| Moderate | `promote_member` (every admin right, also edits an existing admin), `demote_member` | destructive | owner |
| Manage chats | `create_group` (supergroup, forum, first members, link), `set_chat_info` (title, description, photo, signatures), `set_chat_visibility` (public username or private, approval to join), `set_default_permissions` (what members may do, slow mode, forum on/off), `manage_chat_settings` (auto-delete, protected content, hide members, history for new members, reactions, signatures, discussion group link, default send-as) | external | owner, admin |
| Manage chats | `delete_chat`, `clear_history` (me or everyone), `delete_forum_topic`, `transfer_ownership` (explains only) | destructive | owner, `confirm` |
| Members and invites | `add_members` (per-person result, privacy fallback), `answer_join_request`, `edit_invite_link`, `revoke_invite_link` | external | owner, admin |
| Members and invites | `create_invite_link` (expiry, limit, approval, title), `join_chat`, `leave_chat` | destructive | owner |
| Channels | `create_channel` (optional public username), `set_chat_info` / `manage_chat_settings` signatures, discussion group, `promote_member` with `post_messages`, `edit_messages`, `delete_messages`, `invite_users` | external / destructive | owner, admin / owner |
| Contacts | `add_contact` (never shares the phone unless asked) | external | owner, admin |

### Adding people and the privacy fallback

`add_members` tries each person alone and reports each one (added, already in, refused with the
reason). On `USER_PRIVACY_RESTRICTED` / `USER_NOT_MUTUAL_CONTACT` it makes (or reuses) the primary
invite link. With `send_link_to: dm` the link is sent by direct message **only** if the account
already has a conversation with that person (the same "no cold messages" rule as every send);
otherwise the link is returned and must be shared by somebody who can message them. A flood wait or
`PEER_FLOOD` stops the batch. Adding someone as a contact helps only if they also have the account in
their contacts.

### Ownership transfer

The app never handles the two-step verification password, so `transfer_ownership` only explains how
the person does it in the Telegram app.

## Audit

Every platform action (reads, local answers and refusals included) writes one row to the channel
activity (`gateway.action` / `gateway.read`), shown on the Activity page under "Action". A row holds:
time, action, node, `result` (`ok`, `error`, `refused`, `rate_limited`), duration, a reason for
anything that is not `ok`, the requester (`peerName`: the chat person, `web owner`, or
`autonomous <origin>`), and in `detail`: `role`, `member`, `session`, `agent`, `origin`, `args`
(ids only), `summary` (all parameters, values clipped to 40 characters, secrets left out; free text
such as `text` is only counted, `text=<18 chars>`), and `targetChat`, `targetUser`, `targetLink`.
Refusals that happen before the action runs (role policy, owner only) are recorded too.

## Real cases to try (owner checklist)

1. **Create a group**: "Create a group Ops with these people ..." -> the chat appears chosen on the
   Channels page, an invite link comes back, mention the account there and it answers.
2. **Invite a privacy-restricted person**: add one whose privacy blocks groups -> the answer says so
   and returns a link; with a conversation open and `send_link_to: dm` the link arrives by DM; with
   none, nothing is sent.
3. **Make a group public, then private**: `set_chat_visibility` with a username (try a taken one: the
   answer says so), then private (the old link stops working).
4. **Join requests**: turn on approval, join from another account, `list_join_requests`, then
   `answer_join_request` approve; try "approve all" (needs confirm).
5. **Channel with a discussion group**: `create_channel`, `create_group`, `manage_chat_settings`
   `link_discussion`, post with `channel_send`, then `comment_on_post` under it; turn signatures on.
6. **Admins**: `promote_member` with `post_messages` for a channel, `member_info` to see the exact
   rights, change them by promoting again; try to edit an admin somebody else promoted (the answer
   explains who can).
7. **Danger zone**: `delete_chat`, `clear_history` and `delete_forum_topic` refuse without `confirm`
   and for anybody but an owner; `transfer_ownership` explains the Telegram app steps.
8. **Audit**: open the Activity page, filter Action, check the requester, role, target and result of
   what you just did.
