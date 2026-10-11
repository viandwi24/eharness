# LLM judge: two modes

eharness can put a second, cheap model in front of tool calls in two places. They look alike but
answer different questions, and they share **one engine** (`createJudge` in core;
[ADR-0060](../decisions/0060-shared-llm-judge-engine.md)): the same restricted transcript (user
messages and the agent's earlier tool calls, never tool outputs), the same framed prompt, the same
fail-closed handling of over-long inputs, verdict cache, circuit breaker, retries and timeouts. The judge call is capped at 1024 output tokens and uses temperature 0. The prompt is framed as `<policy>`, `<environment>`, `<transcript>` and `<action>` blocks. Judge unavailable (outage, timeout, no valid verdict) never approves: a person decides. `createJudge` is exported from `eharness` for custom judges (Draft).

| | Approval guard (`eharness/guard`) | Permissions auto mode (`eharness/permissions`) |
|---|---|---|
| Factory | `guard({ model, policy })` | `modelClassifier({ model })` as the engine's `classifier` |
| Role | `tighten` | `decide` |
| Can it approve? | **No.** Allow means "no objection"; the rest of the approval chain decides | **Yes.** An allow replaces asking a person |
| Can it block? | Deny (the model reads why) or ask a person | Block (the model reads why) or ask a person |
| Use it when | you have any approval setup and want extra safety on top | the agent runs unattended and nobody can answer prompts |
| Cache | on: per session, `cache: { maxEntries: 200, ttlMs: 1 h }` (`ttlMs: Infinity` = no expiry) | off by default; `cache: { maxEntries, ttlMs }` opts in (engine memory, not per session) |
| Breaker | 3 denials in a row (`maxConsecutiveDenials`), then a person decides | 3 blocks in a row / 20 total pause auto mode |
| Your text | `policy` (appended to the built-in judge instructions) | `environment` (appended to the built-in classifier instructions) |
| Over-long input | asks a person (input over `maxCallChars`, default 8 000) | asks a person (summary over 2000 or input over `maxCallChars`, default 8 000) |

## Which one

- **Attended agent, or any agent with an approval policy**: use the guard on a permissive base
  policy. It can only add friction, never remove it, so it is safe to bolt on.
- **Unattended agent** (CI, background jobs, no one to answer `tool-pending`): use permissions
  `auto` mode. The classifier is what lets calls no rule settles run without a person, and what
  stops the dangerous ones.
- **Both**: allowed, see "Combining both" below.

## Combining both

When both are active in one session, a risky call that auto mode sends to its classifier is judged
with **one model call**, not two. The permissions engine decides first (list `permissions()` before
`guard()`); its classifier sees that the session's guard is registered (`judgeCoordinator`, keyed on
the session, so sessions never share) and asks both questions in one structured reply:
`{ auto: allow | block, autoReason, guard: allow | ask | deny, guardReason }`. The two answers stay
separate:

| Auto mode says | Guard says | Result (same as two calls) |
|---|---|---|
| allow | no objection | approved |
| allow | deny | denied with the guard's reason (the model reads it) |
| allow | ask | a person approves (`tool-pending`) |
| block | any | blocked by auto mode (the guard still records its half) |
| judge fails | | auto fails closed; the guard warns `W_GUARD_UNAVAILABLE` and asks a person; still one call |

The guard then records its half through its usual path (call record, verdict cache, breaker,
usage charged to the turn as `source: 'guard'`) without calling its model.

It falls back to two calls (each judge as if alone, same outcomes) when:

- the guard's model is not the classifier's (same model instance, or the same gateway string): two
  models cannot answer in one call;
- the two differ in `transcript` or `maxCallChars` limits (they would not see the same input; both
  default to the same values);
- `guard({ combineWithAutoMode: false })`, auto mode is paused, off or bypassed, or a rule settled
  the call before the classifier (then only the guard judges, as before);
- the guard is listed before `permissions()` (it runs first and has no combined answer yet);
- the guard already has the answer (a cache hit, a recorded answer for the call id, e.g. after a
  `respond()` or a restart): the classifier then judges alone.

`combineWithAutoMode` defaults to `true`: using the same model for both is the opt-in, and the
outcomes are the same; set `false` for isolated judgement of the policy. The combined prompt shows
both rule sets in two labelled reviews (the `<policy>` block belongs to the guard review, the
`<environment>` block to the auto review) and the call input is truncated by the same
`maxCallChars` rule. Trade-off: one judge call sees both questions, so the classifier's
`onModelCall` (not the session's `model.call` hook) observes the combined call.

Either way an LLM judge is a probabilistic second line, not a boundary: keep deny rules, sandboxing
and least-privilege credentials as the first line. Setup details: [guard](guard.md),
[permissions](permissions.md).
