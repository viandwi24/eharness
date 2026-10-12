# P42 — Team example: editable persona ("soul") per agent

Status: done · Owner: maintainer · Branch: `main` (batched)

## Goal

Whoever is allowed can shape an agent's persona — voice, tone, identity, behaviour preferences — from
the web AND by talking to the agent ("from now on be more formal", "call yourself Sari"), and the change
persists, is reviewable and can be reverted. Persona never weakens the system's rules.

Research (2026-10-12): OpenClaw (SOUL.md / IDENTITY.md / AGENTS.md / USER.md, files read at session
start, agent may edit SOUL.md but must disclose it; no approval or revert in product; a public PoC used
prompt injection to keep overwriting SOUL.md), Hermes (SOUL.md human-edited and injection-scanned,
`/personality` presets as session overlays, agent-edited MEMORY/USER notes that never change the persona),
Letta (persona/human blocks with char limits, lockable read-only), Claude Code output styles, ChatGPT
"memory updated" notices.

## Decisions

Prompt layers, in order (static before dynamic, prompt-cache prefix):
1. **System rules** — code-owned, immutable (roles only from the header, no internal mechanisms to chat
   users, no invented names, safety). Never editable.
2. **Persona** — editable: structured identity (display name, short self-description, language, emoji
   on/off) + free-text voice and preferences, ~6,000 characters, versioned.
3. **Operating rules** — admin-only text (what the agent is responsible for, escalation habits).
4. **Team notes / people preferences** — agent-writable memory ("call Vian 'Pak Vian'" goes to that
   person's directory profile notes), never the persona.
5. **Channel overlay** — per node (inherited setting): tone/language/length only, ~1,000 characters;
   cannot widen tools or loosen rules.
Volatile context stays in turn reminders.

Changing the persona:
- `persona` tool (generic, for every agent): `view`, `propose` (a diff + reason, with the proposer's
  identity and message provenance), `apply` (harness-enforced), `revert`, `history`.
- Who: web users (token holders = admins); in chat only people whose DIRECTORY role is owner/admin.
  Members and guests may ask; the agent answers that an admin must approve, and may open a proposal
  for admins to review. The agent never proposes changes unprompted. Proposals that originate from
  untrusted content (fetched pages, files, forwarded messages) are refused.
- Confirmation: in chat the proposal shows a short diff and asks the admin to confirm (buttons or a
  reply, the in-chat question mechanism); in the web it appears under Pending proposals. Apply checks
  role and proposal id in code, validates size and obvious injection patterns ("ignore previous
  instructions", tool-permission language), commits a new version and posts a visible notice
  ("Persona updated by Vian: …").
- Effective from the next turn (static prefix rebuilt), every version kept with author, source
  (web/chat), diff and revert (a revert is a new version).

Web: agent settings get a Persona section — Identity, Voice & preferences, Operating rules, Channel
overlays (link to the Channels page setting), Pending proposals, History with diff/revert.

## Checklist

- [x] Storage: persona versions + proposals (agent, version, fields, text, author, source, diff, status)
- [x] Prompt assembly with the five layers; overlay from inherited node settings; next-turn effect
- [x] `persona` tool + role/approval enforcement in code + injection/size validation + notices
- [x] People-preference notes on directory profiles (per-person "call me…")
- [x] Web Persona section (editor, proposals, history/diff/revert)
- [x] Tests (scripted): admin change from chat with confirmation, member request refused/proposed,
      injected proposal refused, revert, overlay limits, cache prefix stable within a version
- [x] Docs: walkthrough + README

## Notes (as built)

Review pass: `applyProposal` now commits the version first and marks the proposal applied after (a
version conflict leaves it pending); the agent factory keeps weak refs to live sessions. Tests of
this pass are written, not run.

Code: `domain/persona.ts` (pure: limits, injection patterns, diff, prompt layers, legacy split),
`app/persona.ts` (use cases), `infra/db/persona-repo.ts`, `infra/eh/persona-plugin.ts` (the tool),
`infra/channels/people-notes.ts` + the `person_note` tool, `personaOverlay` as a node setting
(`policy.ts`), web `PersonaPanel.svelte`. Migration `0028_tiny_shatterstar`: three new tables
(`agent_persona_versions`, `agent_persona_proposals`, `ch_people_notes`), nothing altered. Tests:
`server/test/persona.test.ts`, `web/src/lib/persona/model.test.ts`.

Decisions taken while building (where the plan left room):

- **Confirmation is the harness approval, not the model's question.** The plan said "the in-chat question
  mechanism". A question answered through `ask_user_question` is only text to the model: `apply` could not check
  it in code. `apply` and `revert` therefore return `user-approval` from `tool.approve` (no policy, mode or session
  grant skips it; `tool.grantScope` returns `null`), which is the same chat surface (buttons or a reply; only an
  owner or admin can answer, `mayAnswer`) and the usual approval card in the web. `tool.before` fills a `change`
  field with the system's own summary of the diff, so the card shows what changes, not what the model says.
- **Operating rules are web-only.** `propose` carries identity and voice, never operating rules; a revert restores
  identity and voice and keeps the current operating rules. The agent can read them (they are in its prompt), not
  change them.
- **Provenance in code.** A turn is *tainted* by any tool result that is not system state (`TRUSTED_TOOLS` in the
  plugin: persona, channel_status, list_topics, member_lookup, person_note, memory_view (the system's own /memories),
  tool_search, ask_user_question), by a
  file in the turn, and by a forwarded trigger message (`Requester.forwarded`). A tainted turn cannot propose.
  `request` must be an exact quote of the turn's user text.
- **Overlay and people notes are turn reminders**, not instructions: they are per place or per person and change
  without a new persona version. The overlay is validated when it is written (`writePolicy`).
- **Retest fixes.** Web threads have `person_note` too (`web-person-note.ts`): the note is kept on the profile
  `web:owner` of the connection `web` (the web app has no per-person sign-in to link to a directory person) and
  reaches web turns as a reminder. A memory write that records a communication style or persona preference
  ("call me Pak Vian", "short answers") is refused with a redirect to `person_note` / `persona` (`styleNoteIn`).
  After a persona version change the next turn of an open session gets one line ("the persona changed to version
  N; follow the current persona, not the style of earlier replies"), and the revert notice says that personal
  notes are kept.
- **The new tool is a plugin, not a connector.** `persona` and `person_note` are always there (like
  `propose_plan`); `persona` is in the member allow list so a member can view and propose, the tool itself refuses
  apply and revert for anybody but an owner or admin. A guest cannot use it.
- **Visible notice.** After an apply or revert the system posts the notice into the chat (`gateway.post`) and
  the tool result tells the model; the history and the agent-changed event show it in the web.
- **Next-turn effect in a chat that is already open.** A session object keeps claiming its inbox, so after a
  persona version the factory closes the idle sessions of the replaced build in `prepare` (`closeSuperseded`); a
  session with a running turn or pending approval keeps its build until idle.
- **Name.** The persona's display name is what the reminder (`You are ...`) and the chat rules say; the agent
  definition's name stays the team-internal name (roster, board).

Open questions:

- Telegram chat admins without a directory role cannot even propose (the guest role has no tool access); the
  plan's default ("propose only") would need the tool in the guest allow list. Left as is: the safer choice.
- Closing the idle sessions of a replaced build waits for idle and skips a session with pending state. The lead's
  delegations are `park` children that outlive their parent session (spec 20), so they are not aborted; this was
  read from the subagent code, not exercised with a persona change during a live delegation.
