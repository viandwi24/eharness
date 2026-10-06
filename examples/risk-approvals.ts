/**
 * Risk-based approvals with an approval inbox and an audit log: tools declare a risk in their AI
 * SDK metadata (`'external'` for effects outside the system, like sending an email),
 * `approval.risk` maps risks to statuses, pending approvals carry the tool input and risk,
 * `respond()` records who answered (`actor`), and an `approval.decided` hook sees every decision.
 * `toolTraits()` shows how MCP annotations map (tighten-only).
 *
 *   bun examples/risk-approvals.ts
 */
import { tool } from 'ai'
import { type ApprovalDecision, defineHarnessAgent, definePlugin, toolTraits } from 'eharness'
import { z } from 'zod/v4'
import { exampleModel } from './shared/model.ts'

const records = new Map([['r1', 'Invoice draft']])
const outbox: string[] = []

const model = exampleModel([
  { toolCalls: [{ toolName: 'read_record', input: { id: 'r1' } }] },
  {
    toolCalls: [
      { toolName: 'delete_record', input: { id: 'r1' } },
      { toolName: 'send_email', input: { to: 'team@example.com', text: 'r1 was deleted' } },
    ],
  },
  // after the approvals: the delete and the email ran, the model answers
  { text: 'Deleted r1 (Invoice draft) and told the team.' },
])

// Your audit table / approval inbox. The core owns neither (spec 11 §3.3).
const auditLog: ApprovalDecision[] = []
const audit = definePlugin({
  name: 'audit',
  setup: () => ({
    hooks: {
      'approval.decided': (ctx, decision) => {
        auditLog.push(decision)
        const who =
          decision.actor === undefined ? decision.by : `${decision.by} ${decision.actor.id}`
        console.log(
          `audit: ${decision.toolName} ${decision.approved ? 'approved' : 'denied'} by ${who} in ${ctx.session.id}`,
        )
      },
    },
  }),
})

const agent = defineHarnessAgent({
  model,
  contextWindow: 200_000,
  tools: {
    read_record: tool({
      description: 'Read a record.',
      inputSchema: z.object({ id: z.string() }),
      metadata: { risk: 'read' },
      execute: async ({ id }) => records.get(id) ?? `ERROR: no record ${id}`,
    }),
    delete_record: tool({
      description: 'Delete a record for good.',
      inputSchema: z.object({ id: z.string() }),
      metadata: { risk: 'destructive' },
      execute: async ({ id }) => (records.delete(id) ? `Deleted ${id}` : `ERROR: no record ${id}`),
    }),
    send_email: tool({
      description: 'Send an email.',
      inputSchema: z.object({ to: z.string(), text: z.string() }),
      // an effect outside the system; an MCP tool with `openWorldHint: true` gets the same risk
      metadata: { risk: 'external' },
      execute: async ({ to }) => {
        outbox.push(to)
        return `Sent to ${to}`
      },
    }),
  },
  approval: {
    // read runs without asking (and is audited as `by: 'risk'`); destructive, external and tools
    // without a risk need a person. A stricter `policy` or `tool.approve` hook would still win.
    risk: {
      read: 'approved',
      destructive: 'user-approval',
      external: 'user-approval',
      unknown: 'user-approval',
    },
  },
  plugins: [audit],
})

// MCP annotations only tighten: openWorldHint → external, readOnlyHint never yields 'read'
console.log(`mcp hints: ${toolTraits({ annotations: { openWorldHint: true } }).risk}`)
console.log(
  `mcp readOnly: ${toolTraits({ annotations: { readOnlyHint: true } }).risk ?? 'unknown'}`,
)

const session = agent.session('ops-1')
const first = await session.send('Clean up record r1').result
console.log(`turn: ${first.stop}`)

// An inbox needs no message loading: pending approvals carry tool name, input and risk.
for (const p of first.pending?.approvals ?? []) {
  console.log(`inbox: ${p.toolName} ${JSON.stringify(p.input)} (risk: ${p.risk})`)
}

// Later, e.g. from an admin endpoint (check permissions first):
const approvals = (first.pending?.approvals ?? []).map((p) => ({
  id: p.approvalId,
  approved: true,
  reason: 'Checked by the team lead',
  actor: { id: 'u_7', name: 'Ada' }, // passed to approval.decided; never stored or sent to the model
}))
const second = await session.respond({ approvals }).result
console.log(`respond: ${second.stop}; same message: ${second.messageId === first.messageId}`)
console.log(
  `r1 exists: ${records.has('r1')}; emails: ${outbox.length}; audit entries: ${auditLog.length}`,
)

await agent.close()
