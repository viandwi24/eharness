# P21 — Tool risk `'external'`, MCP annotations, approval routing

Status: done · Owner: agent · Branch: `main` (direct commits; P21–P29 ship together as **0.5.0**)

Source: 0.5 prior-art analysis item **#7** (maintainer-only, `docs/tmp/`, not committed). Verdict:
GENERIC-core for the metadata; the routing is a policy the application injects.

Process (0.5.0): develop the whole checklist first, then run **one** gate at the end of the phase
(`lint`, `typecheck`, `test`, `build`, `check:package`, `check:imports`). One consolidated review
of P21–P29 runs at the end of the release.

## Goal

Tools can be classified as `'external'` (the call has an effect outside the system: sends an
email, posts to a third party, pays). MCP tool annotations map onto eharness risk in a documented,
tighten-only way (`destructiveHint` → `'destructive'`, `openWorldHint` → `'external'`,
`readOnlyHint` never lowers anything). Tools carry an `idempotent` trait that later phases (P22
retries, P23 timeouts) can read. Approval routing stays the existing app-injected policy
(`approval.policy` / `approval.risk` / `tool.approve`), now with the new risk and the traits on the
hook event, and the guide documents the mapping in both directions (eharness risk ↔ MCP hints).

## Specs / docs to read

- `docs/specs/11-interaction.md` §2 (`PendingState.approvals[].risk`), §3 (one approval function,
  most restrictive wins), §3.2 (tool risk), §3.3 (`ApprovalDecision`)
- `docs/specs/09-tools-and-mcp.md` §1 (tools are AI SDK tools), §3 (`mcpServer`, the
  "annotations stay in `toolMetadata`" bullet)
- `docs/specs/01-agent-and-plugins.md` §5 (`tool.approve` event shape)
- `docs/specs/03-messages.md` §3 (`metadata.eharness.pending` copy)
- `docs/specs/10-errors-and-stop-reasons.md` §4 (type-level additions note style)
- ADR-0017 (tool risk in AI SDK metadata), ADR-0012, ADR-0008
- `src/registry/risk.ts`, `src/registry/wrap.ts` (`buildApproval`), `src/messages/types.ts`
  (`ToolRisk`, `PendingState`), `src/plugin/types.ts` (`tool.approve`, `ApprovalDecision`),
  `src/mcp/server.ts`, `examples/risk-approvals.ts`, `docs/guides/approvals-and-interaction.md`,
  `docs/guides/tools-and-mcp.md`

**AI SDK / MCP verified (2026-10-06):**

- Latest `ai` is **7.0.128**, `@ai-sdk/mcp` **2.0.67** (`https://registry.npmjs.org/ai/latest`,
  `https://registry.npmjs.org/@ai-sdk/mcp/latest`); installed 7.0.127 / 2.0.66. 7.0.128 changes
  nothing in `toolApproval`, `tool()`, `toolOrder` or UI chunk shapes (its approval fix is the
  client-side `resumeStream()` keeping `approval-responded` state, commit 0fe8c67);
  `@ai-sdk/mcp` 2.0.67 adds `MCPClientError` and SSE/OAuth fixes only
  (`https://raw.githubusercontent.com/vercel/ai/main/packages/ai/CHANGELOG.md`,
  `https://raw.githubusercontent.com/vercel/ai/main/packages/mcp/CHANGELOG.md`).
- `client.tools()` sets `tool.metadata = { clientName, toolName, title?, annotations?: { title?,
  readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint? }, app? }` and copies **only
  the hints the server sent** (no defaults applied); verified in the installed
  `node_modules/@ai-sdk/mcp/dist/index.js` (`toolsFromDefinitions`) and
  `https://github.com/vercel/ai/blob/main/packages/mcp/src/tool/mcp-client.ts`. AI SDK surfaces
  `tool.metadata` as `toolCall.toolMetadata` in the approval function.
- MCP spec defaults (identical in 2025-06-18, 2025-11-25 and the draft): `readOnlyHint` false,
  `destructiveHint` true, `idempotentHint` false, `openWorldHint` true; `destructiveHint` /
  `idempotentHint` are meaningful only when `readOnlyHint` is false; all hints are untrusted
  unless the server is trusted
  (`https://modelcontextprotocol.io/specification/2025-06-18/server/tools`,
  `https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2025-11-25/schema.ts`).
- `toolApproval` (generic function `({ toolCall, tools, toolsContext, runtimeContext, messages })`
  or per-tool map) returns `ToolApprovalStatus` (`'not-applicable' | 'approved' | 'denied' |
  'user-approval'` or `{ type, reason? }`) — unchanged
  (`https://ai-sdk.dev/docs/agents/tool-approvals`).
- **No devDependency bump needed** for this phase (P29 may bump the devDependencies to 7.0.128 /
  2.0.67 for CI hygiene; the peer floors stay `^7.0.127` / `^2.0.66`).

## Owns

`src/registry/risk.ts`, the risk / traits parts of `src/registry/wrap.ts`, `ToolRisk` in
`src/messages/types.ts`, the `tool.approve` event and `ApprovalDecision` in `src/plugin/types.ts`,
`src/mcp/server.ts` (option `risk`), `src/index.ts` (new exports), specs 11 §3.2 / 09 §1, §3 /
01 §5, ADR-0025 (new), `examples/risk-approvals.ts`, the risk sections of
`docs/guides/approvals-and-interaction.md` and `docs/guides/tools-and-mcp.md`.

## Design

```ts
export type ToolRisk = 'read' | 'write' | 'destructive' | 'external'

/** Traits of a tool, from trusted app metadata first, then (tighten-only) MCP hints. */
export interface ToolTraits {
  risk?: ToolRisk
  /** Only from app metadata (`tool({ metadata: { idempotent: true } })`): MCP's idempotentHint
   *  would loosen retry behaviour and is therefore reported separately, never used by the core. */
  idempotent?: boolean
  /** Raw MCP hints as the server sent them (untrusted), for app policies and UIs. */
  hints?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
}
export function toolTraits(metadata: unknown): ToolTraits      // replaces the internal riskOf()

// tool({ metadata: { risk?: ToolRisk; idempotent?: boolean } })   — app-declared, trusted
// mcpServer({ …, risk?: ToolRisk | ((tool: { name: string; annotations?: McpToolAnnotations }) => ToolRisk | undefined) })
```

Normative rules (spec 11 §3.2 rewrite):

1. **App metadata wins.** `metadata.risk` (a valid `ToolRisk`) is the risk; it is trusted, so it
   may be lower than the hints suggest. `mcpServer({ risk })` writes `metadata.risk` on its tools
   (trusted app input, same rank).
2. **Hints only tighten.** Without an app risk: `destructiveHint === true` → `'destructive'`;
   else `openWorldHint === true` → `'external'`; `readOnlyHint` and `idempotentHint` are never
   used to derive or lower a risk. Only hints the server **sent** count (AI SDK applies no
   defaults; eharness applies none either — see open question 1); a tool without hints stays
   `unknown`.
3. **One risk per tool**, precedence for derived risks `destructive` > `external`.
   `approval.risk.external` is one more input of the most-restrictive combination (unchanged).
4. **Events carry traits.** `tool.approve` gains `idempotent?` and `hints?`; `ApprovalDecision`
   and `PendingState.approvals[]` keep `risk` (now possibly `'external'`) and gain
   `idempotent?` (absent = unknown). No new persisted field other than those optional ones.
5. **Mapping back** (docs only, guide table): `read` ↔ `readOnlyHint: true`; `write` ↔
   `readOnlyHint: false, destructiveHint: false, openWorldHint: false`; `destructive` ↔
   `destructiveHint: true`; `external` ↔ `openWorldHint: true` (and `destructiveHint` as the
   tool requires). eharness exposes no MCP server, so no helper is exported for this direction.

## Checklist

- [x] ADR-0025 "External risk and tighten-only MCP annotation mapping" (amends ADR-0017): why one
      risk per tool, why hints never loosen, why `idempotent` is app-only, why no spec defaults.
- [x] Specs: 11 §3.2 (rules 1–5), §2 / §3.3 (`idempotent?`), 01 §5 (`tool.approve` event
      fields), 09 §1 (traits), §3 (annotation bullet rewritten + `risk` option), 03 §3 if the
      pending copy changes, 10 §4-style type-level note for `ToolRisk`.
- [x] `ToolRisk` gains `'external'`; `toolTraits()` exported from `src/index.ts` (TSDoc, explicit
      return type); `riskOf()` becomes a thin internal wrapper or is removed.
- [x] `buildApproval` passes `idempotent` / `hints` to `tool.approve`; decisions and pending
      approvals carry `idempotent` when known.
- [x] `mcpServer({ risk })`: constant or function per server tool (before prefixing); invalid
      values → `EH_CONFIG_INVALID` from `mcpServer()`; function errors → tool keeps derived risk +
      `ctx.log.warn`.
- [x] Tests: unit table for `toolTraits` (app risk wins incl. lower than hints, destructive >
      external, readOnly never lowers, idempotentHint ignored for `idempotent`, invalid risk
      strings ignored); approval int test (`approval.risk.external: 'user-approval'` asks for an
      MCP tool with `openWorldHint: true`; a hook cannot be loosened by risk); MCP int test with
      the test kit server sending each hint; `mcpServer({ risk })` override; pending state carries
      `risk: 'external'`; `.test-d.ts` that `ToolRisk` includes `'external'`.
- [x] `examples/risk-approvals.ts`: an `external` tool (send email) routed to `user-approval`.
- [x] Guides: approvals guide "Routing by risk" with the two-way mapping table and a policy
      example (`external` → ask, `destructive` → deny for non-admins via `actor`/runtime);
      tools-and-mcp guide annotations section.
- [x] Changeset; board; gate.

## Acceptance criteria

- [x] An MCP tool with `openWorldHint: true` and no app risk is `'external'`; with
      `readOnlyHint: true` and `destructiveHint: true` it is `'destructive'`; with only
      `readOnlyHint: true` it is `unknown` (never `'read'`).
- [x] An app `metadata.risk: 'read'` on an MCP tool with `destructiveHint` gives `'read'`.
- [x] Behaviour for tools without hints or risk is byte-identical to 0.4 (goldens unchanged).
- [x] lint, typecheck, test, build, check:package, check:imports green.

## Changeset

`minor`:

- `ToolRisk` gains `'external'`; MCP `openWorldHint: true` maps to it (tighten-only);
  `approval.risk.external` routes it.
- New `toolTraits(metadata)` export; `tool.approve` event gains `idempotent?` / `hints?`;
  `ApprovalDecision` and pending approvals gain `idempotent?`.
- `mcpServer({ risk })` sets a trusted risk for a server's tools.
- Type-level: `ToolRisk` gaining a member breaks exhaustive `switch`es and `Record<ToolRisk, …>`
  objects (must add `external`); behaviour without the new hints is unchanged.

## Open questions

1. **Apply MCP spec defaults** (`destructiveHint` / `openWorldHint` default true) when a hint is
   absent? It would tighten, but every MCP tool without annotations would become
   `'destructive'` — a large behaviour change in a minor. Conservative pick: **no defaults**;
   tools without hints stay `unknown`, and the guide recommends
   `approval.risk: { unknown: 'user-approval' }` for untrusted servers (that is what the spec
   defaults mean in practice).
2. **Multiple risks per tool** (a destructive open-world tool)? Pick: one risk, precedence
   `destructive` > `external`; apps that need both write `metadata.risk` or a hook reading
   `hints`.
3. **`idempotentHint` as `idempotent`?** Pick: no (loosening). Reported in `hints` only.
4. Should `read` require `readOnlyHint` from a trusted server option (`mcpServer({ trustHints:
   true })`)? Pick: not in 0.5.0 — `mcpServer({ risk })` covers trusted servers explicitly.
5. (implementation) A `mcpServer({ risk })` function returning an invalid value is treated like a
   throwing one (derived risk + `ctx.log.warn`), not `EH_CONFIG_INVALID` — it runs at listing
   time, where throwing would drop the whole source. `riskOf()` stays as an internal one-line
   wrapper of `toolTraits().risk`. `ToolHints` is exported as a named type for the `hints` shape
   (structurally `McpToolAnnotations` without `title`; core cannot import `@ai-sdk/mcp` types).

## Requests to other phases

- P22, P23: read `idempotent` from `toolTraits` / pending entries if they need it; do not add a
  second trait source.
- P26: the guard's read fast path uses the derived risk (`read` only from app metadata or
  `mcpServer({ risk })`).
- P28: `openApiTools` sets `metadata.risk` (trusted) per operation.
- P29: reference + README risk table.

## Dependencies

None (wave W1, in parallel with P22 — no file overlap besides `src/index.ts` and specs 10/11).

## Notes (implementation)

- Found and fixed while testing: AI SDK's re-validation of approved calls passes the stored call
  without `toolMetadata`, so traits fell back to `unknown` (with `approval.risk.unknown: 'denied'`
  a user-approved call was denied). `buildApproval` now falls back to `options.tools[name].metadata`
  (spec 11 §3.2 rule 5, changeset).
- Gate (end of phase): lint, typecheck, test (1004 tests, 964 pass, 0 fail), build,
  check:package, check:imports green.
