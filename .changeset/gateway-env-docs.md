---
"eharness": patch
---

`gatewayProvider` documents that `@ai-sdk/gateway` has no base-URL environment variable (only `AI_GATEWAY_API_KEY` is mapped); a test pins its `envMap`. See spec 23 §4.
