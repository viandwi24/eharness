---
'eharness': minor
---

eharness/browser: new read-risk tool `browser_scroll` (direction, amount or pages, scroll to a ref, optional wait), so scrolling a page no longer needs an approval; it is appended after the other tools and its risk can be overridden through `risk`. `browser_act` with `kind: 'scroll'` still works.
