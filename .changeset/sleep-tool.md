---
"eharness": minor
---

New `sleep` tool in `eharness/clock` (`sleepTool()`, or `clock({ sleep: true })`): it pauses a turn for whole minutes without holding a process, as an external wait that the session's wait timer (or `expireWaits()` after a restart) continues at the wake-up time. A worker can loop "do a batch, sleep, repeat" and costs nothing in between. A durable background subagent parked only on external waits no longer reports "waiting" to its parent; it reports when it finishes.
