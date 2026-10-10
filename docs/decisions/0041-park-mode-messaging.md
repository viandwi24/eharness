# ADR-0041: Agent messaging in `park` mode

Status: **Accepted** · Date: 2026-10-10 · Builds on: [ADR-0035](0035-nested-approvals-park-the-parent.md), [ADR-0038](0038-agent-messaging.md), [ADR-0040](0040-enqueue-timers-and-ids.md) · Supersedes: the "Park mode: not offered" paragraph of ADR-0038

## Context

ADR-0038 left `send_message` out of `approvals: 'park'`: the in-process directory holds closures of
live child sessions, and with `park` a child may run (or be answered) in another instance. But
`park` is the profile of real deployments (web + server, restarts, several instances), and a lead
agent that cannot follow up with a role agent there needs application code for every follow-up
(P32 request R4).

## Decision

Park mode keeps the tools and the framing of ADR-0038 and replaces the two in-process parts.

**Directory from storage.** A park session's directory holds its **own children** only. It is
rebuilt (`selfAgent` required, throttled: 15 s for the step reminder, 500 ms on a miss) from the
child index (`core.children`, ADR-0037) joined with the `agent` tool inputs stored in the
session's messages (`subagent_type`, `description`, `name`): nothing new is persisted, and names
are checked against it (`nameProblem`), so they are unique across instances and restarts. An entry
has no closures (`durable`); its state (running, waiting, finished) is read from the child's stored
state when needed. No task ids exist in park mode: agents are addressed by name or child session id
(the frame `id` is the child session id).

**Delivery over the durable inbox.** `childSession.enqueue(framed, { mode })`:
- a child with a live turn gets `'steer'` (its next step, ADR-0011 order);
- a child that is idle or finished, or waits for an approval, gets `'queue'`: a new turn on the same
  session (full history, same agent), run by whichever instance holds it. A queued unit is held
  while approvals are pending (spec 05 §12 rule 8), so it runs after they are answered.
The framed text is `<agent-message from id relation="launcher" to="<name>">` with the neutralised
body; `to` is the receiver's own label and marks a park message. Stored order = model order;
the text is stored as the receiver's input (`source: 'user'`, because the inbox only has user
inputs), the frame is what tells the model and a UI that it is an agent message. A target type with
`resumable: false` refuses once finished.

**Reports.** The report of a resumed child goes to its **launcher** (`core.parent`, stored): the
child's `turn.end` hook (in `subagents()` or `subagentChild()`; needs `parentAgent`) recognises a
turn whose first user message is a `relation="launcher"` frame with `to`, and calls
`parentAgent().session(launcher).inject('eh.event', { name: 'subagent', … }, { deliver:
'next-step', wake: true })`, which goes through storage (a wake item when another instance holds
the launcher). The target of the report comes from storage, never from the frame, so forged frame
text can at most produce a spurious report to the real launcher. A resumed turn that stops
`tool-pending` reports nothing automatically (the sender reads it with `agent_output`).

**To `main`.** `parentAgent().session(rootId).enqueue(framed, { mode: 'queue' })`. The root is found
by walking the stored parent links (`parentInfo()`, `parentAgent` at each hop). It is `'queue'`, not
`'steer'`: the root is usually parked `tool-pending` while its child works, and a steer that meets a
`tool-pending` turn is dropped (spec 05 §12 rule 7); a queued turn is held until the parked state
resolves and then runs. A running root therefore sees the message at the end of its turn instead of
its next step.

**`agent_output` / `agent_stop`.** `agent_output` reads the child's stored messages (works across
instances). `agent_stop` is `requestAbort('stopped')` on the child session (spec 05 §9.1); a child
waiting for an approval refuses ("answer the request"). A user stop (`child.abort()`) is
indistinguishable from a model stop in storage, so stopped agents stay resumable.

## Consequences

+ A lead can follow up with role agents, and a role agent can reach the lead, across instances and
  restarts, with no app code.
+ Nothing new in storage; no change to the core.
− Needs `storage.inbox` for cross-instance delivery (without it everything is in-process: a steer
  for a child running elsewhere cannot be delivered) and `selfAgent` (+ `parentAgent` on child
  agents that message `main` or resume).
− A `steer` that reaches a child at the moment its turn stops `tool-pending` is dropped by the
  core (rule 7); the message is lost. Rare, and documented.
− Siblings cannot message each other in park mode; resumed turns bypass `maxConcurrent`; throttling
  counters are per session object; no usage is added to the sender's turn for a resumed run.
