---
"eharness": patch
---

`ConnectionRecord.slug` is an optional stable tool-prefix slug: `activateConnectors` uses it instead of the slug of the label, so renaming a connection never renames its tools. The `clientConfig` callback of the connector service also receives the `settings` of the connection being connected (per-connection OAuth clients). See spec 24 §5 and §10.

The final "connected" view of a connect flow names the connection (its label) instead of the connector.
