# P42 — Team example: editable persona ("soul") per agent

Status: todo · Owner: maintainer · Branch: `main` (batched)

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

- [ ] Storage: persona versions + proposals (agent, version, fields, text, author, source, diff, status)
- [ ] Prompt assembly with the five layers; overlay from inherited node settings; next-turn effect
- [ ] `persona` tool + role/approval enforcement in code + injection/size validation + notices
- [ ] People-preference notes on directory profiles (per-person "call me…")
- [ ] Web Persona section (editor, proposals, history/diff/revert)
- [ ] Tests (scripted): admin change from chat with confirmation, member request refused/proposed,
      injected proposal refused, revert, overlay limits, cache prefix stable within a version
- [ ] Docs: walkthrough + README

## Open questions

- Should Telegram chat admins without a directory role be able to propose (not apply)? Default: yes,
  propose only.
