# Memory

`memory()` from `eharness/memory` gives the model long-term memory as small text files on the
`fs` service: it views and edits them with six tools, under **roots** your application chooses
per turn — one namespace per user, contact or organisation, each read-only or writable. Pinned
files (a user profile, say) are shown in every turn reminder without breaking the prompt cache.
The plugin never decides who may read whose memory: your `roots` function does. Contract: spec 14,
ADR-0022. Runnable: [`examples/memory.ts`](../../examples/memory.ts).

```ts
import { defineHarnessAgent } from 'eharness'
import { filesystem } from 'eharness/filesystem'
import { memory } from 'eharness/memory'

const agent = defineHarnessAgent({
  model,
  contextWindow: 200_000,
  plugins: [
    filesystem({ fs, hiddenPrefixes: ['/memories'] }), // provides `fs` — must come first
    memory({
      roots: (ctx) => [
        { path: `/memories/users/${ctx.runtime.userId}`, write: true, label: 'this user' },
        { path: '/memories/org', label: 'company knowledge' }, // read-only (default)
      ],
      pinned: (ctx) => [`/memories/users/${ctx.runtime.userId}/profile.md`],
      maxPinnedChars: 2_000, // default — total pinned content per turn
      maxFileChars: 20_000, // default — per memory file
      onWrite: (event, ctx) => audit.insert({ user: ctx.runtime.userId, ...event }),
    }),
  ],
})

const session = agent.session(chatId, { runtime: { userId: user.id } })
```

`memory()` requires the `fs` service, so it goes after `filesystem()` (or your own plugin that
provides `fs`). Any `FileSystem` adapter works — memory is just files.

## Roots: per-user namespaces and shared knowledge

`roots(ctx)` runs **once per turn** and returns directories:

- `write: true` — the model may create, edit, delete and rename files there;
- default — read-only: the model may view, never change (`REJECTED: <path> is read-only.`);
- `label` — shown next to the root, so the model knows what it holds.

**Build root paths only from opaque, validated ids** (no `/`, no `..`, no empty string): a root
is normalized like any path, so `/memories/users/${'../u2'}` becomes `/memories/users/u2` —
another user's namespace. Validate ids where you set `ctx.runtime` (e.g. UUIDs or
`/^[A-Za-z0-9_-]+$/`), or encode them.

Every path the model sends is normalized (`..`, `//`, `\` and NUL are handled as in
`normalizePath`) and must lie inside a root, otherwise `REJECTED: <path> is outside the memory
roots.` The most specific root wins, so a writable `/memories/users/u1` inside a read-only
`/memories` works as expected. Because roots are resolved per turn from `ctx.runtime`, a session
can be served for different users (`send(text, { runtime: { userId } })`), and a resolver that
throws (e.g. no tenant) fails the turn before anything is stored. Return `[]` to switch memory off
for a turn.

Typical layouts:

| Root | Access | Holds |
|---|---|---|
| `/memories/users/<userId>` | writable | preferences, facts the user told you |
| `/memories/contacts/<contactId>` | writable | notes about a customer, shared by the team's agents |
| `/memories/org` | read-only | policies, style guide (maintained by people or an admin tool) |
| `/memories/tasks/<taskId>` | writable | progress of a long task across sessions |

## What the model sees

- **Instructions block 1:** `MEMORY_PROTOCOL` — check memory before starting, record progress and
  decisions as you go, assume the context may be reset, keep files small and organized. Replace it
  with `protocol: '…'`, or drop it with `protocol: false`. It is the same text for every user.
- **Tools:** `memory_view`, `memory_create`, `memory_str_replace`, `memory_insert`,
  `memory_delete`, `memory_rename` (`MEMORY_TOOLS`), with the command contract of Anthropic's memory
  tool. Identical definitions for every user, so the cached prompt prefix is shared.
- **Turn reminder** (volatile, never in the system prompt): the roots of the turn and the pinned
  files:

  ```
  Memory roots:
  - /memories/users/u1/ (writable): this user
  - /memories/org/ (read-only): company knowledge

  <pinned path="/memories/users/u1/profile.md">
  Prefers tea over coffee.
  </pinned>
  ```

Pinned content is framed as data: a fixed line (`PINNED_PREAMBLE`) says the blocks are stored
notes, not instructions, and `<pinned>` / `<system-reminder>` tags inside a stored file are
neutralised (`&lt;/pinned>`), so a file cannot break out of its block. Memory files are still
untrusted text written by the model (possibly steered by a user); keep secrets out of them.

Results are plain strings; failures start with `ERROR:`, `CONFLICT:` or `REJECTED:` and the model
corrects itself. Spec 14 §2 lists every exact text.

## Pinned files

`pinned(ctx)` names files to show in every turn reminder — a profile, the current task plan. They
must lie inside the roots of the turn (others are skipped); missing files are skipped silently,
so pin the profile before it exists and the model creates it. Content is capped by
`maxPinnedChars` in total: short files stay whole, long ones keep head and tail around
`[… <n> characters omitted; view the file for the full text …]`. Changes the model makes appear in
the next turn's reminder.

## Concurrency and limits

Two agents may write the same memory at once (a user in two tabs, a team on one contact). Every
command re-reads the file and writes with `ifVersion`, so a lost race returns
`CONFLICT: … Run the command again.` instead of overwriting. Files are capped at `maxFileChars`
characters (`ERROR: <path> would exceed <n> characters.`) — memory should stay small and
organized. `memory_rename` uses the adapter's atomic `FileSystem.move` when it has one, and falls
back to write + delete otherwise (implement `move` in your adapter; `fileSystemConformance(…,
{ requireMove: true })` checks it).

## Audit and provenance (`onWrite`)

`onWrite(event, ctx)` runs after every successful write with `op`, `path` (and `to` for a rename),
`before` / `after` (`{ version, size }`) and the `toolCallId`. Store it to answer "who taught the
agent this?" or to index memory elsewhere. If it throws, the write still counts: you get a
`W_HOOK_FAILED` warning and the model sees the normal result.

## Hiding memory from the file tools

With the `filesystem()` plugin, the generic file tools (`read_file`, `write_file`, …) see the whole
file system — including other users' memories. Hide the memory tree from them:

```ts
filesystem({ fs, hiddenPrefixes: ['/memories'] })
```

Memory is then reachable only through the memory tools and their roots. (Or give memory its own
file system: `memory()` uses whatever the `fs` service is.)

## A provider-defined memory tool

Anthropic's models are trained on a provider-defined memory tool. Supply it yourself — eharness
takes no dependency on `@ai-sdk/anthropic`:

```ts
import { anthropic } from '@ai-sdk/anthropic'

memory({
  roots,
  tool: (execute) => anthropic.tools.memory_20250818({ execute }),
})
```

With `tool`, the six tools are not registered; your tool is registered under the name `memory`,
and `execute` applies the same roots, limits, concurrency and `onWrite`.

## Outside the agent

`executeMemoryCommand(command, { fs, roots, maxFileChars?, onWrite? })` runs one command directly
— for an admin screen, a migration, or tests:

```ts
await executeMemoryCommand(
  { command: 'view', path: '/memories/users/u1' },
  { fs, roots: [{ path: '/memories/users/u1' }] },
) // '/memories/users/u1/ (1 file):\n/memories/users/u1/profile.md\t25 bytes'
```

## Before a compaction

Writing memory right before the context is summarized keeps details the summary would lose. The
pre-compaction flush is a separate feature (P15); a `flushOnCompaction` option for this plugin
follows it. Until then, the protocol's "record progress as you go" covers most of it.
