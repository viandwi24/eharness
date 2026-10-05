# Spec 02 — Context registry (static vs dynamic)

Status: **Accepted (reviewed for 0.1.0)**. Module: `src/registry`.

The registry decides **what the model can see and call** in a given turn: instructions, tools,
skills (index), MCP tools. Every slot accepts either a **static value** (known at compile time,
declared as a `const`) or a **dynamic source** (resolved at runtime). Both are first-class; the
agent and the model cannot tell them apart.

## 1. Slot overview

| Slot | Static | Dynamic |
|---|---|---|
| instructions | `string` | `(ctx) => string \| undefined \| Promise<…>`, refreshed per session or per turn |
| tools | `Tool` or `(ctx) => Tool` in a record | `defineToolSource({ list, refresh, defer })` |
| skills | `defineSkill({...})` | `defineSkillSource({ list, load, readFile, … })` (spec 07) |
| mcp | — | `mcpServer({...})` → a `ToolSource` (spec 09) |

## 2. Instructions

```ts
export type InstructionInput =
  | string                                                             // static
  | { text: string; id?: string }                                      // static, id for debugging
  | InstructionFn                                                      // dynamic, refresh 'session'
  | { text: InstructionFn; refresh: 'session' | 'turn'; id?: string }  // dynamic, explicit refresh
type InstructionFn = (ctx: HarnessContext) => string | undefined | Promise<string | undefined>
```

| Kind | Evaluated | Placed (§5) |
|---|---|---|
| static | at boot / session open | system block 1 (static) |
| dynamic, `refresh: 'session'` (default for functions) | at the first turn of the session, then cached | system block 2 (session) |
| dynamic, `refresh: 'turn'` | at every turn start | **turn reminder** message, not the system prompt |
| skills index (spec 07 §4) | with the skill registry | end of system block 1 (static sources) or block 2 (dynamic sources) |
| `step.prepare` `reminder` | per step | **step reminder** message, not the system prompt |

Within a block, texts appear in plugin order (root first, so `config.instructions` leads) and are
joined with a blank line; empty results are skipped. An instruction function that throws fails the
turn before the commit point (a run error; instructions are never silently dropped). Use `refresh: 'turn'` only for values that
really change every turn (time, live counters); everything else should be `'session'` so the
system prompt stays byte-identical for the whole session (prompt cache, §6).

Dynamic instructions and dynamic sources (tool sources §3.2, skill sources) resolve **before** the
turn's input is normalized and submitted (`input.submit`): during that phase `ctx.turn.input` is
`undefined` even for a `send()` with input. A `refresh: 'turn'` text must not depend on the
current user message; input-dependent context belongs in a `step.prepare` `reminder`, which sees it.

## 3. Tools

### 3.1 Static tools

```ts
tools: {
  get_price: tool({...}),                              // plain AI SDK tool
  note: (ctx) => tool({ ..., execute: async (i) => ctx.state.get('x') }),   // resolved once per session
}
```

`(ctx) => Tool` functions are resolved at session open, **after** every plugin's `session()` phase,
so they can use any service.

### 3.2 Tool sources

```ts
export function defineToolSource(src: ToolSourceDef): ToolSource   // ToolSourceDef + readonly '~toolSource': true (runtime brand)

export interface ToolSourceDef {
  /** Unique source id, e.g. 'mcp:github'. Used in warnings and for dedupe. */
  id: string
  /** Return the tools currently available. */
  list(ctx: HarnessContext): Promise<ToolSet> | ToolSet
  /** When to call list(): once per session at its first turn (default), or before every turn. */
  refresh?: 'session' | 'turn'
  /** Mark returned tools `deferLoading: true` → discovered via tool search (§3.3). Default false. */
  defer?: boolean
  /** Optional lifecycle, called at session open / close. */
  open?(ctx: HarnessContext): Promise<void> | void
  close?(): Promise<void> | void
}
```

### 3.3 Deferred tools and tool search

If at least one tool in the turn's tool set has `deferLoading: true` (from a `defer: true` source or
set by the developer), the core adds AI SDK's `toolSearch()` under the reserved name
`tool_search`. The model initially sees only non-deferred tools plus `tool_search`.

AI SDK tracks discovered tools **per `streamText` call**, and eharness runs one call per step
(ADR-0002), so the core tracks discovery itself:

- After each step, the core reads every `tool_search` tool result in the step's response messages
  (`output.tools[].name`) and adds those names to a turn-level `discovered` set.
- The next step's tool set contains each discovered tool as a shallow copy with
  `deferLoading: false`, so it is directly callable.
- At turn start the set is seeded by scanning `tool_search` results in the loaded context, so
  discoveries survive reloads. Discoveries that were compacted away require a new search.
- Discovered tools change the provider-visible tool list (cache cost, §6).
- Do not wrap or re-create `toolSearch()`: AI SDK recognises it by a symbol and replaces its
  `execute` with its own search, so a wrapper would never run. Observe searches through the
  `tool_search` tool results instead.

Prompt-cache note: direct tool search changes the provider-visible tool list and can invalidate the
cached prefix. Code mode (`@ai-sdk/code-mode`, `toolDiscovery: 'conversation'`) preserves it; it is
**out of scope for v0** and tracked in the roadmap.

## 4. Skills

Static `Skill` objects and dynamic `SkillSource`s share one registry (spec 07). The registry
exposes `index()` (level-1 metadata for the prompt) and `get(name)` (level 2/3 on demand).

## 5. Prompt layout per step (normative)

What one `streamText` call receives:

```
instructions: SystemModelMessage[] =
  [ block 1: static instructions + static skills index        (cache breakpoint in 'breakpoints' mode)
  , block 2: session-refresh instructions + dynamic skills index ]      (omitted when empty)
tools:        stable order (§6 rule 1), deferred tools hidden until discovered (§3.3)
messages:     projection of the view (spec 03 §6)
              with the TURN REMINDER inserted directly before the current turn's first message
              and the STEP REMINDER appended at the very end (after the latest tool results)
```

- Reminders are `user` model messages whose text is wrapped in
  `<system-reminder>…</system-reminder>`, built fresh for each step, **never stored** and never
  shown in the UI. The turn reminder holds the turn-refresh instructions; the step reminder holds
  the concatenated `step.prepare` `reminder` patches.
- System messages are never placed inside `messages` (AI SDK rejects them without
  `allowSystemInMessages`).
- **Exception — first step of a `respond()` continuation:** the wire must end with the `tool`
  message that carries the approval responses (AI SDK only collects approvals when the last
  message has role `tool`), so that step gets no step reminder (spec 11 §4 step 5). The turn
  reminder still sits before the turn's first message.
- A `step.prepare` `messages` rewrite replaces the (projected, sanitized) wire of that step; the
  hook sees the wire **without** reminders (`StepPrepareEvent.messages`), and the turn and step
  reminders are inserted into the rewritten wire afterwards, so a rewrite never drops them.
- Reminder text format (model-visible): `<system-reminder>\n{text}\n</system-reminder>`; several
  `step.prepare` reminders of one step are joined with a blank line.

## 6. Prompt caching (normative)

Providers cache a request prefix in the order **tools → system → messages**. Anything that changes
earlier in that order invalidates everything after it. Rules:

1. **Stable tool list.** Order: static tools (plugin order, then declaration order) → skill tools
   (`load_skill`, `read_skill_file`, `search_skills`) → source tools (plugin order, then `list()`
   order) → `tool_search` → the per-turn output tool of `SendOptions.output` in tool mode (0.4.0,
   spec 05 §3.3; last, so turns without it keep the whole prefix). `activeTools` changes and tool-search discoveries change the tool list
   and therefore bust the whole cache; the core warns `W_CACHE_BUST` once per turn when
   `activeTools` differs from the previous step. Prefer `toolChoice` or `tool.approve` denials for
   per-step restrictions. The core passes this order to AI SDK as `toolOrder` (otherwise AI SDK
   sorts unlisted tools alphabetically), so the order the provider sees is exactly this one.
2. **Stable system prompt.** Blocks 1–2 stay identical for the whole session unless configuration
   or a session-refresh source changes. Volatile text goes to reminders (§5), which sit after the
   cached prefix.
3. **Deterministic content.** Skills index sorted by name; no timestamps or counters in static or
   session instructions.
4. **On-demand content is history.** Skill bodies/files are tool results, never system text.

### 6.1 Cache configuration

```ts
cache?: false | { mode?: 'auto' | 'breakpoints'; ttl?: '5m' | '1h' }   // default { mode: 'auto' }
```

Applied only when the step's model is an Anthropic model (provider id starts with `anthropic`, or a
gateway id `anthropic/…`); for other providers the option is a no-op (they cache automatically or
not at all). Never send `cacheControl` to other providers.

| Mode | What the core does |
|---|---|
| `'auto'` (default) | call-level `providerOptions.anthropic.cacheControl = { type: 'ephemeral', ttl }` (Anthropic automatic caching: the breakpoint follows the last cacheable block) |
| `'breakpoints'` | explicit `cacheControl` on (a) system block 1, (b) the last static tool, (c) the last **stable** message of the wire (the one before any reminder), and (d) in long tool loops one more message every ~15 content blocks back (Anthropic's 20-block lookback); never more than 4 breakpoints |
| `false` | nothing |

Usage metadata records cache reads/writes (`metadata.eharness.usage.cachedInputTokens`,
`cacheWriteTokens`) so the effect is measurable.

## 7. Resolution timing and conflicts

| Item | Resolved | Name conflict with a static item | Conflict between dynamic items |
|---|---|---|---|
| static tool/skill/instruction | boot (`setup`) or session open (`session()`) | `EH_DUPLICATE_*` thrown | — |
| `ToolInput` function | session open | `EH_DUPLICATE_TOOL` thrown | — |
| source with `refresh: 'session'` | first turn of the session (not at open) | static wins, warning `W_SHADOWED` | first source (plugin order) wins, `W_SHADOWED` |
| source with `refresh: 'turn'` | turn start | same | same |

A dynamic source returning a **reserved** tool name (`tool_search`, `load_skill`,
`read_skill_file`, `search_skills`) is treated like a shadowed name: skipped with `W_SHADOWED`.
A failed `list()` contributes nothing for that turn and is retried at the next turn regardless of
`refresh` (`W_TOOL_SOURCE_FAILED`).

Warnings are sent to `config.onWarning` **and** written to the turn stream as a transient
`data-eh.warning` part (spec 04) when a turn is running.

**Per-turn lock:** the resolved set (system blocks, turn reminder, tool set, skill index) is computed at turn
start and **does not change during the turn**, except for tools discovered via tool search.
Changing sources or configuration takes effect at the next turn boundary.

## 8. Registry API (internal, but tested)

```ts
interface TurnRegistry {
  system: SystemModelMessage[]   // blocks 1–2 (spec §5), stable for the session
  turnReminder: string | undefined // turn-refresh instructions for this turn
  tools: ToolSet                 // wrapped with tool.before/after hooks, deferred tools included
  /** Tool set for one step: deferred tools in `discovered` become non-deferred copies (§3.3). */
  toolsForStep(discovered: ReadonlySet<string>): ToolSet
  skills: SkillIndexEntry[]      // sorted by name, locked for the turn
}

type SkillIndexEntry = SkillMeta & { source: string }   // source = SkillSource.id
```

Level 2/3 access (`getSkill` / `readSkillFile`) lives in the skill tools of the turn
(`src/skills/tools.ts`: `loadSkillText`, `readSkillFileText`), which resolve names only against the
turn's locked set and validate paths before calling the owning source (spec 07 §4.3, §5).
