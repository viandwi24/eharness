---
"eharness": patch
---

Skills: `defineSkill` and `defineSkillSource` with validation, static skills served through an
in-memory source, skill-relative addressing with `validateSkillPath`, and `parseSkillMarkdown`
(a dependency-free YAML subset for `SKILL.md` frontmatter). The per-turn skill registry lists
sources in plugin order with `refresh` caching, first-wins shadowing (`W_SHADOWED`), invalid
metadata skipped (`W_INVALID_SKILL`) and failed listings retried next turn (new warning
`W_SKILL_SOURCE_FAILED`). The model sees a sorted skills index in the system prompt (static skills
in block 1, dynamic ones in block 2) or, above `skillsIndexLimit`, a hint and `search_skills`;
`load_skill` and `read_skill_file` return errors as `ERROR:` strings and never pass an invalid
path to a source. The `skill.load` hook event now carries `location` from `SkillSource.locate()`.
`eharness/testing` adds `skillSourceConformance` and `SKILL_SOURCE_FIXTURE`.
