# ADR-0034: Deployment profiles: autonomous, single-process interactive, split web/server

Status: **Accepted** · Date: 2026-10-09 · Builds on: [ADR-0008](0008-plugins-adapters-dogfooding.md), [ADR-0012](0012-approvals-server-owned-pending.md), [ADR-0027](0027-external-waits-park-at-the-tool-boundary.md)

## Context

eharness is a general framework for building agent harnesses. Real products fall into three
shapes, and the library must serve all of them without favouring the one that is easiest to demo:

- **(a) Autonomous server.** No human. A trading or ops agent runs on a server and nothing may
  wait for a person. Approvals are bypassed or decided by policy; budgets, the progress guard and
  sandboxing are the safety net.
- **(b) Single-process interactive.** A CLI or TUI where the UI and the agent share one process.
  Approvals are answered in process. The user picks a mode (manual, auto-accept, bypass) and sees
  tools and approvals live. The sandbox is separate from the UI.
- **(c) Split web/server.** The browser is only a chat UI. The server runs turns, may restart, and
  may scale to several instances. Pending state lives in storage; an answer can arrive at any
  instance at any time.

Prior art in terminal and client-server coding agents mostly serves (b), and its approvals and
waits are in-memory objects of one process. That is the shape a library is tempted to copy.

## Decision

Every core feature and every shipped module must work in all three profiles.

1. **Human interaction is never required by a module.** Approvals and questions are optional
   hooks. A profile answers them in process (callbacks or brokers), through storage
   (`tool-pending` plus `respond()`, external waits, ADR-0027), or not at all (bypass, `dontAsk`).
2. **No module holds the only copy of state in memory when a durable form exists** (pending state,
   waits, inbox). In-process shortcuts are allowed for single-process use, but each has a durable
   equivalent that a profile (c) deployment can select.
3. **Node-only capabilities live in separate Node-only subpaths** (disk, shell, OS sandbox) so the
   core stays runtime-neutral; see [ADR-0036](0036-node-only-modules.md).
4. **Modules take policy as options** (permission mode, approval answerer, sandbox driver) and
   never hard-code a UI.

### Feature by profile

| Feature | (a) Autonomous server | (b) Single-process interactive | (c) Split web/server |
|---|---|---|---|
| Approvals | bypass or allow-all policy, `dontAsk`; deny rules and the approval guard still apply | permission mode chosen by the user; answered in process | `tool-pending`; browser answers via `respond()` on any instance |
| Questions (`eharness/ask`) | not offered, or answered by policy | answered in process by the UI | client tool; the answer arrives through `respond()` |
| Subagents (`eharness/subagent`) | child approvals resolved by policy (`'deny'`) | `'inline'`: caller-supplied answerer | `'park'`: parent parks as an external wait ([ADR-0035](0035-nested-approvals-park-the-parent.md)) |
| Shell / sandbox (`eharness/shell`) | OS sandbox driver, no prompts | local or OS sandbox driver, separate from the UI | sandbox driver on the server (or a remote sandbox); never in the browser |
| Filesystem | `diskFs` or `memoryFs` | `diskFs` (Node-only) | adapter over object storage or `memoryFs` per tenant |
| Background tasks | in process, results through the inbox | in process; UI shows live state | results enter through the durable inbox (ADR-0024) or `resolveWait()` |
| Notifications | none, or app-level logs and webhooks | UI events from the session event stream | stored as messages or inbox items; the UI reads them from storage |

### How the three shapes configure it

- **Coding-agent example (b).** `diskFs`, the `eharness/shell` tool with a local or OS sandbox,
  `eharness/permissions` with a user-selected mode, an in-process answerer for approvals and
  questions, `subagentTool` with `approvals: 'inline'`.
- **Web chat (c).** Storage-backed adapters with `setIf` or a lock, approvals through
  `tool-pending` and `handleChatRequest()`, `subagentTool` with `approvals: 'park'`, external
  waits for slow tools, durable inbox for background results.
- **Autonomous agent (a).** Permissions in bypass or `dontAsk` mode, `subagentTool` with
  `approvals: 'deny'` (policy), budgets and the progress guard on, shell inside an OS sandbox,
  no ask tool.

## Consequences

- A shipped module that needs a person must expose the need as an optional hook plus a durable
  path; it may not assume a UI, a TTY or an in-memory registry.
- Profile (c) is the reference for state: if a feature works with several instances and restarts,
  it works for (a) and (b) too. Profile (b) shortcuts are additions, not the only implementation.
- Conformance and docs describe each module per profile; the multi-instance guide stays the
  deployment reference for (c).
- Existing behaviour does not change; this ADR constrains new modules and reviews.
