# Telegram bot: group and channel management tools

Source: `server/src/infra/telegram/actions.ts` (tests: `server/test/telegram-bot-actions.test.ts`).

An agent connected to a Telegram **bot** gets, besides the generic channel tools (send, reply,
upload, react, edit, delete, pin), nine platform tools with an `action` enum. They are deferred
tools named `telegram_<tool>` and have one static risk each. The user account connector has its own
set (`telegram_user_*`); see "Bot vs user account" below.

## Who may

- Decided in code on the current requester, never by what a message says. A member or a guest of a chat
  gets no native tool at all; owners and admins get them by risk (write, external and destructive
  ask for approval like any tool).
- **Owner only** tools are refused for an admin or anybody else. The signed-in web owner counts as an
  owner (role `owner`, requester "web owner"). Autonomous runs (routine, program) have no requester and are
  unrestricted by design, as for every tool.
- **Destructive** actions need `confirm: true` on top (the agent asks the person first). So does
  `ban` with `revoke_messages`, and `unpin_all`.
- A refusal by the bot's missing right is explained: which admin right is missing and how to grant it.

## Tools and actions

| Tool | Risk | Roles | Actions |
|---|---|---|---|
| `telegram_chat_info` | read | owner, admin | `chat` (title, description, slow mode value, linked chat, default permissions), `member_count`, `administrators` (each with exact rights and title), `member` (status, rights, whether the bot may edit this admin), `limits` |
| `telegram_join_requests` | external | owner, admin | `list` (pending requests the bot saw), `approve`, `decline` |
| `telegram_chat_messages` | external | owner, admin | `pin` (silent unless `notify`), `unpin`, `unpin_all` (confirm), `send_poll` (poll or quiz: `quiz`, `correct_option`, `explanation`, `open_seconds`), `stop_poll`, `copy`, `forward` (one or many ids), `send_album` (2-10 https photo urls) |
| `telegram_chat_topics` | write | owner, admin | `create`, `edit`, `close`, `reopen`, `unpin_all`, `general_rename`, `general_close`, `general_reopen`, `general_hide`, `general_unhide` |
| `telegram_chat_settings` | write | owner | `set_title`, `set_description`, `delete_photo`, `set_permissions` (default member permissions, `independent`), `set_sticker_set`, `delete_sticker_set`; answered as "not possible": `set_photo`, `slow_mode`, `signatures`, `discussion_group`, `create_chat` |
| `telegram_chat_members` | write | owner | `ban` (`for_minutes`, `revoke_messages` needs confirm), `unban` (only if banned), `kick` (ban + unban), `restrict` (permissions + `for_minutes`), `promote` / `edit_admin` (every admin right, groups and channels), `demote`, `admin_title`, `ban_sender_chat`, `unban_sender_chat`; `add_member` explains that bots cannot |
| `telegram_chat_invites` | external | owner | `export_link`, `create_link` (name, `expire_minutes`, `member_limit`, `requires_approval`), `edit_link`, `revoke_link` |
| `telegram_bot_profile` | write | owner | `set_commands`, `set_description`, `set_name` (one profile for every chat) |
| `telegram_chat_destructive` | destructive | owner + `confirm` | `delete_topic`, `delete_messages` (up to 100 ids), `leave_chat` |

Admin rights handled by `promote` / `edit_admin` (the list is the full set the admin should have; all
others are switched off, `demote` switches all off): `is_anonymous`, `can_manage_chat`,
`can_change_info`, `can_post_messages`, `can_edit_messages`, `can_delete_messages`, `can_invite_users`,
`can_restrict_members`, `can_pin_messages`, `can_manage_topics`, `can_promote_members`,
`can_manage_video_chats`, `can_post_stories`, `can_edit_stories`, `can_delete_stories`,
`can_manage_tags`, `can_manage_direct_messages`.

Channels: posting uses the generic send tool of the bound channel (the bot needs "Post messages").
Channel post signatures and the discussion group link are not in the Bot API.

## Join requests

A group or channel invite link created with `requires_approval` makes people ask to join. The adapter polls
`chat_join_request` (in `ALLOWED_UPDATES`), saves the request in `ch_join_requests` (so a restart loses nothing;
7 days, 500 at most) and sends the gateway a **`member.join_requested`** event with the applicant as actor (the
invite link used and whether a bio was shown; the bio text stays in the saved request, never in the event log).
The gateway does not wake the agent for it by itself: the request shows on the channel's
[Events](events.md) page, and the agent (or an owner asking it) reads
`telegram_join_requests list` and answers `approve` or `decline` per the owner's rules. An answer made with the
tool becomes `member.join_request_resolved`; an approval by another admin in the Telegram app is seen as the
person joining and resolves the saved request too. Requests made while the bot was not connected are not listed;
Telegram still holds them and `approve` works with a user id.

## Audit

Every call (reads included) goes through the API governor and writes one channel activity row of type
`action` (or `read`): time, agent, session, requester name and role (`owner` for the web owner;
`autonomous <origin>` for programs), tool name, target (chat, user, link), a parameter summary which
starts with `action=<sub-action>`, the result (`ok`, `error`, `refused`, `rate_limited` with the reason)
and the duration. Owner-only refusals by the plugin are recorded as `refused` too.

## Bot vs user account

| | Bot (`telegram-bot`) | User account (`telegram-user`) |
|---|---|---|
| Create groups and channels | no | yes |
| Add people to a chat | no (invite link; they must start the bot to be messaged) | yes (mutual contacts or already in chat) |
| Read history | no (only what it receives while polling) | yes (backfill, search, admin log) |
| List all members | no (administrators only, one member by id) | yes |
| Contacts, username lookup, join public chats | no | yes (capped to protect the account) |
| Inline buttons, `/commands`, callback queries | yes | no |
| Join request updates | yes (`chat_join_request`) | yes, when the account administers the chat (pending-requests update) |
| Admin rights | exact list incl. channel rights, custom titles | similar through MTProto |
| Ban risk | none from normal use | account can be flagged: strict caps |
| Slow mode, signatures, discussion link | no | yes |
| Messaging a person first | no | yes (with caps) |

## Real-case checklist

1. Make the bot an administrator of the group or channel with the rights the case needs (see the table).
2. Group with topics: bot needs "Manage topics"; check with `chat_info` `chat` that it is a forum.
3. New member screening: owner creates `create_link` with `requires_approval`; join requests appear;
   `list`, then `approve` or `decline`.
4. Moderation: `restrict` with `for_minutes` for a mute, `kick` to remove, `ban` for good, `unban` to lift.
   A bot cannot touch admins or the creator.
5. Admin changes: `chat_info` `member` shows whether the bot may edit an admin; promote only what the
   bot holds itself.
6. Before `delete_*`, `leave_chat`, `revoke_messages`: ask the person, repeat with `confirm: true`.
7. Slow mode, channel signatures, discussion group, group photo upload and group creation stay manual or
   go through the user account connector.
