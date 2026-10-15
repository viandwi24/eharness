---
'eharness': patch
---

Media of MCP tool results (screenshots, audio) are written to the new `toolMedia` service of the filesystem plugin and stored as small `media-ref` parts instead of base64, so the message store does not grow with every screenshot. Projection and the live step read the bytes back (newest `toolOutput.keepImages` only); expired files become a note. New option `filesystem({ toolMedia })`, warning `W_TOOL_MEDIA_OFFLOAD`.

`toolOutput.keepImages` also applies inside a running turn: a long turn of screenshots keeps only the newest in each step.
