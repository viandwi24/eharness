# Observability

`config.observe` is one callback that receives every timed phase of a turn (`span` events) and the
counters that tell you something is going wrong (`count` events). It is optional and costs nothing
when unset. The contract is [spec 10 §8](../specs/10-errors-and-stop-reasons.md#8-observability).

```ts
import { defineHarnessAgent } from 'eharness'

// yours: model (a LanguageModel)
const agent = defineHarnessAgent({
  model,
  observe: (event) => {
    if (event.type === 'span') console.log(event.name, Math.round(event.durationMs), 'ms', event.ok)
    else console.log('count', event.name, event.code ?? event.source ?? '')
  },
})
```

What you get: `lock.wait`, `turn.prepare` (per hook), `compaction`, `state.write`, `message.write`,
`model.call` (per step) and `tool.execute` spans; `hook.failed`, `hook.timeout`, `events.overflow`,
`state.conflict`, `tool-source.backoff` and `warning` counters. Every event carries the `sessionId`
and, where it applies, `turnId`, `step`, `tool`, `hook`, `owner`, `source` or `code`.

Rules: the handler runs synchronously inside the runtime, so keep it cheap (increment a counter,
record a histogram, push to a queue); a handler that throws is ignored. `telemetry` (AI SDK
spans for the model call) is separate and still works.

## OpenTelemetry bridge

```ts
import { metrics, trace } from '@opentelemetry/api'
import { defineHarnessAgent } from 'eharness'

// yours: model (a LanguageModel)
const meter = metrics.getMeter('eharness')
const durations = meter.createHistogram('eharness.phase.duration', { unit: 'ms' })
const counters = new Map<string, ReturnType<typeof meter.createCounter>>()

const agent = defineHarnessAgent({
  model,
  observe: (e) => {
    const attrs = { name: e.name, tool: e.tool, hook: e.hook, source: e.source, code: e.code }
    if (e.type === 'span') {
      durations.record(e.durationMs, { ...attrs, ok: e.ok })
      // optional: a finished span with the real start time
      const end = Date.now()
      trace.getTracer('eharness').startSpan(`eharness.${e.name}`, { startTime: end - e.durationMs, attributes: { ...attrs, sessionId: e.sessionId } }).end(end)
    } else {
      let counter = counters.get(e.name)
      if (counter === undefined) {
        counter = meter.createCounter(`eharness.${e.name}`)
        counters.set(e.name, counter)
      }
      counter.add(1, attrs)
    }
  },
})
```

Prometheus works the same way: one histogram `eharness_phase_duration_ms{name}` and one counter
per `count` name. Avoid `sessionId` and `turnId` as metric labels (unbounded); use them on traces.

## Warning dedupe

Without `onWarning`, the default handler prints a warning once per code + key within
`warnings.dedupeWindowMs` (default 60 000), then prints it again with a count of the repeats it
suppressed. `dedupeWindowMs: 0` prints every occurrence. `onWarning` always gets every occurrence,
and the `warning` / `hook.failed` counters count them all.
