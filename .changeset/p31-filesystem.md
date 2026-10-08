---
"eharness": minor
---

`eharness/filesystem`: multi-edit `edit_file`, a `glob` tool and `ERROR:` adapter errors.

- `edit_file` accepts `edits: [{ old_string, new_string, replace_all? }]` (1–50) instead of `old_string`/`new_string`. Applied in order, all or nothing (`ERROR: edit 3 of 5: …`), with one read/staleness check, one write and one change part; result `Edited <path> (<n> edits, <m> replacements).`. The single form is unchanged.
- New `glob({ pattern, path? })` tool (`**`, `*`, `?`, `[abc]`, `{a,b}`; newest first when the adapter provides `updatedAt`; max 200). Optional adapter fast path `FileSystem.glob?(pattern, { prefix, limit })` (conformance: `requireGlob`). The matcher is exported as `compileGlob`. **Tool-list change:** `glob` is on by default, which changes the tool list and therefore the prompt-cache prefix; pass `tools` without `'glob'` to keep the old list.
- **Model-visible behaviour change:** exceptions thrown by an adapter (`read`, `write`, `list`, …) now reach the model as `ERROR: <message>` (and `classifyToolResult` says `'error'`) instead of an ordinary tool error `Error: …`. New option `onAdapterError(error, { tool, path })` customises the text; returning `undefined` rethrows (the old behaviour).
