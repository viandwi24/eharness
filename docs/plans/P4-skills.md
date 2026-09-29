# P4 — Skills

Status: in progress · Branch: `phase/P4-skills`

## Goal

Static and dynamic skills with three-level loading, relative addressing, index/search modes, the
skill tools, collision handling and the conformance suite. Also the frontmatter parser used by the
filesystem source (P5).

## Specs

- 07 §1–§7 (§8 is P5)
- 02 §4, §5, §6

## Owns

`src/skills/**`, `src/testing/skill-source.conformance.ts`.

## Checklist

1. [x] `defineSkill`, `defineSkillSource`, types (`SkillMeta`, `SkillDoc`, `SkillFileContent`).
2. [x] Static skill → in-memory source adapter.
3. [x] `paths.ts`: `validateSkillPath` (spec 07 §5) with exhaustive tests (traversal, backslash,
   NUL, empty segments, length, `SKILL.md`).
4. [x] `frontmatter.ts`: YAML-subset parser + serializer for tests; rejects unsupported syntax.
   Export `parseSkillMarkdown` and `validateSkillPath` from `src/index.ts` (public helpers, spec 07
   §3) — P5 depends on them.
5. [x] Registry: ordering, `refresh` caching, collisions (`EH_DUPLICATE_SKILL`, `W_SHADOWED`),
   per-turn lock.
6. [x] Index block (sorted, stable text) and search mode (`skillsIndexLimit`, `search_skills`,
   fallback token matcher).
7. [x] Tools `load_skill`, `read_skill_file`, `search_skills` with string errors; `skill.load`
   hook chain and notes.
8. [x] `skillSourceConformance`.
9. [x] Integration tests: scenario 8 of testing.md (static part; fs part completes in P5).

## Acceptance criteria

- [x] A static skill with files and a dynamic source are indistinguishable from the model's side
      (same tool outputs for the same content) — golden test.
- [x] No path that fails `validateSkillPath` ever reaches `SkillSource.readFile` (spy test).

## Open questions

1. **Index split across blocks.** Spec 07 §4.1 shows one sorted index; spec 02 §5 puts static
   skills in block 1 and dynamic ones in block 2. Chosen: block 1 lists static skills (header +
   intro), block 2 lists dynamic ones under `# More skills` (or the full header + intro when there
   are no static skills). Each part is sorted. In search mode block 1 keeps the static index (or
   the hint when static skills alone exceed the limit) and block 2 carries only the search hint
   (review item 3). Spec 07 §4.1–§4.2 updated.
2. **Search hint text** was not specified: `# Skills` + one line (spec 07 §4.2 updated).
3. **YAML block scalars** — resolved (orchestrator DECISION): `|`, `|-`, `>`, `>-` are supported
   for string values (plain indentation, no indentation indicators, no `+`); everything else
   unsupported is still rejected. The description is trimmed. Spec 07 §8 updated.
4. **Failed `list()` warning code.** No code existed for skill sources; added
   `W_SKILL_SOURCE_FAILED` (spec 10, `src/errors.ts`; also used for failing `search()` /
   `locate()`). Reusing `W_TOOL_SOURCE_FAILED` would have been misleading.
5. **`locate()` was unreachable from `skill.load` hooks** (the event only carried the source id).
   Added `location?: { service, root }` to the `skill.load` event (additive; spec 01 §5 and 07 §7
   updated).
6. **`ERROR: invalid path`** now carries the reason (`ERROR: invalid path: <reason>`) so the model
   can self-correct; other error strings are listed in spec 07 §4.3.
7. **Static vs dynamic collisions** — resolved (review item 1): static skills are resolved before
   every dynamic source and always win (spec 02 §7); block 1 never depends on a dynamic listing.
   Spec 07 §6 updated.
8. **Skill tool presence** — resolved (orchestrator DECISION): decided per session.
   `load_skill`/`read_skill_file` exist whenever a skill source is configured (static skills
   count); `search_skills` iff `skillsIndexLimit` is finite and (static count > limit or any
   dynamic source). `skillsIndexLimit: Infinity` is accepted. `staticCount` still counts only
   static tools, so the explicit breakpoint does not include the skill tools.
9. **`skillsIndexLimit`** invalid values (negative, NaN) fall back to 50 instead of a boot error
   (boot validation is P2's `define-agent.ts`).
10. **Warnings from sources** — resolved (orchestrator DECISION): `HarnessContext.warn(warning)`
    added (session warning channel, `details.plugin`, default dedup per code + plugin + message,
    strict escalation, `data-eh.warning` in a turn). Spec 01 §4 and spec 10 §2 updated.

## Requests to other phases

- From P1: `Skill`, `SkillSource`, `SkillMeta`, `SkillDoc`, `SkillFileContent` are declared in
  `src/registry/types.ts` and exported. Boot tells skills from sources structurally (`id` +
  `list`/`load` functions = source; string `name` + `content` = skill) and throws
  `EH_DUPLICATE_SKILL` for duplicate static names. `defineSkill`, `defineSkillSource`,
  `parseSkillMarkdown`, `validateSkillPath` and skill name validation are not implemented.

- From P2: the per-turn registry is `resolveTurnRegistry()` in `src/registry/turn.ts`: add the
  skills index to the end of `block1` (static sources) / `block2` (dynamic sources, cached per
  session in `open.sessionBlock`) and the skill tools after the static tools in `entries` (stable
  order, spec 02 §6); `staticCount` marks the last static tool for cache breakpoints. Static skills
  and skill sources of setup and session phases are collected but unused
  (`internals.statics.skills` / `skillSources`, and the session registry built in `doOpen()` in
  `src/session/session.ts`, where session-phase duplicates already throw `EH_DUPLICATE_SKILL`).
  Hooks run through `open.hooks.list('skill.load')`.

## Hook-point edits outside `src/skills` (P4)

- `src/registry/turn.ts`: resolves the turn's skills, appends the index texts to block 1/2, adds
  the skill tools after the static tools (owner `'eh'`), exposes `TurnRegistry.skills`.
- `src/registry/static.ts`: static skills/sources validated like `defineSkill` /
  `defineSkillSource` at boot (`EH_CONFIG_INVALID` naming the owner).
- `src/session/runtime.ts` + `session.ts` (`doOpen`): `OpenSession.skills` built with
  `buildSessionSkills` (plugin order, setup before session contributions, `skillsIndexLimit`).
- `src/errors.ts`: `W_SKILL_SOURCE_FAILED`. `src/plugin/types.ts`: `location` in the
  `skill.load` event, `HarnessContext.warn`. `src/session/context.ts`: `ctx.warn` routed to
  `rt.warn`.
