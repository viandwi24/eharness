# ADR-0047: Model call observer (`model.call` hook)

Status: **Accepted** · Date: 2026-10-10 · Builds on: [ADR-0001](0001-build-on-ai-sdk-primitives.md), [ADR-0016](0016-model-catalog-and-budgets.md)

## Context

Applications want an OpenRouter-style activity log: every LLM call with latency, throughput,
tokens, cost, finish reason, the raw request sent to the provider and the raw response. The
existing hooks cannot give it: `step.end` carries the assembled step (no request body, no
headers, no timing), and the compaction summarizer, the pre-compaction flush and the judges of
shipped plugins are model calls no hook sees at all.

## Decision

1. **A `model.call` plugin hook**, observe-only: `(ctx, e: ModelCallEvent) => void`. It fires after
   every provider call of the session ends, whatever the outcome (`ok`, `error`, `aborted`), for
   turn steps (`kind: 'step'`), the compaction summarizer (`'compaction'`), the pre-compaction
   flush (`'flush'`) and plugin calls routed through `ctx.observeModel` (`'other'`).
2. **Implemented as an AI SDK language model middleware** (`wrapLanguageModel`, `wrapStream` +
   `wrapGenerate`), not as parallel instrumentation (ADR-0001). It sees what the provider sees:
   the provider-agnostic call options, `request.body`, response headers and metadata, the stream
   parts and the usage. One record per `doStream` / `doGenerate`, so a retried call is several
   events, which is what an inspector should show.
3. **Zero cost when unused**: the core wraps a model only when some plugin registers `model.call`.
   Otherwise the very same model object reaches AI SDK.
4. **Never in the way**: the stream is passed through part by part; the report is fired as the
   stream ends (or is cancelled), not awaited by it, and hook errors become `W_HOOK_FAILED`.
   Events are not stored by the core; no message, state or stored order changes.
5. **Serializable events**: options drop the abort signal; binary data becomes a placeholder; the
   request `headers` option and response headers lose `set-cookie` and credential-like names.
   Request and response bodies are kept as reported (they can be large; retention is the app's
   decision, documented in spec 12 §7).
6. **Public helper `observeModel(model, report)`** wraps any model with the same middleware for code
   outside a session, and `ctx.observeModel(model, { kind? })` is the session-aware variant (fires
   the hook, adds session context and cost). `modelClassifier` gets an `onModelCall` option
   (the permission engine has no session); `approvalGuard` uses `ctx.observeModel`.
7. **Cost** is priced with the agent's `models` catalog (`costOf`, spec 12 §3) like steps; absent when
   the model has no pricing. Unlike steps, these events do not feed budgets: budgets keep their
   existing sources (steps, `addUsage`, summarizer and flush usage).

## Consequences

+ An activity log is a few lines in a plugin; nothing in the core persists or grows.
+ The events are the provider-level truth, including retries and calls the loop never exposes.
− Gateway string models are resolved through the default provider (`AI_SDK_DEFAULT_PROVIDER` or the
  AI Gateway); a string that cannot be resolved is not observed.
− `request.body` exists only when the provider reports it; a provider that omits it leaves it unset.
− The hook may complete after the step's `step.end`; do not rely on ordering between them.

## Amendment note (2026-10-11)

Update (0.8, P39): `config.observe(event)` is the lightweight companion to this observer: phase durations (`span`) and counters (`count`) for metrics and tracing, with no payloads (`docs/guides/observability.md`). `observeModel` and the `model.call` hook stay the way to capture raw requests and responses; both are Draft (`@experimental`).
