---
"eharness": minor
---

**New: risk-based approval and approval decisions** (spec 11 §3.2–3.3, ADR-0017):

- Tools declare a risk in AI SDK metadata: `tool({ metadata: { risk: 'read' | 'write' | 'destructive' } })`;
  MCP tools with `destructiveHint` are `'destructive'` (`readOnlyHint` is ignored). New exported
  type `ToolRisk`.
- `approval.risk` maps a risk (or `unknown`) to an approval status, combined most-restrictive-wins
  with the policy, hooks and grants. `tool.approve` hooks receive `risk`.
- Pending approvals (`TurnResult.pending`, `state.core.pending`, `pending` events) now include the
  tool `input` and `risk`.
- New hook `approval.decided` receives every automatic decision (`by: 'policy' | 'risk' | 'grant' |
  'plugin:<name>'`), every `respond()` answer (`by: 'user'`) and new-input denials
  (`by: 'new-input'`), for audit logs and approval inboxes.
- `respond({ approvals: [{ …, actor: { id, name } }] })` records who answered; it is passed to
  `approval.decided` and never stored or sent to the model.
