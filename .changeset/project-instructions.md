---
"eharness": minor
---

`eharness/filesystem` gains `projectInstructions()` and `loadProjectInstructions()`: the project's `CLAUDE.md` / `AGENTS.md` are loaded from the `fs` service (per directory the first of `files`, default `['CLAUDE.md', 'AGENTS.md']`, wins), the root file as a static instruction with a size cap and framing, nested files as a list to read on demand. The result is provided as the `projectInstructions` service.
