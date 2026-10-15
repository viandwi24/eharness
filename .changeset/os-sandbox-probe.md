---
"eharness": patch
---

`eharness/shell` gains `probeOsSandbox()` (Draft): it runs a trivial command through the real bubblewrap or Seatbelt sandbox and returns `{ kind, ok, reason }`, so an application can tell "the tool is installed" from "the sandbox works on this host" (bubblewrap cannot create namespaces in many containers). `detectOsSandbox()` is unchanged.
