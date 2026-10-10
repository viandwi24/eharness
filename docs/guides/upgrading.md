# Upgrading to 0.7

0.7 adds six subpaths (`eharness/permissions`, `eharness/shell`, `eharness/subagent`,
`eharness/ask`, `eharness/web`, `eharness/filesystem/node`) and many session APIs. Nothing is removed,
but several defaults and model-visible texts change. Read the list below, then run your tests: every
item names what you will notice.

The peer dependencies are unchanged (`ai@^7.0.127`, `zod`, optional `@ai-sdk/mcp@^2.0.66`).

## Behaviour changes

| Area | What changes | What to do |
|---|---|---|
| `mcpServer` | Text parts of tool results (also of tools without `toModelOutput`) reach the model inside `<untrusted-content source="mcp" name="<server>/<tool>">…</untrusted-content>`. Images, structured JSON and `isError` are unchanged. | Add `UNTRUSTED_CONTENT_INSTRUCTIONS` to `instructions`. Opt out per server with `wrapUntrusted: false`. Update golden prompts. |
| `filesystem` tools | A `glob` tool is on by default (the tool list and the prompt-cache prefix change). | Pass `tools` without `'glob'` to keep the old list. |
| `filesystem` errors | Exceptions thrown by an adapter reach the model as `ERROR: <message>` (`classifyToolResult` says `'error'`) instead of `Error: …`. | `onAdapterError(error, { tool, path })` customises the text; returning `undefined` rethrows (the old behaviour). |
| `edit_file` | Accepts `edits: [{ old_string, new_string, replace_all? }]`; the single form still works. | Nothing, unless a test asserts the input schema. |
| Binary files | `list`, `stat` and `glob` show binary files; `read_file` shows images (and PDFs with `media: { pdf: true }`); other binaries answer an `ERROR:` text. | Custom `FileSystem` adapters may implement `readBytes` / `writeBytes`. |
| `session.stats()` | Measures the whole next request (skills index, turn-refresh instructions, skill and source tools), so `instructions` and `tools` can be larger. Deferred tools count 0. New `instructionBlocks` and `toolSources`. | Re-check thresholds built on `stats()`. |
| `PendingState.clientTools[]` | Entries gain `input` (and `inputTruncated: true` above 16 KB, then `input` is omitted). | Assertions with `toEqual` on these entries need the field. |
| `send(…, { ifBusy: 'steer' })` | When the running turn refuses the steer at once (its step loop ended, a manual `compact()` runs), the returned run is the queued turn's run, not an `attach()` of the running turn. | Use `run.delivery` (`'step' \| 'turn' \| 'dropped'`) to see what happened. |
| `core.children` state | State writes of an owner with a `setIf` adapter are compare-and-sets; on a conflict the write takes over `core.children`. The commit-point write no longer fails with `EH_SESSION_BUSY` when only a child registered meanwhile. | Make sure your `StateAdapter.setIf` is a real compare-and-set. |
| `respond()` stream | The continuation stream starts with one `tool-approval-response` chunk per consumed approval, between `start` and the first tool output. | Stream readers that rebuild messages (`readUIMessageStream`, `attach()`) now see answered calls leave `approval-requested` at once; `useChat` is unaffected. Update goldens. |
| `output-error` tool parts | A `rawInput` field is normalised to `input` before persisting, validating and projecting. | Nothing; AI SDK's `rawInput` deprecation warning goes away. |
| `eh.event`, `eh.compaction` | Projections escape the event name and neutralise `event`, `system-reminder`, `untrusted-content` (and `conversation-summary`) tags inside the text. | Nothing, unless you asserted the raw projected text. |
| New names | Hook `session.fork`; warning code `W_TOOL_ORDER`; `WarningCode` gains a member. | Exhaustive `switch`es over `WarningCode` need a case. |

`webFetch()` and `webSearch()` frame their output the same way (`source="web_fetch"`,
`source="web_search"`); they did not exist in 0.6, so there is nothing to migrate.

## New things worth adopting

- `session.fork()`, `children()`, `parentInfo()`, `session.tools()`, `compact({ keepLast, instructions })`,
  `toolOrder`, `deferTools`, `ctx.session.inject()`, `run.delivery`, `respond({ endTurn })` and
  approval notes: see the [reference](reference.md).
- `projectInstructions()` loads `CLAUDE.md` / `AGENTS.md` from the `fs` service (Draft).
- A coding agent: [filesystem](filesystem.md), [shell](shell.md), [permissions](permissions.md),
  [subagents](subagents.md), [ask](ask.md), [web](web.md), and the
  [coder example](../../examples/coder/README.md).

## Draft surfaces

These may change in a minor release ([API stability](../engineering/api-stability.md#draft-modules-and-sections)):
the `auto` permission mode and classifier, agent messaging (`send_message`, names, resume, roster),
the deferred-tools reminder format, the `<untrusted-content>` frame format and the
`projectInstructions()` frames and defaults.

## Known gaps

- The built-in `Read(.env*)` ask does not cover recursive directory reads, so a recursive `grep` or
  `find` through `bash` can read `.env` files without asking. Add `Read(**/.env*)` to `deny` or
  `ask`, and run `bash` in an OS sandbox ([permissions](permissions.md)).
- `webFetch()` cannot resolve DNS (it is runtime-neutral): without `resolveHost`, a public name that
  resolves to a private address is not refused (DNS-based SSRF). Inject a resolver on any server
  that fetches for untrusted users ([web](web.md)).
- The shell command analysis is a gate, not a sandbox.
