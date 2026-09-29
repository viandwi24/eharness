---
"eharness": patch
---

Skills: `defineSkill` and `defineSkillSource` with validation, static skills served through an
in-memory source, skill-relative addressing with `validateSkillPath`, and `parseSkillMarkdown`
(a dependency-free YAML subset for `SKILL.md` frontmatter, including `|`/`>` block scalars). The
per-turn skill registry lists sources in plugin order with `refresh` caching, static skills winning
over dynamic ones and first-wins shadowing between sources (`W_SHADOWED`), invalid
metadata skipped (`W_INVALID_SKILL`) and failed listings retried next turn (new warning
`W_SKILL_SOURCE_FAILED`). The model sees a sorted skills index in the system prompt (static skills
in block 1, dynamic ones in block 2) or, above `skillsIndexLimit`, a search hint. The skill tools
are stable for the whole session (`load_skill`/`read_skill_file` whenever a skill source exists,
`search_skills` when search mode is reachable); they return errors as `ERROR:` strings and never
pass an invalid path to a source. The `skill.load` hook event now carries `location` from
`SkillSource.locate()`, and plugins can emit warnings with the new `ctx.warn()`.
`eharness/testing` adds `skillSourceConformance` and `SKILL_SOURCE_FIXTURE`.
