---
"eharness": patch
---

Core foundations: `HarnessError` with stable `EH_*` codes, `isHarnessError`, `HarnessToolError`
and warning codes; monotonic UUIDv7 ids (`uuidv7`, `isUuidV7`); the message model
(`HarnessUIMessage`, `metadata.eharness`, `InferHarnessUIMessage`, stop reasons, turn results) and
fixed model-visible texts; `defineDataPart`, `defineMessageKind`, `createKindMessage`,
`isKindMessage` and the core `eh.*` data parts and kinds; `definePlugin` with typed hooks,
services and a namespaced stream writer; `defineToolSource`; and `defineHarnessAgent` with the
root plugin, synchronous setup phase and boot validation (duplicate tools/skills/data parts,
service conflicts, missing services, plugin order, invalid names and options). `agent.session()`
is not implemented yet. `eharness/testing` adds `idGeneratorConformance`.
