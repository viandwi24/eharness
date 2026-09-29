# P4 — Skills

Status: todo · Branch: `phase/P4-skills`

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
