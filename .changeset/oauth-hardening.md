---
"eharness": minor
---

**BREAKING:** OAuth requests of `eharness/connectors` (discovery, registration, token, refresh, device) now refuse private, loopback and link-local hosts, including discovered endpoints, and no longer follow redirects to another origin (`redirect: 'manual'`; same-origin redirects are followed at most 3 times and re-validated). Migration: for a local development server pass `oauth: { allowPrivateNetwork: true }` to `createConnectorService` / `FlowDeps` / `createCredentialManager` (or `allowPrivateNetwork` / `isAllowedUrl` to the helpers). `assertSecureUrl` applies the same check. OAuth response bodies are capped (`maxResponseBytes`, default 1 MiB). `isPrivateHost` is now exported from the core entry (shared with `web_fetch`).

Connectors: flows can be bound to a principal (`startFlow` / `startConnect` / `reconnect` `principal`; `completeOAuth` / `FlowInput` `principal`), failing with `principal-mismatch` on a different or missing principal (login CSRF). `service.test` answers "Reconnect required." only for `needs-auth` errors; other failures (outage, network, store) answer "Temporarily unavailable" and go to the new `onError` (default `console.warn`).
