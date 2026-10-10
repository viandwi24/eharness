---
"eharness": patch
---

`eharness/providers`: overlapping profile reloads (a `ProfileStore.subscribe` notification while another change is being written) no longer let an older read replace a newer snapshot; only the newest reload applies, and `putProfile` records the new profile in the current snapshot.
