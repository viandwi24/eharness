---
"eharness": patch
---

Pricing tiers: the highest matching tier now wins regardless of array order (`computeCost`, and
turn cost with a `models` record whose `pricing.tiers` are not sorted). Also clarifies TSDoc:
`'cost-cap'` includes USD budgets, `ModelInfo.maxOutputTokens` is informational, and pending
approval `input`/`risk` are absent in state written before 0.3.
