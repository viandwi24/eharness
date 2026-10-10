# Debugging and activity logs

The `model.call` hook reports every model call of a session after it ends: each turn step, the
compaction summarizer, the pre-compaction flush and the calls plugins route through
`ctx.observeModel`. It is built on an AI SDK language model middleware, so it sees what the provider
saw: the request body, response headers, the assembled output, usage, timings and the error. Spec:
[12 §7](../specs/12-models-and-cost.md#7-model-call-observation).

## An activity log plugin

```ts
import { definePlugin, type ModelCallEvent } from 'eharness'

export function activityLog(store: { save(e: ModelCallEvent): Promise<void> }) {
  return definePlugin({
    name: 'activity-log',
    setup: () => ({
      hooks: {
        'model.call': async (_ctx, e) => {
          await store.save({
            ...e,
            // keep the list light; bodies can be hundreds of KB per call
            request: { options: e.request.options, ...(e.status === 'error' ? { body: e.request.body } : {}) },
          })
        },
      },
    }),
  })
}
```

A list row needs `startedAt`, `kind`, `model`, `status`, `durationMs`, `usage`, `costUsd` and
`finishReason`. Throughput is `usage.outputTokens / ((durationMs - (firstChunkMs ?? 0)) / 1000)`.
The details page shows `request.options`, `request.body`, `response`, `output` and
`providerMetadata`. Join with the conversation through `sessionId`, `turnId` and `messageId`.

## Things to know

- The hook is observe-only and not awaited by the stream: a slow store never delays chunks, but the
  write may finish after `step.end`. An error in it is a `W_HOOK_FAILED` warning.
- Retention is yours. The prompt is repeated in every step's `request`, so store bodies separately,
  truncate, sample or expire. Sensitive content is in there; apply your own redaction.
- Without a `model.call` listener nothing is wrapped and nothing is assembled.
- A plugin that calls a model itself wraps it: `generateText({ model: ctx.observeModel(judge), … })`.
  Outside a session (an engine, a script) use `observeModel(model, record => …)`; `modelClassifier`
  takes `onModelCall`.
- Retries by AI SDK appear as separate events (a failed one with `status: 'error'`).
- Costs come from the agent's `models` catalog; they are estimates (spec 12 §3).
