---
"eharness": minor
---

Connectors for long-lived user sessions. `ConnectionCredentials.session` (`{ format, data }`) is an opaque credential slot a custom flow step can set (`scratch.credentials = { session }`); it is sealed with the other credentials and appears in no public view, flow state or log. New flow view `qr` (`url`, `expiresAt`, `pollIntervalMs`; the `url` may change under the same `viewId` while polling) and a `resend` flow action on `form` views for one-time codes. `ConnectorService.credentials(connectionId)` reads the stored credentials for trusted server code and `ConnectorService.markNeedsAuth(connectionId, message?)` lets a runtime mark a connection `needs-auth`. A connection with a session counts as `authorized`. Exports: types `QrView` and `ConnectionSession`. Spec 24 §2 and §4 updated.
