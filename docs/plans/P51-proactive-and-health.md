# P51 — Proactive heartbeat (standing orders) and agent health

Status: done · Owner: agent

## Goal

Agents act on what they observe without rigid schedules, and the system notices its own problems
before people do. Team example only (no library change).

Proactivity comes from conversation, memory and prompt, not from configuration. The first design
(modes `off` / `notes` / `speak`, a `reportTo` chat, `maxPostsPerDay`, activity-wake switches) was
rejected: nobody tunes those, people just tell the agent what they want ("analisis setiap saat ada
yang aneh di channel komunitas, kalau ada laporkan ke saya"). It was replaced by standing orders.

## Standing orders

- An ongoing instruction ("setiap saat", "terus", "pantau", "kalau ada ... kabari", "proaktif") given
  in a web DM or in a chat channel becomes a **standing order**, added by the agent with the
  `standing_order` tool (`add` / `list` / `remove`, `infra/eh/standing-order-plugin.ts`). The tool
  description says when to use it (ongoing) and when not (a one-off task: just do it; a fixed time:
  reminder, routine, program).
- It stores the person's words (lightly cleaned), who asked (identity id, name, role, platform user
  id), where it was asked, where it reports (default exactly where it was asked; another chat only
  when the person names it and it is a postable chat of the agent), whether to tag the asker
  (default yes in a group), and when.
- Roles, in code on the requester: the web owner and owners/admins may have reports posted into a
  group or another chat and may remove any order; a member only gets reports back privately in
  their direct chat with the agent (asked in a group, or naming a chat: refused with a readable
  sentence) and removes only their own; a guest gets nothing. A member's order tells the beat to
  report only what that member could read themselves.
- "Stop", "berhenti memantau": `remove` (by id, by words, or the only order of the person).

### Storage: HEARTBEAT.md is the source of truth

Orders are list items of the agent's own memory file, with a small machine-readable tail:

```
- Pantau channel komunitas, laporkan yang aneh. <!-- order:<id> by:<identity> name:Ana role:admin
    uid:<platform id> report:chat:<connection>/<node> mention:yes at:<ms> -->
```

(`report:web:<session>` for an order asked in a web chat; `active:no` pauses one; fields are
percent-encoded so a name cannot close the comment.) The owner reads and edits them as text, the
agent sees them in its memory, and the server parses the tails (`domain/standing-orders.ts`) to
build the gate. A line without a valid tail is an ordinary checklist item: the beat looks at it,
but it reports only to the digest and the bell. A table was considered and rejected: two sources of
truth would drift, and the file is already versioned, editable and visible. Writes are
compare-and-set (`app/standing-orders.ts`).

## Heartbeat

- Runs by itself whenever there is at least one active order or checklist item; no UI toggle
  (`enabled`, interval 30 min and active hours stay as advanced settings, defaults for every
  agent). No order and an empty checklist: the beat is skipped with no model call.
- Early beats on new messages in watched chats (the chats the file names, else every group the
  agent is allowed in; never DMs), debounced to one per 10 minutes, never without new activity.
- A beat reads the orders, the activity lines of `team_status`, and today's and yesterday's notes;
  per order it decides `note` / `report` / `escalate` with a reason (the decision log and the speak
  rubric are prompt text). `heartbeat_note` (append-only daily file) stays.
- Reporting: a chat destination through `channel_send` (send only, to that exact destination,
  mentioning the asker when the order says so, through the proactive policy of the chat); a web
  destination through `heartbeat_report` (a notice in that thread plus a bell notification).
- Safety stays, as constants: the gate lets a beat send only to destinations of active orders (a
  snapshot written at the start of each beat), at most 8 reports a day per destination, a repeat
  check, quiet when nothing is new; a refused post is a readable string.
- Removed: `mode`, `reportTo`, `maxPostsPerDay`, `wakeOnActivity`, `minGapMinutes` (stored configs
  are read without them), the "Insert a suggestion" button and the destination picker.
- The Heartbeat tab: a short explanation, the list of orders (text, who, where it reports, when,
  Remove), the raw `HEARTBEAT.md` under "Edit as text", interval and hours under "Advanced",
  the daily digest (lead) and recent beats with decisions and reasons.

## Checklist

- [x] Standing orders: `standing_order` tool in web and channel chats, roles, destinations
- [x] Orders stored as readable lines of `HEARTBEAT.md` with a parsed tail; hand-written lines stay
      plain items
- [x] Heartbeat on by default for every agent; runs only with something to watch
- [x] Gate: sends only to destinations of active orders; per-destination cap and repeat check
- [x] Web destination: notice in the thread plus bell (`heartbeat_report`)
- [x] Early beats on chat activity, debounced 10 minutes, no activity no model call
- [x] Observation notes: append-only `/library/notes/heartbeat/<agent>/<day>.md` (`heartbeat_note`)
- [x] Beat decisions `note` / `report` / `escalate` with a reason, shown in the beat log
- [x] Without a lead agent the digest still runs and urgent findings reach the owners
- [x] Health page: detectors for repeated denials, tool loops, repeated errors, waiting approvals,
      token spikes, oversized outputs, failed or partial runs, provider errors; bell once per finding
- [x] Program authority suggestions in the Decision Center from repeated denials
- [x] The daily digest lists open health findings

## Open questions

- Routes have no owner/admin role check (the app has one trust level).
- The activity-wake debounce is per process.
- [x] Privacy of chat reads, enforced in the gate (`readScopeOf`, `test/order-answers.test.ts`): a
  beat reads (`chat_history`, `channel_read`, the Telegram message readers) only chats that the
  giver of a live order can read themselves (owner/admin and the web owner: every allowed chat; a
  member: their own chats; a giver who is gone: none), the owner's plain checklist items count as
  the owner's. Once a beat has read a DM, a post may go only back to that DM or to the DM or web
  chat of a person who can read it, never into a group. Two more gate rules (`postScope`,
  `privateOrderRefusal`, `crossGroupRefusal`, `test/critical-flows.test.ts` rows 13 and 14): while a
  member's order is live every `channel_send` names the order it is for (`order`) and goes only to
  that order's own report chat, and a post for another order must not repeat a five-word run of a
  member's order; what a beat read in group A goes into another group B only when a live order of
  an owner or an admin reports to B and names A (title, native id or ref). Open: the gate cannot
  judge a paraphrase of a member's order that shares no five-word run with it.
- [x] An order whose destination chat is removed or closed is paused on the next beat (reason in
  its tail) and one Decision Center question asks to remove it; it is not retried on every beat.
