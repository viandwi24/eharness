---
"eharness": minor
---

`HarnessContext.session.inject(kind, data, options?)`: a plugin can inject a kind message into its own session from tools, hooks and background work (same semantics as `session.inject()`: `deliver: 'next-step'` lands at the next step boundary of the running turn, `wake: true` on an idle session starts a turn and returns its `run`). `ctx.session.parent` now also reads the parent link stored in the session state, so it is set when an existing child session is opened without options (in any instance). `eharness/shell` uses it: background task events are injected by the plugin itself by default; `onTaskEvent` stays as an override.
