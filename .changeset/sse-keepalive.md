---
"eharness": patch
---

`activityStream` / `handleActivityStream` (and the `eharness/http` activity route) send the `: keep-alive` comment every 8 s by default instead of 15 s. `Bun.serve` closes a connection after 10 s without bytes by default, so a quiet activity stream was dropped and every client reconnected and resynced about every 10 s. The HTTP guide now says to set `idleTimeout: 0` for chat streams.
