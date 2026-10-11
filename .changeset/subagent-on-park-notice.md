---
"eharness": minor
---

`subagent({ onPark })` and `subagentChild({ onPark })`: `'notice'` stores the "child waits for the user" notice of a parked durable background child without handing it to a running parent turn, so it never costs an extra model call; the final report still wakes the parent. The default `'step'` keeps today's behaviour (next-step delivery). Spec 20 §3.5.
