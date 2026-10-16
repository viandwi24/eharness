---
'eharness': patch
---

Remove leaked tool-call markup (DeepSeek DSML and similar) from model text before it is streamed, persisted and projected; export `stripLeakedToolMarkup` for UIs.
