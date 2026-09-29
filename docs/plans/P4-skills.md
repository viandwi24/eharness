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

1. [ ] `defineSkill`, `defineSkillSource`, types (`SkillMeta`, `SkillDoc`, `SkillFileContent`).
2. [ ] Static skill → in-memory source adapter.
3. [ ] `paths.ts`: `validateSkillPath` (spec 07 §5) with exhaustive tests (traversal, backslash,
   NUL, empty segments, length, `SKILL.md`).
4. [ ] `frontmatter.ts`: YAML-subset parser + serializer for tests; rejects unsupported syntax.
   Export `parseSkillMarkdown` and `validateSkillPath` from `src/index.ts` (public helpers, spec 07
   §3) — P5 depends on them.
5. [ ] Registry: ordering, `refresh` caching, collisions (`EH_DUPLICATE_SKILL`, `W_SHADOWED`),
   per-turn lock.
6. [ ] Index block (sorted, stable text) and search mode (`skillsIndexLimit`, `search_skills`,
   fallback token matcher).
7. [ ] Tools `load_skill`, `read_skill_file`, `search_skills` with string errors; `skill.load`
   hook chain and notes.
8. [ ] `skillSourceConformance`.
9. [ ] Integration tests: scenario 8 of testing.md (static part; fs part completes in P5).

## Acceptance criteria

- [ ] A static skill with files and a dynamic source are indistinguishable from the model's side
      (same tool outputs for the same content) — golden test.
- [ ] No path that fails `validateSkillPath` ever reaches `SkillSource.readFile` (spy test).

## Open questions

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
