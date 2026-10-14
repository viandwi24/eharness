---
'eharness': minor
---

New `eharness/browser` (Draft) and `eharness/browser/node`: agents drive a real browser. A registry of adapters (`chromeAdapter`, `lightpandaAdapter`, each with manual and managed mode and its own settings form), browser profiles (`BrowserProfileStore`, `memoryBrowserProfileStore`, `sealedBrowserProfiles`, `publicProfile`), a manager with leases, idle release, takeover and live view (`createBrowserManager`), and the `browser()` plugin: accessibility snapshots with refs, acting on refs, screenshots as media references the model sees in its next step, `browser_request_human` that parks the turn, domain rules and untrusted-content framing. `eharness/browser/node` adds `chromeRuntime` and `lightpandaRuntime` (download, start, stop, memory and CPU usage). `eharness/testing` adds the fake CDP peer and `browserProfileStoreConformance`.
