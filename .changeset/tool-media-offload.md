---
'eharness': minor
---

Media of MCP tool results (screenshots, audio) are written to the new `toolMedia` service of the filesystem plugin and stored as small `media-ref` parts instead of base64, so the message store does not grow with every screenshot. Projection and the live step read the bytes back (newest `toolOutput.keepImages` only); expired files become a note. New option `filesystem({ toolMedia })`, warning `W_TOOL_MEDIA_OFFLOAD`.

`toolOutput.keepImages` also applies inside a running turn: a long turn of screenshots keeps only the newest in each step.

Upgrade note: on by default for `filesystem()`. Stored messages now carry `media-ref` parts, which 0.8 cannot read back; do not roll an app back to 0.8 after it stored new tool media. Set `filesystem({ toolMedia: false })` to keep the old inline format.
