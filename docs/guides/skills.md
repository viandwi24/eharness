# Skills

A skill is a playbook the **model** opens when it is relevant: a name and a one-line description
are always in the prompt; the body and supporting files are loaded on demand (progressive
disclosure). The format follows the Agent Skills convention (`SKILL.md` + files). Contract:
spec 07.

## Static skills

```ts
import { defineHarnessAgent, defineSkill } from 'eharness'

const agent = defineHarnessAgent({
  model,
  skills: [
    defineSkill({
      name: 'release-notes', // ^[a-z0-9]+(-[a-z0-9]+)*$, max 64
      description: 'How we write release notes. Use when drafting a changelog or release post.',
      content: 'Group changes by user impact. Read template.md first.',
      files: [{ path: 'template.md', content: '## Highlights\n\n## Fixes\n' }],
    }),
  ],
})
```

What the model gets:

- an index in the system prompt: `- release-notes: How we write release notes. …` (sorted by name;
  above `skillsIndexLimit` = 50 skills it switches to a `search_skills(query)` tool);
- `load_skill(name)` → the body plus a `Files:` list;
- `read_skill_file(name, path)` → one file. Paths are relative to the skill (`template.md`), never
  filesystem paths, so a skill works unchanged from any source.

Skill content enters the conversation as tool results, never the system prompt, so the prompt
cache prefix stays stable.

### Versions

A skill may carry a `version` (1–64 printable characters) — `defineSkill({ …, version: '2.1.0' })`,
or `version: 2.1.0` in the `SKILL.md` frontmatter (always read as text: `1.0` stays `"1.0"`).
`load_skill` shows it right after the description (`version: "2.1.0"`), and `skill.load` hooks
receive it as `e.version`, so you can audit which version a turn used:

```ts
hooks: {
  'skill.load': (ctx, e) => void audit.log({ turn: ctx.turn?.id, skill: e.skill.name, version: e.version }),
}
```

The skills index never shows versions, so bumping one does not break the prompt cache. Skills
without a version look exactly as before.

## Skills from a file system

Put folders with a `SKILL.md` under one root:

```
/skills/release-notes/SKILL.md
/skills/release-notes/template.md
```

```md
---
name: release-notes
description: How we write release notes. Use when drafting a changelog or release post.
license: MIT
---
Group changes by user impact. Read template.md first.
```

```ts
import { filesystem } from 'eharness/filesystem'
import { memoryFs } from 'eharness/filesystem/memory'

const plugin = filesystem({
  fs: memoryFs(), // or your own FileSystem adapter
  skills: { root: '/skills', refresh: 'turn' }, // 'turn': new SKILL.md files appear next turn
})
```

The skills root is hidden from the file tools by default (`hideSkillsRoot: true`): the model reads
skills only through the skill tools and cannot edit them. Without the plugin, use
`fsSkillSource(fs, { root: '/skills' })` from `eharness/filesystem` directly in `skills`.

## Your own source (database, API, per tenant)

```ts
import { defineSkillSource, parseSkillMarkdown } from 'eharness'

const tenantSkills = defineSkillSource({
  id: 'db:tenant-skills',
  refresh: 'turn',
  // L1: metadata only — called at the first turn of a session (or every turn with 'turn')
  async list(ctx) {
    return [{ name: 'house-style', description: `House style of ${String(ctx.runtime.tenant)}.` }]
  },
  // L2: body + manifest (paths and sizes, no content); null = not found
  async load(name) {
    const parsed = parseSkillMarkdown(
      '---\nname: house-style\ndescription: House style.\n---\nBe brief.',
    )
    if ('error' in parsed || parsed.meta.name !== name) return null
    return { ...parsed.meta, content: parsed.body, manifest: [] }
  },
  // L3: one file by skill-relative path (already validated); null = not found
  async readFile(name, path) {
    return null
  },
})
// defineHarnessAgent({ model, skills: [tenantSkills] })
```

Rules: a static skill always wins a name collision with a dynamic source (`W_SHADOWED`); between
sources the first one wins. A source that throws is skipped for that turn with
`W_SKILL_SOURCE_FAILED` — the turn still runs.

Test a source with the conformance suite; the factory must serve exactly the fixture skills it
receives:

```ts
import { test } from 'bun:test'
import { skillSourceConformance } from 'eharness/testing'

// mySource(skills) builds your source over exactly these skills (e.g. rows in a test database)
for (const c of skillSourceConformance((skills) => mySource(skills))) test(c.name, c.run)
```

## Executable skills

Skills may ship scripts. Reading them needs only the logical address; running them needs an
executor (a future sandbox plugin). Sources can expose a physical location with `locate(name)`,
and a `skill.load` hook can add a note such as "Executable copy: /skills/x" to the `load_skill`
result (spec 07 §7).
