# Spec 15 — Approval guard plugin (`eharness/guard`)

Status: **Draft (0.5)**. Module: `src/guard/*`. Built only with the public core API (ADR-0008).
Design: [ADR-0030](../decisions/0030-llm-approval-guard-plugin.md).

An LLM judge on the existing approval chain (spec 11 §3): a second, cheap model reviews tool calls
and can only **tighten** — deny a call (with a reason the agent reads) or escalate it to a person
(the normal pending flow). It never approves. The judge reads a restricted transcript built by the
core (spec 11 §3.4) — user messages and tool calls only — so a prompt injection inside a tool
output cannot talk to it.

## 1. Usage

```ts
import { approvalGuard } from 'eharness/guard'

defineHarnessAgent({
  model,
  // permissive base: the guard decides what needs a person
  approval: { risk: { read: 'approved', write: 'approved', external: 'approved', destructive: 'user-approval' } },
  plugins: [approvalGuard({ model: 'openai/gpt-5-mini', policy: 'Emails go only to @acme.com.' })],
})

export interface ApprovalGuardOptions {
  model: LanguageModel                         // the judge; usage charged to the turn (§7)
  policy?: string                              // default GUARD_DEFAULT_POLICY
  skipRisks?: Array<ToolRisk | 'unknown'>      // default ['read'] — fast path, no judge call
  skipTools?: string[]                         // tool names (after prefixing) never reviewed
  onlyTools?: string[]                         // when set, only these names are reviewed
  transcript?: { maxMessages?: number /* 20 */; maxChars?: number /* 12_000 */ }
  timeoutMs?: number                           // default 15_000 → user-approval
  maxRetries?: number                          // AI SDK retries of the judge call, default 1
  maxConsecutiveDenials?: number               // default 3; Infinity disables the breaker
  cache?: { maxEntries?: number /* 200 */; ttlMs?: number /* default: no expiry */ }
}
export function approvalGuard(options: ApprovalGuardOptions): HarnessPlugin<'guard'>
```

Invalid options (missing `model`, empty `policy`, a non-positive number, a negative or
non-integer `maxRetries`) throw `EH_CONFIG_INVALID` at `approvalGuard()`.

The plugin registers a `tool.approve` hook and an `approval.decided` hook; it adds no tools,
instructions, data parts or services.

## 2. Rules (normative)

1. **Tighten only.** The hook returns `'not-applicable'` (judge allows, skipped, cached allow),
   `{ type: 'denied', reason }` or `{ type: 'user-approval', reason }` — never `'approved'`. With
   most-restrictive-wins (spec 11 §3) it cannot loosen a policy, a risk rule, another hook or a
   denial grant. The intended setup is a permissive base (`approval.risk`) plus the guard. A
   session grant `always` (spec 11 §3.1) is a person's standing answer and turns the guard's
   `user-approval` into `approved` like any other; it never overrides the guard's `denied`.
2. **Restricted view.** The judge prompt contains only the policy, the transcript (the event's
   `transcript()`, spec 11 §3.4: user text, user files as `[file: name, mediaType]`, the agent's
   earlier tool calls with inputs) and the call under review (`toolName`, `risk` or `'unknown'`,
   `input`). Never tool outputs, assistant text, reasoning, system instructions, reminders,
   kind messages or `data-*` parts. The view is built in core, so the plugin cannot widen it.
   Transcript and call are JSON-encoded (an entry cannot close a section). Limits: the last
   `maxMessages` entries; every entry and the call input cut to `maxChars` (marker
   `GUARD_TRUNCATED`); oldest entries dropped until the transcript fits `maxChars`.
3. **Fast path.** `onlyTools`, `skipTools` and `skipRisks` decide before anything else; a skipped
   call returns `'not-applicable'`, makes no model call and records nothing. The risk is the
   event's `risk` (P21 traits; `read` only from trusted app metadata, spec 11 §3.2), `'unknown'`
   when absent. `'unknown'` is not skipped by default (MCP tools without hints are reviewed).
4. **Cache and determinism.** Plugin state (`plugins.guard`, spec 05 §7) holds, per session:
   - `calls`: the status returned per `toolCallId` (bounded by `cache.maxEntries`). A call seen
     before gets the same answer without a model call — AI SDK's re-validation of an approved call
     in a `respond()` continuation, possibly in another process, therefore never calls the judge
     and never turns a person's approval into a denial (the rule "approval hooks must be
     deterministic" holds per session);
   - `verdicts`: judge verdicts keyed by `toolName + ':' + sha256(canonicalJson(input))`
     (`crypto.subtle`; `input` after `tool.before` refinement), LRU-bounded by
     `cache.maxEntries`, optionally expiring after `cache.ttlMs`. The same call (same tool and
     input) with a new id reuses the verdict.
   The state is persisted with the turn, so it survives a cold reload. Verdicts are never shared
   across sessions (they could leak decisions between users).
5. **Circuit breaker.** `denials` (plugin state) counts consecutive `denied` answers (fresh or
   cached verdicts). When it has reached `maxConsecutiveDenials`, a further `deny` verdict
   returns `user-approval` with `GUARD_BREAKER` instead (the counter stays) — so the agent cannot
   loop on denials. An `allow` verdict, or any `approval.decided` with `by: 'user'` (a person
   answered), resets the counter. `ask` leaves it unchanged.
6. **Fail closed to a person.** A judge error, timeout (`timeoutMs`, or the turn's abort), an
   unparseable or invalid verdict → `user-approval` with `GUARD_UNAVAILABLE` and
   `W_GUARD_UNAVAILABLE` (once per turn, `details: { tool, toolCallId, error }`). The answer is
   recorded in `calls` (rule 4) but not cached as a verdict. Never `approved`, never a silent
   `not-applicable`.
7. **Usage.** Every judge call that reports usage — including a failed parse that still reports
   it — calls `ctx.turn.addUsage(usage, { source: 'guard', model })`: it counts toward
   `TurnResult.usage`, `costUsd`, turn/session budgets and caps, and is recorded in the budget
   ledger (spec 12 §4.1 rule 3).
8. **Audit.** Automatic denials are reported by the core with `by: 'plugin:guard'` and the reason
   (spec 11 §3.3); the plugin adds nothing to `approval.decided`.

The judge runs even when another source already denies the call (a hook cannot see the other
statuses); exclude such tools with `skipTools` to save the call.

## 3. Judge call

```ts
generateText({
  model, instructions: GUARD_INSTRUCTIONS, prompt,           // prompt = GUARD_PROMPT filled
  output: Output.object({ schema: z.object({ decision: z.enum(['allow', 'ask', 'deny']), reason: z.string() }) }),
  abortSignal: AbortSignal.any([AbortSignal.timeout(timeoutMs), turn.abortSignal]),
  maxRetries,
})
```

`result.output` is validated again; anything else is "unavailable" (rule 6).

## 4. Verdict → status

| Verdict | Status | Reason (model / pending UI) |
|---|---|---|
| `allow` | `'not-applicable'` | — |
| `ask` | `user-approval` | `GUARD_ASK` |
| `deny` | `denied` | `GUARD_DENIED` (the model reads it in the denied tool result) |
| `deny`, breaker reached | `user-approval` | `GUARD_BREAKER` |
| unavailable | `user-approval` | `GUARD_UNAVAILABLE` |

## 5. Texts

Exported constants (model-visible; changing one is a minor change): `GUARD_INSTRUCTIONS`,
`GUARD_DEFAULT_POLICY`, `GUARD_PROMPT` (`{policy}`, `{transcript}`, `{call}`), `GUARD_DENIED`
(`{reason}`), `GUARD_ASK` (`{reason}`), `GUARD_BREAKER` (`{count}`, `{reason}`),
`GUARD_UNAVAILABLE` (`{error}`), `GUARD_TRUNCATED`. Helpers: `canonicalJson(value)`,
`verdictKey(toolName, input)` (rule 4).

## 6. Limits

An LLM judge is a probabilistic second line, not a security boundary: deterministic rules
(`approval.policy`, `approval.risk`, sandboxing, least-privilege credentials) stay the first line.
The judge adds latency (one model call per reviewed, uncached call, before the tool runs) and
cost. Injections that the user typed, or that the agent copied from a tool output into a tool
call's input, are visible to the judge (the input is what it reviews).
