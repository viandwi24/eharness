# P50 — Follow-up hardening

Status: done · Owner: agent

## Goal

Rough edges found while using the team example no longer trip the agents: code runs
where the OS sandbox cannot start, "Allowed" means allowed, approvals reach the owners, the agent
finds (or is told why it cannot find) its tools, and readable errors name the fix.

## Specs

- `docs/specs/02-context-registry.md` §3.2–3.3 (tool search `select:`, short unknown-tool text, repeat guard)
- `docs/specs/08-filesystem-plugin.md` (grep inline flags), `docs/specs/19-shell-plugin.md` (`probeOsSandbox`)
- `docs/specs/03-messages.md`, `docs/specs/12-models-and-cost.md` (unsupported file note tells the model what to say)

## Checklist

- [x] `probeOsSandbox()`; team code runtime and data-work runner fall back when bubblewrap cannot
      create namespaces; Settings and the boot log say why
- [x] Files & Sandbox `run_python` set to Allowed runs without asking (Manual mode)
- [x] Chat approvals also ring the owners' bell with a link; the chat text says who may approve
- [x] tool_search: `select:` names what is missing and why (`ToolSourceDef.explain`), repeats are
      answered without searching again; unknown-tool errors are short; channel native actions are
      served per turn (a session opened before the account connected still gets them)
- [x] grep accepts `(?i)`, `(?s)`, `(?m)`; chat_history accepts a connector id; program_note
      accepts the proposal id; channel_read matches attachments by stored name and lists forum topics
- [x] Telegram links keep trailing punctuation outside; MTProto "peer not in cache" is readable
- [x] A message that only mentions the agent is not small talk; the turn names the sender's recent
      untagged messages
- [x] Programs: channel_describe, channel_status, list_topics are base tools; a refused search names
      the readable roots; brief-vs-authority warnings (memory writes, run_python)
- [x] Text-only model told to say it cannot see an image (no OCR workarounds)
- [x] Browser: the per-profile `trusted` coupling to connection modes is removed (one built-in
      connection); duplicate attachments are skipped

## Open questions

- A duplicate photo seen once could not be reproduced (defensive fixes only).
