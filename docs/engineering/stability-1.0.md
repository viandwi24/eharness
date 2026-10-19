# Proposed 1.0 stability list

A proposal, not a decision. It classifies the runtime exports of `scripts/exports.snapshot.json`
(407 names over 33 entry points; type-only exports follow their module) for the 1.0 cut. Rules
are in [api-stability.md](api-stability.md); the schedule is in the [roadmap](../plans/roadmap.md).

- **Stable**: part of the 1.0 promise; breaking changes need a major.
- **Experimental**: shipped, but may change in a minor after 1.0 (documented as `@experimental`).
- **Internal-candidate**: looks like an implementation helper that leaked; remove from the public
  surface (or document it first) before 1.0. Removing is breaking, so it must happen in a 0.x minor.

Module-level verdicts first, then per-subpath exceptions.

## Module verdicts

| Subpath | Verdict | Reason |
|---|---|---|
| `eharness` core | Stable, minus the items below | specs 01-11 Accepted since 0.1 |
| `eharness/filesystem`, `filesystem/memory`, `filesystem/node` | Stable (`projectInstructions`, checkpoints experimental) | Accepted spec 08; adapter contract |
| `eharness/storage/memory`, `eharness/testing` | Stable | adapter contracts; conformance suites grow additively |
| `eharness/mcp` | Stable | Accepted spec 09 |
| `eharness/todos`, `eharness/memory` | Experimental | Draft specs 13, 14; small surfaces, likely stable after one more release |
| `eharness/permissions`, `eharness/ask`, `eharness/web`, `eharness/web/node` | Experimental | Draft; `auto` classifier still moving |
| `eharness/subagent`, `eharness/shell`, `eharness/code` | Experimental | Draft; messaging, sandboxes and `code` limits still evolving |
| `eharness/providers`, `eharness/connectors` | Experimental | Draft (0.8); large surface (23 and 35 names), product-driven |
| `eharness/activity`, `eharness/http`, `eharness/client`, `eharness/client/react` | Experimental, closest to stable | wire shapes are the contract; settle after one app release cycle |
| `eharness/scheduler`, `identity`, `channels`, `handoff`, `limits`, `clock` | Experimental | Draft (0.9); only the ports/stores are candidates for early promotion |
| `eharness/browser`, `eharness/browser/node` | Experimental | Draft, fast-moving; `browser/node` is Node-only |
| `eharness/guard`, `eharness/group`, `eharness/openapi` | Remove or adopt | Deprecated (ADR-0062); removed at 1.0 unless a product adopts them |

## Core (`eharness`, 74 runtime names)

| Class | Names |
|---|---|
| Stable | `defineHarnessAgent`, `definePlugin`, `wrapPlugin`, `defineDataPart`, `defineMessageKind`, `createKindMessage`, `isKindMessage`, `defineSkill`, `defineSkillSource`, `defineToolSource`, `parseSkillMarkdown`, `validateSkillPath`, `externalTool`, `HarnessError`, `isHarnessError`, `HarnessToolError`, `handleChatRequest`, `uuidv7`, `version`, `lookupModel`, `computeCost`, `estimateStepCostUsd`, stored-text constants (`INTERRUPTED_*`, `DENIED_NEW_INPUT`, `NOT_EXECUTED_NEW_INPUT`, `WAIT_TIMED_OUT`, `WAIT_CANCELLED_NEW_INPUT`, `CLIENT_TOOL_TIMED_OUT`, `TOOL_OUTPUT_TRUNCATED`, `TOOL_OUTPUT_PRUNED`, `FINAL_ANSWER_RECORDED`, `FLUSH_APPROVAL_DENIED`) |
| Experimental | `createJudge`, `judgeCoordinator`, `JudgeUnavailableError`, `DEFAULT_JUDGE_MAX_CALL_CHARS` (spec 15, ADR-0060); `observeModel`; `handleResumeRequest`; `modelsDevCatalog`, `openRouterCatalog`; `untrustedContent`, `UNTRUSTED_CONTENT_INSTRUCTIONS`, `neutralizeTags` (spec 03 §10 Draft); `toolTraits`, `withToolFields`, `withToolExecute`; `isLongRunCheckpoint`, `LONG_RUN_CHECKPOINT_STOP`; `messageToChunks`; `stripLeakedToolMarkup` |
| Internal-candidate | see below |

Likely accidental in core (path/glob/regex helpers and generic utilities that exist for
`filesystem`, `permissions` and `guard` through the "core only via `src/index.ts`" rule, ADR-0008):
`collapseSegments`, `foldSegment`, `normalizeRootedPath`, `MAX_ROOTED_PATH_LENGTH`,
`compileGitignorePattern`, `compileGlobRegExp`, `expandBraces`, `escapeRegExp`, `isLiteralPattern`,
`statelessPattern`, `unsafePatternReason`, `GLOB_MAX_BRACE_ALTERNATIVES`, `GLOB_MAX_DOUBLE_STARS`,
`GLOB_MAX_STARS`, `GREP_MAX_PATTERN`, `GREP_PATTERN_RULE`, `GREP_SCAN_CHARS`, `FILE_UNAVAILABLE`,
`isPrivateHost`, `isRecord`, `errorText`, `isUuidV7`. Reasons:

- Nothing in specs 01-11 documents them; they serve shipped plugins only.
- `GREP_SCAN_CHARS` and `statelessPattern` are exported by both `eharness` and
  `eharness/filesystem` (duplicate public names).
- `isPrivateHost` belongs to `eharness/web` and `eharness/http`; `isRecord`, `errorText`,
  `escapeRegExp` are generic.

The fix is an internal shared module (api-stability.md: "shared through an internal module, not
exported"), but plugins may import core only through `src/index.ts`, so it needs an ADR amendment
(for example a documented `eharness/internal`-style barrel that is not in `package.json#exports`).

## Subpath exceptions

| Subpath | Experimental | Internal-candidate / accidental |
|---|---|---|
| `filesystem` | `projectInstructions`, `loadProjectInstructions`, `DEFAULT_PROJECT_*`, `checkpointedFs`, `checkpointsSince`, `rewindFiles`, `inMemoryCheckpointStore`, `DEFAULT_CHECKPOINT_KEEP_TURNS` | `splitLines`, `normalizePath`, `compileGlob`, `looksBinary`, `detectMediaType`, `bytesVersion`, `contentVersion`, `classifyToolResult`, `isFileMediaRef`, `GREP_SCAN_CHARS`, `statelessPattern` (generic helpers; document or hide) |
| `filesystem/node` | `nodeCheckpointStore` | `nodeRealpath`, `nodeContainsProtected`, `nodeWorkspace`, `compileIgnore` |
| `mcp` | `listRemoteMcpTools`, `remoteMcpSource`, `bearerAuthProvider`, `clearMcpPins` | none |
| `shell` | all | `capOutput`, `SAFE_ENV_NAMES`, `removeStaleScratch`, `killAllSandboxProcesses`, `probeOsSandbox`, `detectOsSandbox` |
| `permissions` | `modelClassifier`, `ClassifierUnavailableError`, `AUTO_PAUSED_REASON` | `domainSpecifierMatches`, `isReadOnlyCommand`, `matchRule`, `parseRule` (document as rule API or hide) |
| `identity` | all | `PAIRING_ALPHABET`, `PAIRING_CODE_LENGTH`, `hashPairingCode`, `normalizePairingCode`, `generatePairingCode` (store implementers only), `MAX_PENDING_CODES`, `DEFAULT_CODE_TTL_MS` |
| `channels` | all | `abortableSleep` (generic) |
| `browser` | all | `isBrowserShotRef`, `OLDER_SCREENSHOT_TEXT`, `formatHandBack`, `matchesHost`, `checkUrl`, `sealedBrowserProfiles`, `publicProfile` |
| `browser/node` | all | `CHROME_VERSIONS_URL`, `LIGHTPANDA_RELEASES_URL`, `chromePlatform`, `lightpandaAsset`, `checkExtraArgs`, `systemMemory`, `processUsage`, `detectContainer` (runtime-installer internals) |
| `clock` | all | `zonedParts`, `fromZoned`, `offsetLabel`, `durationWords`, `DATETIME_DESCRIPTION` (documented time helpers; decide whether `clock` is a plugin or a date library) |
| `connectors` | all | `builtinConnectionId`, `CONNECTION_KIND`, `CREDENTIALS_KIND`, `DEFAULT_BUILTIN_ORDER`, `capabilitiesFromTools`, `compileConnectorRules`, `mergeConnectorRules`, `mostRestrictive`, `discoverMcpAuthorization`, `inMemoryRefreshLock` |
| `providers` | all | `ehMeta`, `formSpec`, `inMemoryCatalogCache`, `secretStatus`, `plaintextVault` (dev-only; keep but flag) |
| `activity`, `http`, `client`, `client/react` | all | `ATTENTION_EVENTS`, `CONTINUE_TEXT`, `isClippedPart`, `isNetworkError`, `chatBridgeOf` |
| `handoff`, `limits`, `subagent`, `todos`, `memory`, `web`, `code` | all | `MEMORY_FLUSH_TOOLS`/`MEMORY_TOOLS` and tool-name constants are stable once their module is; `executeMemoryCommand`, `parseRequirement`, `syncedSandbox`, `longRunState` need a doc or a hide |
| `testing` | stable suites; `fakeCdpPeer`/`fakeCdpError` experimental | none |

## Before 1.0

1. Decide the internal-helper mechanism, then move the core and subpath candidates above out of
   `package.json#exports` surface in one 0.x minor (changeset: `**BREAKING:**`).
2. Remove or adopt `guard`, `group`, `openapi` (ADR-0062).
3. Promote modules one at a time after an app release cycle; each promotion changes its row in
   api-stability.md and drops `@experimental` from its main symbols.
4. Re-run this classification from a fresh `bun scripts/exports-snapshot.ts` and add the type-only
   exports (the snapshot lists runtime names only).
