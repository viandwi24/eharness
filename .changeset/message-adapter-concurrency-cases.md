---
'eharness': minor
---

`eharness/testing`: `messageAdapterConformance` gains three cases (concurrent saves of one id end with one row, concurrent disjoint batches are all visible in id order, ids sharing a millisecond prefix keep a deterministic order). Third-party message adapters may now fail them; make `save` an atomic upsert and order by id.
