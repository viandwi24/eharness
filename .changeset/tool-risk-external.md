---
"eharness": minor
---

Tool risk `'external'`, tighten-only MCP annotations and tool traits (spec 11 §3.2, ADR-0025).

- `ToolRisk` gains `'external'` (an effect outside the system: email, third-party post, payment).
  An MCP tool whose server sends `openWorldHint: true` and no app risk is `'external'`;
  `destructiveHint: true` still wins as `'destructive'`; `readOnlyHint` never lowers a risk and no
  MCP spec defaults are applied. Route it with `approval.risk: { external: 'user-approval' }`.
- New `toolTraits(metadata)` export (`ToolTraits`, `ToolHints` types): `{ risk?, idempotent?,
  hints? }`. `idempotent` comes only from app metadata (`tool({ metadata: { idempotent: true } })`);
  `idempotentHint` is reported in `hints` only.
- The `tool.approve` event gains `idempotent?` and `hints?`; `ApprovalDecision` and
  `PendingState.approvals[]` gain `idempotent?`.
- `mcpServer({ risk })` (`eharness/mcp`, type `McpRiskFunction`): a trusted risk for a server's
  tools, as a constant or a function per server tool; invalid values throw `EH_CONFIG_INVALID`.
- **Type-level change:** `ToolRisk` gaining a member breaks exhaustive `switch` statements and
  `Record<ToolRisk, …>` objects, which must add `external`. Behaviour of tools without the new
  hints or metadata is unchanged.
- Fix: when AI SDK re-validates an approved call (the `respond()` continuation), the approval
  function now reads the tool's traits from the tool itself (the stored call carries no
  `toolMetadata`). Before, the risk fell back to `unknown` there, so `approval.risk: { unknown:
  'denied' }` denied calls a person had just approved.
