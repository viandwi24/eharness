# ADR-0064: `eharness/browser`: adapters over an operation-level connection, CDP in core

Status: **Accepted** · Date: 2026-10-14 · Related: [ADR-0008](0008-plugins-adapters-dogfooding.md), [ADR-0036](0036-node-only-modules.md), [ADR-0061](0061-code-sandbox-sync-not-mount.md), [ADR-0062](0062-platform-rings-and-rule-of-two.md) · Spec: [35](../specs/35-browser.md) · Plan: [P48](../plans/P48-browser.md)

## Context

Agents of the team app and the coding agent (web QA, checking a deployed page) need a real
browser: logged-in sites, JavaScript-heavy pages, forms. `web_fetch` reads static pages only. AI
SDK 7 has no browser primitive (it has sandbox sessions and provider computer-use tools), so this
does not duplicate AI SDK. People must be able to watch the browser and take over for a login, a
CAPTCHA or 2FA, and keep named profiles so a login survives.

Options considered (research 2026-10-14):

1. **Vendor an existing browser subsystem** (the OpenClaw browser tool, 63 files over
   `playwright-core` and `express`). Its last host project removed it (2026-05) as too heavy and
   pointed users to an MCP server instead. It would add runtime dependencies and break
   runtime-neutrality.
2. **Use an MCP server only** (`@playwright/mcp`, `agent-browser mcp`, `chrome-devtools-mcp`) through
   `eharness/mcp`. Works today without code and stays documented, but has no per-session lease,
   no takeover lock, no screenshots in the virtual file system, no profile model and no live view
   an app can embed.
3. **Wrap a CLI** (`agent-browser`, Rust, Apache-2.0). Good snapshots and a stream protocol, but a
   native binary per host, process-per-command, and our lock, live view and profile rules would sit
   outside it.
4. **Own a small CDP client in core, adapters around an operation-level connection.** CDP over a
   WebSocket is a Web API (global in Node 22 and Bun), needs no dependency, and every Chromium
   engine and every hosted browser service speaks it (Browserbase, Kernel, Steel, Anchor,
   Browserless, Browser Use). Lightpanda speaks it too (with `Accessibility.getFullAXTree`, `Input`
   and PNG screenshots, without screencast). Camoufox (Firefox) does not: it uses Playwright's
   Juggler protocol.

## Decision

1. **Option 4.** `eharness/browser` owns a CDP client (`cdpConnection`) and the snapshot/ref,
   act, screenshot, read and live-view logic, modelled on proven designs (accessibility tree with
   `e<n>` refs mapped to backend node ids, hit-tested clicks, acked screencast, stream-style input
   messages). No runtime dependency.
2. **Adapters implement an operation-level `BrowserConnection`, not "a CDP URL".** Capabilities
   (`snapshot`, `screenshot`, `liveView`, `takeover`, `tabs`, `persistentProfile`) decide which
   tools exist for a session, fixed at session open (prompt-cache prefix). Non-CDP engines fit
   without changing the plugin or apps.
3. **Two modes per adapter: `manual` and `managed`.** Manual connects to an endpoint someone runs
   (a hosted service, a container). Managed uses a `BrowserRuntime` (install, start, stop) passed
   in by the app, so the runtime-neutral core never spawns processes. Node runtimes for Chrome for
   Testing and Lightpanda live in `eharness/browser/node` (Node-only, ADR-0036); remote runtimes
   are app code. Engine binaries are downloaded at runtime and never bundled (Lightpanda is
   AGPL-3.0; it runs unmodified as a separate process).
4. **Ports first** (ADR-0062): `BrowserProfileStore` with a memory adapter and a conformance suite;
   secrets sealed with the providers' `SecretVault`; forms from the providers' form builder.
5. **No evasion in the library.** No CAPTCHA solving and no fingerprint spoofing. The supported
   path for CAPTCHA and 2FA is human takeover (`browser_request_human` parks the turn through an
   external wait; the app can use `eharness/handoff` kind `takeover`). Apps may pick a stealth
   engine via `executablePath` or a provider's options; the docs state that no engine avoids
   detection reliably.
6. **Camoufox ships as a separate package** (`@eharness/browser-camoufox`, ring 2) because it needs
   `playwright-core`. Hard rule 10 stays as it is.
7. **Screenshots reach the model as filesystem media references** (spec 08 §12): stored once in the
   virtual file system, re-read by `toModelOutput`, only the newest few sent as images, none for
   models without image input.

## Consequences

+ One plugin, one manager and one UI model for local Chrome, hosted browsers, Lightpanda and later
  Camoufox; apps choose per profile.
+ Runtime-neutral core and no new dependency; the Node-only part is small and optional.
+ Human takeover is a first-class, lockable state instead of an afterthought.
− We maintain a CDP client and a snapshot builder (estimated 2–3k lines with tests) and must
  follow Chrome protocol changes.
− Lightpanda gives polled, lower-fidelity frames; Camoufox needs a second package and polled frames.
− Out-of-process iframes, downloads and uploads are not in the first version.
− Module status is Draft; it graduates only when two products use it (team app, coding agent).
