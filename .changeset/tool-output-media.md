---
"eharness": patch
---

Tool output limits no longer count or cut the base64 media of an MCP result (a screenshot used to reach the model as truncated base64 text); only its text parts are shortened. New `toolOutput.keepImages`: the model sees the newest N media items of tool results, older ones become a short note, and a model that cannot take images gets the refusal note instead of tool images.
