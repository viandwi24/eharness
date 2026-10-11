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
import { guard } from 'eharness/guard'

defineHarnessAgent({
  model,
  // permissive base: the guard decides what needs a person
  approval: { risk: { read: 'approved', write: 'approved', external: 'approved', destructive: 'user-approval' } },
  plugins: [guard({ model: 'openai/gpt-5-mini', policy: 'Emails go only to @acme.com.' })],
})

export interface GuardOptions {
  model: LanguageModel                         // the judge; usage charged to the turn (§7)
  policy?: string                              // default: a built-in policy (§5)
  skipRisks?: Array<ToolRisk | 'unknown'>      // default ['read'] — fast path, no judge call
  skipTools?: string[]                         // tool names (after prefixing) never reviewed
  onlyTools?: string[]                         // when set, only these names are reviewed
  transcript?: { maxMessages?: number /* 20 */; maxChars?: number /* 12_000 */ } // the transcript view only
  maxCallChars?: number                        // longest call input judged, default 8_000 (DEFAULT_JUDGE_MAX_CALL_CHARS); longer → ask a person
  timeoutMs?: number                           // default 15_000 → user-approval
  maxRetries?: number                          // AI SDK retries of the judge call, default 1
  maxConsecutiveDenials?: number               // default 3; Infinity disables the breaker
  cache?: { maxEntries?: number /* 200 */; ttlMs?: number /* default 3_600_000 (1 h); Infinity = no expiry */ }
}
export function guard(options: GuardOptions): HarnessPlugin<'guard'>
```

Invalid options (missing `model`, empty `policy`, a non-positive or NaN number, a negative or
non-integer `maxRetries`) throw `EH_CONFIG_INVALID` at `guard()`.

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
   kind projections or `data-*` parts the core wrote. Text an application projects into a user
   message by itself (e.g. a group history block) is user text to the core and does appear. The
   view is built in core, so the plugin cannot widen it.
   Transcript and call are JSON-encoded (an entry cannot close a section). Limits: the last
   `maxMessages` entries; every transcript entry cut to `maxChars` (marker `…[truncated]`); oldest entries dropped until the transcript fits `maxChars`.
2b. **Truncated input fails closed.** When the call input is longer than `maxCallChars`
   (default 8 000; not the transcript window, `transcript.maxChars`; `callInputTruncated`), the judge would see only its head, so the guard does not judge it:
   the answer is `user-approval` (reason via the `GUARD_ASK` text plus an internal "input too long" explanation), recorded in `calls`, never cached.
3. **Fast path.** `onlyTools`, `skipTools` and `skipRisks` decide before anything else; a skipped
   call returns `'not-applicable'`, makes no model call and records nothing. The risk is the
   event's `risk` (P21 traits; `read` only from trusted app metadata, spec 11 §3.2), `'unknown'`
   when absent. `'unknown'` is not skipped by default (MCP tools without hints are reviewed).
4. **Cache and determinism.** Plugin state (`plugins.guard`, spec 05 §7) holds, per session:
   - `calls`: the status returned per `toolCallId`, with the tool name and the verdict key
     (bounded by `cache.maxEntries`). A call seen before (same id, same tool, same key) gets the
     same answer without a model call — AI SDK's re-validation of an approved call
     in a `respond()` continuation, possibly in another process, therefore never calls the judge
     and never turns a person's approval into a denial (the rule "approval hooks must be
     deterministic" holds per session). A reused `toolCallId` with a different tool or input is
     a different call and is judged again;
   - `verdicts`: judge verdicts keyed by `toolName + ':' + sha256(scope + NUL + canonicalJson(input))` (`crypto.subtle`;
     `input` after `tool.before` refinement; `scope` = role, instructions, policy and judge model
     id), so a changed policy or judge never reuses an older verdict, LRU-bounded by
     `cache.maxEntries`, expiring after `cache.ttlMs` (default 1 hour; `Infinity` disables). The same call (same tool and
     input) with a new id reuses the verdict. A cached `allow` ignores later conversation
     context; set `cache.ttlMs` when context can change what is acceptable.
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

The guard is a thin wrapper over the **shared judge engine** (`createJudge` in core, role
`tighten`; [ADR-0060](../decisions/0060-shared-llm-judge-engine.md), guide
[LLM judge: two modes](../guides/llm-judge.md)). The engine owns the model call, the restricted
transcript renderer, the truncation rule, the verdict cache, the circuit breaker, retries and
timeouts; permissions auto mode (spec 18 §12) uses the same engine with role `decide`. The guard
supplies the instructions (internal), the policy, and the plugin-state store
(the cache and the denial counter live in `plugins.guard[...]`).

```ts
generateText({
  model: ctx.observeModel(model), instructions: <guard instructions>, prompt,
  // prompt = <policy>…</policy> <transcript>[JSON entries]</transcript> <action>{JSON call}</action>
  output: Output.object({ schema: z.object({ decision: z.enum(['allow', 'ask', 'deny']), reason: z.string() }) }),
  abortSignal: AbortSignal.any([AbortSignal.timeout(timeoutMs), turn.abortSignal]),
  maxRetries, maxOutputTokens: 1024, temperature: 0,
})
// the call input is reviewed in full up to maxCallChars (default 8_000, one default for guard() and
// modelClassifier()); transcript.maxChars (12_000) bounds the transcript view only
```

Frame tags (`policy`, `environment`, `transcript`, `action`, `system-reminder`) inside untrusted text
are neutralised. `result.output` is validated again; anything else is "unavailable" (rule 6).
A call whose canonical input JSON is longer than `maxCallChars` is never judged: a person
decides (`GUARD_ASK` + an "input too long" reason), nothing is cached. The verdict cache key hashes
tool, canonical input, the role, the instructions, the policy and the judge model id.

## 4. Verdict → status

| Verdict | Status | Reason (model / pending UI) |
|---|---|---|
| `allow` | `'not-applicable'` | — |
| `ask` | `user-approval` | `GUARD_ASK` |
| `deny` | `denied` | `GUARD_DENIED` (the model reads it in the denied tool result) |
| `deny`, breaker reached | `user-approval` | `GUARD_BREAKER` |
| unavailable | `user-approval` | `GUARD_UNAVAILABLE` |

## 5. Texts

Exported constants (model-visible reasons; changing one is a minor change): `GUARD_DENIED`
(`{reason}`), `GUARD_ASK` (`{reason}`), `GUARD_BREAKER` (`{count}`, `{reason}`),
`GUARD_UNAVAILABLE` (`{error}`). The judge instructions, the default policy, the prompt layout
and the helpers (`canonicalJson`, the key hash) are internal and may change in any release.

## 6. Limits

An LLM judge is a probabilistic second line, not a security boundary: deterministic rules
(`approval.policy`, `approval.risk`, sandboxing, least-privilege credentials) stay the first line.
The judge adds latency (one model call per reviewed, uncached call, before the tool runs) and
cost. Injections that the user typed, or that the agent copied from a tool output into a tool
call's input, are visible to the judge (the input is what it reviews).

## 7. Combined call with auto mode

`guard({ combineWithAutoMode })` (default `true`). In `session()` the guard registers a
`JudgeParticipant` (`model`, `instructions`, `policy`, `limits`, `applies(call)`, `settled(call)`)
with `judgeCoordinator(ctx.signal)` (core, keyed on the session's abort signal; ADR-0060
amendment). When `modelClassifier()` judges the same tool call (permissions plugin, same session,
`auto: 'classify'`) and the guard is the only participant, `applies` (the guard's fast path:
`skipRisks`, `skipTools`, `onlyTools`) is true, `settled` is false (no recorded answer for the call
id, no fresh cache hit) and the guard's model is the classifier's (`===`) with equal view limits
(`transcript.maxMessages`/`maxChars`, `maxCallChars`), the classifier makes ONE call with the
combined schema `{ auto, autoReason, guard, guardReason }` and stores the guard half by
`toolCallId` (checked against tool and input hash). In `tool.approve` the guard takes it before
step 3 and runs the same engine path with `precomputed` (no model): cache write, breaker, call
record and status mapping (§4) are unchanged; a failed combined call becomes the usual
`W_GUARD_UNAVAILABLE` + `GUARD_UNAVAILABLE` ask; the combined call's usage is charged as
`source: 'guard'`. A truncated input is not judged (no combined call, the guard handles it as in §3).
Requires `permissions()` before `guard()`; otherwise the guard judges alone (two calls).
