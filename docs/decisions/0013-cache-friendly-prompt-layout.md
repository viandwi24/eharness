# ADR-0013: Cache-friendly prompt layout with reminders

Status: **Accepted** · Date: 2026-09-29

## Context

Prompt caching cuts cost and latency of long agent loops by up to an order of magnitude, but
providers cache a strict prefix (tools → system → messages). Harnesses that put dates, todo lists,
file states or per-step hints into the system prompt invalidate the whole cache every turn.
Claude Code keeps the system prompt stable and sends volatile context as `<system-reminder>`
blocks inside messages.

## Decision

- `instructions` is a `SystemModelMessage[]`: block 1 static, block 2 session-refresh; both stable
  for a session.
- Turn-refresh instructions go to a **turn reminder** inserted before the current turn's first
  message; `step.prepare` reminders go to a **step reminder** at the end of the wire. Reminders
  are user messages wrapped in `<system-reminder>`, rebuilt per step, never stored.
- Tool order is stable and passed as `toolOrder`; `activeTools` changes warn `W_CACHE_BUST`.
- `cache: { mode: 'auto' | 'breakpoints' }` adds Anthropic `cacheControl` only for Anthropic
  models; other providers cache automatically or not at all.

## Consequences

+ Cached prefix survives across steps and turns; cache usage is recorded in metadata.
− Turn-refresh instructions are no longer "system" text; models follow reminders well in practice,
  but it is a behavioural difference to document.

## Alternatives considered

- Rebuild the system prompt each step (rejected: cache busting).
- Leave caching to the application (rejected: the layout is the harness's job).
