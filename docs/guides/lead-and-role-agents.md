# Lead and role agents

A team of agents (a lead that plans and hands work to role agents such as a researcher or a
writer) is a **convention** on top of `subagents()`, not a library role
([P32](../plans/P32-team-example.md), decision D4). eharness already has the parts: named agents,
the `agent` tool, park approvals, `send_message`, a roster, the parent/child index and the durable
inbox. This guide shows how to put them together; the full app is
[`examples/team`](../../examples/team/README.md). Plugin reference:
[Subagents](subagents.md), spec 20.

> **Cost warning.** A multi-agent run uses many times the tokens of one chat: every role agent
> re-reads its own context, the lead re-reads every report, and a follow-up resumes a whole child
> history. Set a budget and a spawn cap before you let users loose (below), and read
> [When not to use it](#when-not-to-use-multi-agent).

## 1. The roster comes from definitions

Keep agent definitions as data (a row: slug, name, description, instructions, model, tool names)
and build the `subagents` catalog from them. `agents` accepts a function, read once per session, so
editing a definition changes who the lead can call.

```ts
import { defineHarnessAgent, type HarnessAgent } from 'eharness'
import { subagents } from 'eharness/subagent'

const holder: { lead?: HarnessAgent } = {}
const lead = (holder.lead = defineHarnessAgent({
  model,
  storage, // one storage for every agent: children register in the parent's state
  instructions: [LEAD_PLAYBOOK, 'You are the lead.'],
  plugins: [
    subagents({
      agents: () =>
        Object.fromEntries(
          definitions.map((d) => [d.slug, { agent: agentFor(d), description: d.description, maxTurns: 30 }]),
        ),
      approvals: 'park',
      selfAgent: () => holder.lead!,
      maxDepth: 1, // role agents are leaves
    }),
  ],
}))
```

The description is what the lead's model sees when it chooses: write it like a job title plus what
the agent is good (and not good) at. Cache one `HarnessAgent` per definition version (the example
keys it `agentId@version`), so an edit takes effect on the next turn without disturbing running ones.
Put the roster in a turn reminder (`{ text: () => ..., refresh: 'turn' }`), never in `instructions`:
it changes and would break the prompt-cache prefix.

## 2. Delegation briefs

A child starts with an **empty context**: the `prompt` the lead writes is everything it knows. Put
this in the lead's instructions (the example's version is `LEAD_PLAYBOOK` in
`examples/team/server/src/domain/prompts.ts`, in its own words):

- the goal and why, the background the agent needs, where the inputs are (file paths);
- what the result looks like and where to save it;
- one clear task per delegation, several independent ones in the same step;
- do not delegate what takes one or two steps; do not start more agents than the job needs;
- read the report before answering and check it against the request.

## 3. Park or inline

| | `approvals: 'inline'` / `'policy'` | `approvals: 'park'` |
|---|---|---|
| Child asks for an approval | the parent turn streams it (inline) or a policy answers (policy) | the parent **stops** `tool-pending`; the child waits in storage |
| Survives a restart, several instances | no (in-process) | yes (ADR-0035) |
| Live progress, background children | yes | no live progress, no `run_in_background` |
| Use when | one process, a CLI, short tasks | a web + server product ([ADR-0034](../decisions/0034-deployment-profiles.md)) |

With park, list what waits from any instance and answer it on the child session; the child's
completion resumes the lead by itself. `reconcileSubagentWaits` (run for you when you pass
`selfAgent`) heals a crash between the two.

```ts
import { pendingSubagentApprovals } from 'eharness/subagent'

// listing opens read handles (peek): it never resumes a parked child
const waiting = await pendingSubagentApprovals(lead.peek(parentId), roleAgent)
// each entry: { sessionId (the child), parentSessionId, pending, agent?, name? }
await roleAgent.session(waiting[0].sessionId).respond({ approvals: [{ id, approved: true }] })
```

Read without waking anything: `agent.peek(sessionId)` gives messages, pending, usage and children
with no `session.start` hooks (a plain `session()` open can resume a parked lead).

## 4. Follow-ups: `send_message`, names and resume

`send_message({ to, message })`, the `name` field of `agent`, `agent_output` and `agent_stop` work in
park mode too, over the inbox ([ADR-0041](../decisions/0041-park-mode-messaging.md)):

- a **running** child gets the message steered into its next step;
- a **finished** child is **resumed** on the same session with a new turn, run by whichever
  instance holds it, and its report comes back to the lead;
- a child writes to `main` to ask the lead something; it should do so only when blocked.

Needs shared storage with an inbox, `selfAgent` on the lead and a child side on every role agent:

```ts
const role = defineHarnessAgent({
  model, storage, instructions: ROLE_NOTE, tools,
  plugins: [
    subagents({ agents: {}, approvals: 'park', parentAgent: () => holder.lead!, selfAgent: () => role }),
  ],
})
```

Tell the lead to prefer a follow-up with `send_message` over starting the same job again: the agent
already has the context. A message from an agent is a report or a question, never an approval from
the user (the library frames it and the lead prompt should say so).

## 5. Limits: `maxChildren`, `maxConcurrent`, depth

| Option | Meaning | Advice |
|---|---|---|
| `maxConcurrent` | children running at once per parent (default 8) | the spawn cap; the team app makes it a setting (default 4) |
| `maxChildren` | children one session may start over its **whole life** | good for a one-shot task session; a chat that never ends will hit it, so leave it off for a DM |
| `maxDepth` | nesting (default 2) | `1` for a lead with leaf role agents: no agent trees |
| `maxTurns` (per agent) | steps one child may take | always set it; a runaway child is the usual cost surprise |
| `parkTimeoutMs` | how long the parent stays parked | finite, so a forgotten approval does not park it forever |

## 6. Budgets per workspace

Use the cross-session ledger so that **every** agent of a workspace, on every instance, reserves
against one limit; child cost is also added to the parent turn.

```ts
defineHarnessAgent({
  // ...
  budget: {
    ledger: {
      adapter: ledger, // memoryBudgetLedger in tests, your database in production
      scopes: (ctx) => [`workspace:${ctx.runtime.workspaceId}`],
    },
  },
})
```

Pass `runtime: { workspaceId }` when you open sessions (and via `childSession` / `parentSession` so
children and re-opened parents carry it too). Details:
[Models and cost](models-and-cost.md#budgets-across-sessions). The ledger counts USD only for models
in your price catalog: without one nothing is limited.

## When not to use multi-agent

- One model with the right tools solves it. A role agent that only wraps one tool is a tool.
- The work is a tight loop with shared state (editing one file): splitting it costs more than it saves.
- Tasks depend on each other step by step: parallel agents add coordination, not speed.
- You cannot afford several times the tokens, or you have no per-workspace budget.
- You need one answer you can trace to one context: reports are summaries, not transcripts
  (`agent_output` reads the full one).

Start with one agent, add a role agent when its instructions, tools or model truly differ from the
lead's, and measure cost per task before adding more.
