# Audit of platform actions

Every call an agent makes on a chat platform (Telegram bot tools, Telegram user account tools, the
generic pin / react / history actions) passes the channel governor
(`server/src/infra/channels/governor.ts`), which writes one row per call into the channel activity
log (`ch_events`, type `gateway.action` for changes, `gateway.read` for lookups). The Audit is a
workspace-wide view over those rows.

## What is recorded

One row per call: the connection, the tool (and its sub-action as `action=<name>` in the summary),
the chat, the person or link it was about, who asked (a team member, `web owner`, or
`autonomous <origin>` for a routine or a program, with the role), the agent and the session, the
result (`ok`, `error`, `refused`, `rate_limited`), a short note for a failure or refusal, and the
duration.

Message text is never stored. The summary keeps ids, counters and short values; a text parameter
(`text`, `caption`, `message`, `reason`, ...) appears only as `text=<N chars>`. Secrets are left out.
Rows are kept as long as the events retention allows (Settings, events retention) and are pruned
with the rest of the channel activity.

## Where to see it

- **Audit page** (`/audit`, next to Logs in the main navigation): a table of time (team timezone),
  connector, action, target, requested by, agent, result and duration. Quick ranges (today, 7 days,
  30 days, all time) and a custom date range, filters for connection, connector kind (bot or user
  account), actions or lookups, action, chat, requester, agent and result. A row opens a detail
  sheet with the summary, the note, the session link and the raw record. The page refreshes itself
  every 30 seconds; Refresh reloads at once.
- **Per connection**: the Activity page of a connection keeps showing every event (messages too) and
  has an "Open in Audit" button.
- **API**: `GET /audit/actions` (cursor paged, newest first) and `GET /audit/actions.csv` take the
  same filters: `connectionId`, `platform`, `transport` (`bot` or `user`), `kind` (`action` or
  `read`), `action`, `chat`, `requester`, `agentId`, `result`, `from`, `to` (epoch ms).

## CSV export

"Export CSV" on the Audit page (or `GET /audit/actions.csv`) writes up to 10 000 rows of the current
filters, newest first. Fields are quoted when they hold a comma, a quote or a line break. Text that a
spreadsheet would run as a formula (a person chooses their own display name) starts with `'`.

## The agent tool

`platform_action_log` is a read-only tool of the channels plugin, available to every agent that has a
channel connection. It answers from the same log with filters (connection, chat, action, requester,
result, `since` / `until` in the team timezone, `reads` to include lookups) and returns compact
lines such as

    2026-10-24 09:12 Asia/Jakarta · telegram account · promote_member · chat Ops · user @ana · by web owner · ok · chat=-100123 user=@ana

Use it before repeating an admin action, and to answer "what did you do before" or "who changed
this". Scope: an agent sees only the connections it is bound to, never another agent's connections
(even for the same person), and only the owner and the admins may call it (a member or a guest is
refused). The channel session prompt tells the agent the tool exists.
