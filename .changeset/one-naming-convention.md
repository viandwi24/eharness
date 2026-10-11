---
'eharness': minor
---

**BREAKING:** one naming convention across the public API. Plugin factories are named like the
plugin's runtime `name` (runtime names, and so persisted plugin state, do not change); in-memory
implementations use the `inMemory` prefix; tool and skill sources end in `Source`; every plugin,
source, adapter and store factory takes one `options` object; `run.toResponse()` is the safe HTTP
answer; `session.edit()` takes one object; `session.abort()` is awaitable and cross-process. There
are no deprecated aliases: rename at the call sites.

| Old | New |
|---|---|
| `askUser`, `AskUserOptions` | `ask`, `AskOptions` |
| `approvalGuard`, `ApprovalGuardOptions` | `guard`, `GuardOptions` |
| `permissionsPlugin`, `PermissionsPluginOptions` | `permissions`, `PermissionsOptions` |
| `groupChat`, `GroupChatOptions`, `GroupChatPlugin` | `group`, `GroupOptions`, `GroupPlugin` |
| `subagents`, `SubagentsOptions` | `subagent`, `SubagentOptions` |
| `memoryFs`, `memoryMessages`, `memoryState`, `memoryInbox`, `memoryBudgetLedger`, `memoryStreamLog`, `memoryActivityStore`, `memoryCatalogCache`, `memoryCheckpointStore`, `memoryProfileStore`, `memoryConnectionStore`, `memoryCredentialStore`, `memoryEnablementStore`, `memoryFlowStore`, `memoryRefreshLock` (and their `Memory*Options` types) | the same names with the `inMemory` prefix (`inMemoryFs`, `InMemoryFsOptions`, ...) |
| `mcpServer`, `McpServerOptions` | `mcpServerSource`, `McpServerSourceOptions` |
| `openApiTools`, `OpenApiToolsOptions` | `openApiSource`, `OpenApiSourceOptions` |
| `diskFs(root, opts)` | `diskFs({ root, ...options })` |
| `nodeCheckpointStore(dir, opts)` | `nodeCheckpointStore({ dir, ...options })` |
| `localSandbox(root, opts)` | `localSandbox({ root, ...options })` |
| `fsSkillSource(fs, opts)` | `fsSkillSource({ fs, root, ... })` |
| `openApiTools(spec, opts)` | `openApiSource({ spec, ...options })` |
| `sealedProfileStore(inner, vault, opts)` | `sealedProfileStore({ inner, vault, ...options })` |
| `mountFs(mounts)` | `mountFs({ mounts })` (new type `MountFsOptions`) |
| `inMemoryFs(seed, opts)` | `inMemoryFs({ seed, ...options })` |
| `inMemoryProfileStore(initial)`, `inMemoryConnectionStore(initial)` | `inMemoryProfileStore({ initial })`, `inMemoryConnectionStore({ initial })` |
| `run.toResponse()` (stream at once, always 200) | `run.toStreamResponse()` |
| `run.toHttpResponse()` (waits for `accepted`, proper status) | `run.toResponse()` |
| `session.edit(messageId, input, options)` | `session.edit({ messageId, input, ...options })` |
| `session.abort()` (void, local) and `session.requestAbort()` | `session.abort()`: awaitable, returns `{ target }` (the old `requestAbort` semantics); `requestAbort` is removed |

Migration: apply the table with a search and replace per symbol (word-boundary aware), then move the
leading positional argument of the listed factories into the options object. `session.abort()`
callers that ignored the return value can keep doing so; they now also get a promise that rejects
with `EH_STORAGE` / `EH_SESSION_CLOSED` where `requestAbort()` did. Subpaths such as
`eharness/storage/memory` and `eharness/filesystem/memory` keep their paths.
