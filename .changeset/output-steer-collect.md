---
"eharness": minor
---

`send(input, { output, ifBusy: 'steer' | 'collect' })` is now a run error `EH_INVALID_INPUT` (`details.reason: 'output-with-steer-or-collect'`), whether the session is busy or not, instead of silently ignoring `output` (a steer or a collected input joins another turn; spec 05 §3.3 rule 9).
