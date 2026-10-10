---
"eharness": minor
---

`eharness/filesystem` gains `projectInstructions()` and `loadProjectInstructions()` (Draft): the project's `CLAUDE.md` / `AGENTS.md` are loaded from the `fs` service (per directory the first of `files`, default `['CLAUDE.md', 'AGENTS.md']`, wins). The root file becomes a static instruction with a size cap (`maxChars`, default 40 000) and a frame (`frame`); nested files are listed to read on demand (`nested`, `maxNested`, `nestedFrame`). The result is provided as the `projectInstructions` service. The frames and defaults may change in a minor release.
