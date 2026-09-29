# Architecture Decision Records

New ADR: copy the shape of an existing one, next number, status `Proposed` until merged.
Superseding an ADR: mark the old one `Superseded by ADR-xxxx`; never delete.

| ADR | Title |
|---|---|
| [0001](0001-build-on-ai-sdk-primitives.md) | Build on AI SDK primitives, no parallel types |
| [0002](0002-manual-step-loop.md) | Manual step loop (one streamText per step) |
| [0003](0003-uimessage-storage-form.md) | UIMessage is the storage form |
| [0004](0004-fixed-compaction-pluggable-storage.md) | Compaction is fixed; storage is the extension point |
| [0005](0005-compaction-marker-as-message.md) | Compaction markers are ordinary kind messages |
| [0006](0006-skill-relative-addressing.md) | Skill files are addressed relative to the skill |
| [0007](0007-single-package-subpaths.md) | One package with subpath exports |
| [0008](0008-plugins-adapters-dogfooding.md) | Plugins bundle capabilities; adapters implement contracts; shipped plugins use only public API |
| [0009](0009-release-changesets-trusted-publishing.md) | Release with Changesets and npm trusted publishing |
| [0010](0010-bun-dev-node-runtime.md) | Bun for development, runtime-neutral library |
| [0011](0011-stored-order-equals-model-order.md) | Stored order equals model order (inline input parts) |
| [0012](0012-approvals-server-owned-pending.md) | Tool approvals via AI SDK `toolApproval` with server-owned pending state |
| [0013](0013-cache-friendly-prompt-layout.md) | Cache-friendly prompt layout with reminders |
| [0014](0014-interrupted-tool-calls-answered.md) | Interrupted tool calls are answered, not dropped |
