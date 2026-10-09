# coder: a terminal coding agent on eharness

`coder` is a terminal coding agent: you chat with a model in an Ink UI, and it reads, searches, edits
and runs commands in your project. It is built only on the public eharness API: the core and the
shipped modules (`eharness/filesystem`, `filesystem/node`, `shell`, `permissions`, `subagent`, `ask`,
`web`, `todos`, `mcp` and `testing`). It is an example: it lives in a Bun workspace package
(`eharness-coder`), is private and is never published. It is deployment profile (b) of
[ADR-0034](../../docs/decisions/0034-deployment-profiles.md): one interactive process, approvals
answered in process.

## Built on the library

The point of the example is to prove the library: everything that is not product or UI policy is a
shipped module. The app only decides **what to ask the user, how to show it and which defaults to
use**.

| Capability | From the library | What the app adds |
|---|---|---|
| Virtual file tree, disk access, containment | `eharness/filesystem/node`: `nodeWorkspace` (`diskFs`, `mountFs`) | `request_directory_access` tool (asks, too-broad refusals) |
| File tools, `glob`, images, tool-output eviction, skills | `eharness/filesystem` | the `.coder/skills` location |
| Rewind of files and conversation | `filesystem({ checkpoints })` + `nodeCheckpointStore`, `rewindFiles`, `checkpointsSince`, `session.fork()` | which prompts `/rewind` lists, subagent edits in the rewind, session names |
| `bash`, background shells, live output, OS sandbox | `eharness/shell`: `shell({ background })`, `localSandbox`, `shellTasks` | the `/tasks` page and footer (`app/tasks.ts`), settings toggle |
| Rules, modes, shell analysis, plan mode | `eharness/permissions`: `createPermissionEngine`, `permissionsPlugin` | app tool kinds, `.coder` protected paths, `persist` writing project-scope rules to `settings.local.json`, `request_directory_access` as an `alwaysAsk` tool kind, the approval broker, `describeApproval` (diffs), audit log, settings files and project trust |
| `agent` tool, child sessions, background agents | `eharness/subagent` (`approvals: 'inline'`) | agent definitions from files (`agents/load.ts`), `answer` = the broker labelled with the agent name |
| `ask_user_question` | `eharness/ask`: `askUser`, `pendingQuestions`, `answerOutput` | the question dialog, the answer timeout |
| `web_fetch`, `web_search` | `eharness/web`: `webFetch`, `webSearch` | turndown, DNS lookup, the OpenRouter / AI Gateway search call |
| Todos, MCP, compaction, hooks, usage, cost | `eharness/todos`, `eharness/mcp`, core | settings hooks, output styles, model switching |

Lines of code: see the note at the end of
[the plan](../../docs/plans/P30-coder-example.md#migration-to-the-shipped-modules).

Design and decisions: [`docs/plans/P30-coder-example.md`](../../docs/plans/P30-coder-example.md).

## Run it

```bash
bun install                                   # from the repo root
export OPENROUTER_API_KEY=...                 # OpenRouter (or AI_GATEWAY_API_KEY, see Providers)
bun examples/coder/src/main.tsx               # interactive
bun --filter eharness-coder start             # same thing
```

## Providers, models, thinking

| Provider | Key | Default model |
|---|---|---|
| `openrouter` | `OPENROUTER_API_KEY` (optional `OPENROUTER_BASE_URL`) | `anthropic/claude-sonnet-5.5` |
| `gateway` (Vercel AI Gateway) | `AI_GATEWAY_API_KEY` | `anthropic/claude-sonnet-4.6` |

The provider is `--provider`, else `"provider"` in a settings file, else OpenRouter when
`OPENROUTER_API_KEY` is set, else the gateway. A missing key for the chosen provider is a startup
error with exit code 2 (scripted offline runs with `CODER_SCRIPTED_MODEL` need no key). Keys are
read from the environment only and are never logged.

Model: `--model <id>`, `"model"` in settings, `CODER_MODEL`, then the model last chosen in this
project (see Preferences), then the provider default. `/model <id>` switches inside a session.

- **Model picker** (`/model`, Alt+P): a filterable list; typing an id that is not listed uses it as is.
  `Left`/`Right` change the thinking level of the highlighted model (slider row under the list),
  `Enter` applies model and level and saves them as the project preference, `s` applies them for this
  session only (type `/` first to filter on a word that starts with `s`).
  The OpenRouter list comes from the OpenRouter model catalog, cached in
  `~/.coder/openrouter-models.json` (24 h, refreshed in the background, 3 s fetch limit; with
  `CODER_OFFLINE=1` only the cache is used).
- **Thinking** (`--thinking <level>`, `/thinking [level]`, Alt+T opens the picker). Levels:
  `provider-default` (send nothing), `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. The app
  sets the AI SDK `reasoning` option and, for OpenRouter, also `providerOptions.openrouter.reasoning`,
  because the OpenRouter provider ignores the generic option.
- **Preferences.** The last model, provider and thinking level are saved per project in
  `~/.coder/projects/<hash>/preferences.json` and used at the next start (a flag, a settings file or
  `CODER_MODEL` wins for the model).
- A switch applies to the next step of every agent, subagents included (a `turn.prepare` plugin
  reads shared state), without rebuilding agents.

Context window and prices come from the [models.dev](https://models.dev) catalog. It is fetched once
at startup (at most 3 s of waiting) and cached in `~/.coder/models.json`. A cache older than 24 h is
used as is and refreshed in the background for the next start. Set `CODER_OFFLINE=1` to never fetch.
Without a catalog entry the context window falls back to `contextWindow` (default 200000) and no
cost is shown. `contextWindow` in a settings file always wins over the catalog.

| Flag | Meaning |
|---|---|
| `[prompt]` | first prompt of the interactive session |
| `-p, --print <prompt>` | run one prompt headless, print the answer, exit |
| `--output-format text\|json\|stream-json` | print mode output (default `text`) |
| `--model <id>` | model id for the provider |
| `--provider <name>` | `openrouter` or `gateway` |
| `--thinking <level>` | reasoning effort (see Providers, models, thinking) |
| `--permission-mode <mode>` | `default` (alias `manual`), `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions` |
| `--allow-dangerously-skip-permissions` | put `bypassPermissions` in the `Shift+Tab` cycle without starting in it |
| `--dangerously-skip-permissions` | start in `bypassPermissions` (same as `--permission-mode bypassPermissions`) |
| `--add-dir <path...>` | extra directories, mounted at `/@dirs/<basename>/` |
| `--allowed-tools <rule...>` / `--disallowed-tools <rule...>` | extra allow / deny rules for this run |
| `--agents <json>` | session-only subagent definitions |
| `-c, --continue` | continue the most recent session of this project |
| `-r, --resume [id]` | resume a session; without an id a picker opens |
| `--max-steps <n>` | step limit per turn (default 200) |
| `--cwd <path>` | project root (default: the current directory) |
| `--trust-project` | trust this project's `.coder/` settings, agents and skills (see Project trust) |

Print mode examples:

```bash
bun examples/coder/src/main.tsx -p "List the TODO comments in src/"
bun examples/coder/src/main.tsx -p "Summarise this repo" --output-format json
bun examples/coder/src/main.tsx -p "Explain src/app.ts" --output-format stream-json > chunks.jsonl
```

In print mode `text` streams the answer to stdout and writes one-line tool notes to stderr. `json`
prints one summary object (`stop`, `text`, `usage`, `costUsd`, `sessionId`). `stream-json` prints one
UI message chunk per line. Print mode never asks: anything that would need approval is denied
(unless a rule or mode allows it). The model sees the denial reason.

| Exit code | Meaning |
|---|---|
| 0 | the turn completed (`stop: complete`). A denied write does not change this by itself: the model decides what to do with the denial |
| 1 | any other stop (error, step limit, interrupted, pending approval) |
| 2 | usage or config error: unknown flag, bad value, invalid settings file or `--agents`, unreadable `CODER_SCRIPTED_MODEL` |

Signals: SIGINT and SIGTERM abort the running turn, kill the process group of every running shell
command (SIGTERM, then SIGKILL) and exit (130 and 143). A last-resort `exit` handler also kills
leftover groups.

Single binary (from `examples/coder`):

```bash
bun run compile        # writes dist/coder
```

The compiled binary has not been smoke-tested outside the repository yet.

Offline runs: set `CODER_SCRIPTED_MODEL` to a JSON file holding an array of `scriptedModel` steps
(`eharness/testing`: `{ "text": "...", "toolCalls": [{ "toolName": "read_file", "input": {...} }] }`).
That scripted model replaces the real one for the main agent and every subagent. Set `CODER_HOME` to
move the user directory (default `~/.coder`), for example to a temp folder.

## The interface

A rounded welcome box (version, `cwd` with `~` and a shortened middle, model, provider, thinking) opens
the session. The transcript is plain scrollback: user prompts as `> text`, assistant text with
Markdown, one compact card per tool call (`Ctrl+O` shows the full transcript). A footer under the
prompt always shows the permission mode (`⏸ manual mode on`, `⏵⏵ accept edits on`, `⏸ plan mode on`,
`⏵⏵ auto mode on`, `⏵⏵ don't ask on`, `⏵⏵ bypass permissions on`, each with a dim `(shift+tab to cycle)`), the model and
thinking level, the context left and the cost. `?` on an empty prompt opens the shortcuts panel.
Running background shells and agents are listed as rows below the footer: `Down` from the empty
prompt moves into them, `Left`/`Right`/`Up`/`Down` select, `Enter` opens the task, `x` stops it, `Esc`
returns to the prompt. Lists and pickers take `Down`/`j`/`Ctrl+N`, `Up`/`k`/`Ctrl+P`, `PageUp`/`PageDown`,
`Home`/`End`; `Ctrl+C` twice closes a dialog or page instead of exiting.

| Key | Action |
|---|---|
| Enter | send; while a turn runs, queue the message (see Message queue). Also when the terminal delivers text and Enter as one chunk: `hi\r` sends `hi`; text after the Enter becomes the next draft) |
| Shift+Enter, or `\` then Enter, Ctrl+J | newline (a bracketed paste keeps its newlines as text) |
| Esc | interrupt the running turn (queued messages are then sent), close a page, picker or search |
| Shift+Tab | cycle the mode: manual, accept edits, plan, then bypass permissions (opt-in) and auto |
| Alt+P | model picker |
| Alt+T | thinking picker |
| Ctrl+O | transcript viewer (full tool output, reasoning expanded) |
| Ctrl+B | while a turn runs: move the running foreground `bash` / `agent` calls to the background (`shellTasks.background()`, `subagentTasks.background()`); otherwise cursor left |
| Ctrl+L | redraw the screen |
| Ctrl+C twice | exit (the first press clears the input) |
| `?` | shortcuts panel (empty prompt) |
| Up / Down | prompt history (this project, saved across sessions); `Up` on an empty prompt with queued messages takes them back |
| Ctrl+R | reverse history search across all projects (see Prompt history) |
| Ctrl+A / Ctrl+E | line start / line end |
| Ctrl+B / Ctrl+F | move one character left / right |
| Ctrl+U / Ctrl+K | delete to line start / to line end (into the kill ring) |
| Ctrl+W, Alt+Backspace | delete the previous word (kill ring) |
| Alt+D | delete the next word (kill ring) |
| Ctrl+Y, then Alt+Y | paste the last kill; Alt+Y cycles through older kills |
| Alt+B / Alt+F | move one word left / right (macOS: Option works when it sends Meta, or as the `∫` / `ƒ` characters) |
| Ctrl+_ | undo in the prompt |
| Ctrl+D | delete forward; on an empty prompt press twice to exit |
| Ctrl+G | edit the prompt in `$VISUAL` / `$EDITOR` (see Input editing) |
| Ctrl+S | stash the draft; on an empty prompt restore it |
| Ctrl+V, Alt+V | paste an image from the clipboard as an `[Image #N]` chip |
| Esc Esc (twice within 500 ms) | clear a draft (it stays in prompt history); on an empty prompt open `/rewind` |
| Ctrl+T | show or hide the todo list |
| Tab, Right | accept the dim next-prompt suggestion on an empty prompt |

| Command | Does |
|---|---|
| `/help` | commands and keys (page) |
| `/clear` | start a new session |
| `/compact` | summarise the conversation to free context |
| `/context` | what fills the context window (page) |
| `/status` | version, model, mounts, trust, settings (page) |
| `/cost` | token usage and estimated cost (page) |
| `/model [id]` | model picker, or switch to `id` |
| `/thinking [level]` | thinking picker, or set the level |
| `/permissions` | mode and rules (page); `allow\|ask\|deny <rule> [--project]`, `remove <kind> <rule>`, `mode <mode>` edit them |
| `/agents [n]` | subagents and this session's runs (page); `/agents <n>` (or `/transcript <n>`) opens the agent view of run `n` |
| `/resume [id]` | pick a stored session, or resume one by id |
| `/todos` | show the current todo list |
| `/diff` | review the working-tree changes (page, see below) |
| `/plan [description]` | switch to plan mode; with a description, start planning that task |
| `/<name> [args]` | a custom command or a skill (see Custom commands) |
| `/init` | ask the agent to write the project instructions (`AGENTS.md`, or update an existing `CLAUDE.md`) |
| `/exit` | quit |
| `/compact [instructions]` | as `/compact`; the optional text tells the summary what to keep |
| `/rewind` | restore code and/or conversation to an earlier prompt (also `Esc Esc`) |
| `/branch [name]` | copy the conversation into a new session and switch to it |
| `/rename <name>` | name this session |
| `/export [file]` | write the conversation as text (default `coder-export-<time>.txt` in the project root) |
| `/copy [n]` | copy the latest (or n-th latest) assistant response to the clipboard |
| `/btw <question>` | side question answered from the current context, nothing stored |
| `/recap` | one-line recap of the session |
| `/add-dir <path>` | mount another directory under `/@dirs/` |
| `/memory` | memory files the agent reads (page) |
| `/config` | view and change settings (page) |
| `/tasks` | background shells and agents (page) |
| `/tell <name\|id> <message>` | message a subagent as yourself: a running one gets it at its next step, a finished one is resumed |
| `/doctor` | check the environment (page) |
| `/output-style [name]` | pick the response style, or set it by name |
| `/theme [dark\|light\|auto]` | show or set the colour theme |
| `/sandbox` | toggle the OS sandbox of the bash tool |
| `/vim` | toggle vim keys in the prompt editor |
| `/focus` | toggle the focus view |

**Fullscreen pages.** `/context`, `/status`, `/cost`, `/help`, `/agents`, `/permissions`, `/diff`, `/memory`, `/config`,
`/tasks`, `/doctor` and the transcript viewer open on the terminal's alternate screen, so your scrollback is untouched, and
`Esc` or `q` returns to it. Scroll with the arrow keys (`g` / `G` for top / bottom), `Tab` jumps to the
next section. `/context` draws the window as a grid of 1% cells (system, memory, skills, tools, MCP,
messages, free space, autocompact buffer) and lists tools, memory files, messages and thresholds below.

Prompt features:

- `!command` runs a shell command directly from the prompt, without the model. It is your own
  command: no permission check applies.
- `@path` completes file paths from the project (and mounted directories); Tab completes.
- `--resume` without an id, and `/resume` without an id, open a session picker.
- `/agents <n>` and `/transcript <n>` open the agent view of run `n` of this session's subagent runs
  (numbers are listed by `/agents`).
- `/permissions mode bypassPermissions` needs `--yes` to confirm.

### Message queue

Press Enter while a turn runs and the message is queued instead of refused. Queued entries show
under the transcript in gray with a `⧗` mark.

- A plain message is steered into the running turn: it is delivered after the next tool result, at
  a step boundary, and shows in the transcript where the model saw it as a `> text` line with a dim
  `(sent while the agent was working)`. If the turn ends before that, the queued messages are sent
  together as the next prompt.
- `/command` and `!command` lines are held until the turn ends and then run one at a time.
- `Up` on an empty prompt takes every queued entry back into the editor.
- `Esc` interrupts the turn; whatever is still queued is then sent as the next prompt.
- A steer arriving while the turn waits for a permission answer is kept and delivered after the
  answer (the core would otherwise deny the pending approval).
- An approval note (Tab on Yes) is stored as an input of the turn and shows as a dim `Note: ...`.

### Prompt history

Every submitted prompt is appended to `~/.coder/history.jsonl` (`CODER_HOME` moves it): one JSON
line `{ at, project, text }`, consecutive duplicates of a project dropped, at most 1000 lines. `Up` /
`Down` browse the prompts of this project, also from earlier sessions.

`Ctrl+R` opens a reverse search over the prompts of every project: type to filter (case-insensitive
substring, newest first, duplicates collapsed), `Ctrl+R` or `Up` goes to an older match, `Down` to a
newer one, `Enter` puts the match in the editor, `Esc` or `Ctrl+G` cancels.

### Custom commands and skills

A Markdown file is a slash command; its body is the prompt that is sent.

| Location | Scope |
|---|---|
| `<root>/.coder/commands/**/*.md` | the project (loaded only when the project is trusted) |
| `~/.coder/commands/**/*.md` | you |

The name is the path without `.md`, with `/` written as `:` (`frontend/test.md` is
`/frontend:test`). A project command beats a user command of the same name; a built-in command name
is never overridden (a warning is shown). Optional frontmatter: `description` and `argument-hint`
(shown in `/` completion); `model` is read and ignored.

```markdown
---
description: Review a file
argument-hint: <path> [focus]
---
Review $1 for bugs, paying attention to: $2. Everything typed: $ARGUMENTS
```

`$ARGUMENTS` is the text after the command, `$1`..`$9` are its words (quotes group words). When the
body has no placeholder, typed arguments are appended as `ARGUMENTS: ...`. The typed line stays in
the transcript; the expanded prompt is what the model gets.

Skills of a trusted project (`<root>/.coder/skills/`) are listed in `/` completion as `/skill-name
[request]` and send a prompt asking the model to load that skill.

### Plan mode

`/plan [description]` (or Shift+Tab) switches to plan mode; the description, if given, starts the
turn. When the agent calls `exit_plan_mode` you choose:

1. **Yes, and auto-accept edits** continues in `acceptEdits`.
2. **Yes, and manually approve edits** continues in `default`.
3. **No, keep planning**: your comment is the feedback and the agent keeps planning.

On Yes, Tab adds a note like on any approval.

### `/diff`

A fullscreen page listing the working-tree changes: `git status` + `git diff` against HEAD, untracked
files as additions, and the files the agent edited in this session. Outside a git repository only the
agent's edits are listed. Keys: `↑/↓` select a file, `Enter` or `→` open its patch, `←` back to the
list, `a` toggle agent-only, `r` reload, `PgUp/PgDn` scroll, `Esc` or `q` close. Files over 200 KB and
more than 300 files are cut.

### Reasoning

Model reasoning shows as `✻ Thinking...` while it streams, then `∴ Thought for 12s` with its first
line dim below. `Ctrl+O` opens the transcript viewer, where the whole text is shown. The duration is
read from the part (`providerMetadata.eharness.durationMs`, written by the core), so stored and
replayed messages show it too; the UI measures it only as a fallback for parts without it.

### Web tools

Both tools are the library's (`eharness/web`; the app supplies turndown, DNS resolution and the
provider search). They always ask (risk `external`) and are allowed in plan mode, since they change
nothing locally.

- **`web_fetch { url, prompt? }`** fetches one page and returns Markdown (scripts, styles, nav and
  footers dropped; text and JSON as is; binary types refused). `http` is upgraded to `https`. Private
  and local hosts (loopback, RFC 1918, link-local, `.local`, single-label names, hosts that resolve to a
  private address), URLs with credentials and ports other than 80/443 are refused unless an allow
  rule names the host. Redirects within the same host are followed (at most 5); a redirect to another
  host is returned as `REDIRECT: <url>` so the model fetches it again (and you approve that host).
  Limits: 15 s, 5 MB of body, 30 000 characters of result (a truncation note is added).
- **`web_search { query, allowed_domains?, blocked_domains? }`** runs one provider-side search
  and returns the findings with `Sources:`. OpenRouter: `google/gemini-2.5-flash` with the `web`
  plugin. AI Gateway: `anthropic/claude-haiku-4.5` with the Perplexity search tool.
  `CODER_SEARCH_MODEL` overrides the model. The search call's usage is added to the turn (tokens and
  cost). Without an API key for the provider (and with `CODER_SCRIPTED_MODEL`) the tool answers
  `ERROR: web search failed: web search is not available`.

Rules: `WebFetch(domain:example.com)` (`domain:*.example.com` matches subdomains), `WebFetch` for the
whole tool, `WebSearch`. "Don't ask again" suggests `WebFetch(domain:<host>)` or `WebSearch`.

### Permission prompts and questions

A permission prompt lists numbered options with a `❯` cursor. Keys: `↑/↓` move, `1..N` answer at
once, `Enter` answers the focused option, `Esc` is "No" without a comment.

- **Notes with Tab.** On **Yes** or **No**, `Tab` opens a one-line field. `Enter` sends the answer
  with the text, `Tab` or `Shift+Tab` closes the field and keeps the text for a later answer, `Esc`
  closes the field only. The "don't ask again" options take no note.
- A note on **Yes** is passed as `approvals[].note`: the agent reads it right after the tool result,
  in its first model call of the continuation.
- A comment on **No** is the denial reason, and the agent keeps working. A bare **No** on a prompt of
  the main agent ends the turn without another model call (`endTurn: 'if-denied'`); in a subagent it
  is a plain denial.

The agent can ask you multiple-choice questions with the `ask_user_question` tool (main agent only,
allowed in every mode). One dialog holds 1–4 questions, one tab each (`☐`/`☒` marks answered ones),
plus a **Submit** tab with a review when there are several. Each question is radio `(•)` (pick one)
or checkbox `[✔]` (pick several), always with an **Other** row for your own text, and `n` adds
notes to a question. Keys: `←/→` or `Tab` switch tabs, `↑/↓` move, `Space` selects or toggles,
`Enter` selects and moves on (or submits), `Esc` dismisses (the agent is told you did not answer).
In print mode questions are dismissed.

### Input editing

The prompt is a multiline editor with its own undo stack, kill ring and word motions (keys above).

- **External editor.** `Ctrl+G` writes the prompt to a temp file, runs `$VISUAL`, then `$EDITOR`,
  then `vi` on it in the foreground (arguments such as `code -w` are allowed) and reads the text
  back. `/doctor` warns when neither is set.
- **Stash.** `Ctrl+S` on a non-empty prompt saves it and clears the editor; `Ctrl+S` on an empty
  prompt brings it back. One stash slot, kept for the session.
- **Paste chips.** A bracketed paste of more than 800 characters or 10 lines becomes
  `[Pasted text #N +L lines]`. The chip is one unit for the arrow keys and Backspace/Delete; the full
  text is sent when you submit.
- **Images.** `Ctrl+V` / `Alt+V` reads a PNG from the clipboard (macOS `osascript`, Linux `wl-paste`
  or `xclip`; at most 5 MB) and inserts an `[Image #N]` chip. On submit the images go to the model
  as `file` parts, in chip order. If the model has no vision support the provider decides what
  happens.
- **Mentions.** `@` completes files, folders (a trailing `/`) and agents (`@agent-<name>`); Tab
  completes, up to 8 matches, shortest first.
- **Vim mode.** `"editorMode": "vim"` or `/vim`; the footer shows `-- INSERT --`, `-- NORMAL --`,
  `-- VISUAL --` or `-- VISUAL LINE --`. The prompt starts in INSERT, `Esc` goes to NORMAL (a lone
  `Esc` still interrupts a running turn), `Enter` in NORMAL submits.

  | Group | Keys |
  |---|---|
  | enter INSERT | `i I a A o O` |
  | motions | `h j k l w e b 0 ^ $ gg G`, `f F t T` with `;` `,` |
  | operators | `d c y` with a motion, `dd cc yy`, text objects `iw` `aw` |
  | edits | `x X D C s S r J ~ p P Y u` and `.` (repeat last change) |
  | counts | `3w`, `2dd`, `d2w` |
  | VISUAL | `v`, `V`, then `d x y c` |

### Sessions, rewind and checkpoints

- **Checkpoints.** The library's `filesystem({ checkpoints: nodeCheckpointStore(dir) })` saves a
  file's previous content before the first change of a turn through `edit_file`, `write_file` or
  `delete_file`. The last 50 turns per session are kept under
  `~/.coder/projects/<hash>/checkpoints/`. A subagent's edits are saved under its own child
  session; `/rewind` also walks the child sessions (`session.children()` index) so they are
  restored too.
- **`/rewind`** (or `Esc Esc` on an empty prompt) lists your earlier prompts. Pick one, then
  **Restore code and conversation**, **Restore conversation** or **Restore code**. Code: files the
  agent changed in that turn and later are put back (files that did not exist are deleted).
  Conversation: `session.fork({ beforeMessageId })` creates a new session with the messages before
  that prompt (the old session stays untouched) and the prompt text returns to the editor.
- **What is not checkpointed.** Changes made by the shell (`bash`, `!command`, a background shell),
  by other tools, and by you or other programs outside the agent. A rewind never undoes those.
- `/branch [name]` is `session.fork()` of the whole conversation (checkpoints are copied too) and switches to it. `/rename <name>`
  names the session (shown in the footer). `/export [file]` writes a text
  transcript. `/copy [n]` copies an assistant response with `pbcopy`, `wl-copy`, `xclip`, `xsel` or
  `clip`, else the terminal's OSC 52 clipboard sequence.
- **`/compact [instructions]`**: the text is added to the summariser's context for that one
  compaction.

### Side questions, recap and suggestions

- **`/btw <question>`** answers from the current context in a bordered box under the prompt. It
  uses the stored messages (tool calls reduced to short text lines), calls the model without tools,
  and stores nothing: not in the conversation, not in `/cost`. `Esc` cancels or dismisses it.
- **`/recap`** prints a one-line summary of the session (one cheap model call over the recent
  messages, 15 s limit).
- **Prompt suggestions** (`promptSuggestions: true`): after a turn, one cheap model call proposes the
  next prompt, shown dim in the empty prompt; `Tab` or `Right` accepts it. Off by default because it
  costs a call per turn.

### Background tasks

The `bash` tool takes two extra inputs, and `agent` takes one:

| Input | Effect |
|---|---|
| `bash { run_in_background: true }` | start the command and return a task id (`bash-1`, ...) at once |
| `bash { notify_on: "<regex>" }` | with `run_in_background`: each new output line matching the regex is reported to the agent, at most one notification per 5 s (batched) |
| `agent { run_in_background: true }` | run the subagent in the background (`agent-1` in `/tasks`); its report (cut at 16 000 characters, with a hint to read the rest) arrives later |

Two more tools: **`bash_output { id, filter? }`** returns the output since the last read with status
and exit code (`filter` is a regex over lines); **`kill_shell { id }`** stops a shell task. The library adds **`agent_output { id, offset?, limit? }`** (the full final report of an agent, paged; also for one-shot agents and after a restart) and **`agent_stop { id }`** (stops a running agent; it stays resumable). Background
commands use the same sandbox and permission checks as `bash`. Output is capped at 1 MB per task.
Background mode is the library's (`shell({ background: true })`, `subagents({ background: true })`) on
the **main agent only**: a subagent's own background shells or agents would die with its session.

When a task finishes (or a `notify_on` line matches) the event is delivered to the agent at its next
step. If the agent is idle, the event wakes it: the library starts a `wake` turn (the plugins call
`ctx.session.inject`), `session.onRun` hands it to the controller, and the controller drives it like
a prompt, with approvals and the stream shown as usual (the same path takes queued turns and a steer
that became a turn). A shell you stopped sends nothing; a stopped background agent reports `aborted`.
A finished (or failed, stopped, resumed) agent shows in the chat as `⏺ Message from <name> · <type> ·
<status>` with the first 8 rows of its report rendered as markdown and `… +N lines (ctrl+o to
expand)`; a message an agent sent with `send_message` uses the same block.
All shells and background agents are stopped when coder exits. `/tasks` merges the library's
`shellTasks` and `subagentTasks` services of the session (they live in this process: tasks of a
session reopened after a restart are not listed).

`/tasks` opens a page with every task, its status and tail output: `↑/↓` select, `Enter` shows a
shell's output or opens an agent's view, `x` stops a running task, `Esc` or `q` closes.

**Agent view.** `Enter` on an agent row in the footer (`↓` from the prompt, then `Enter`), on a
run in `/agents`, on an agent in `/tasks`, or `/transcript <n>` opens that agent's full
conversation on the alternate screen: the task prompt, reasoning, tool cards and markdown text
rendered like the main transcript, live while the agent runs (it follows the end; scroll with
`↑/↓`, `PgUp/PgDn`, `Home/End` and it keeps following once you are back at the end). Header:
`◆ writer · general-purpose · running 12s`. The prompt at the bottom messages the agent
(`Enter`): a running agent gets it at its next step, a finished resumable one is resumed in the
background; a one-shot or cancelled agent shows the refusal text. `Esc` closes (and `q` while the
prompt is empty). A tool call of the agent waiting for approval is marked in the view; answer it at
the main prompt, where it is labelled with the agent's name. Runs of earlier processes open with
their stored conversation. The view reads the child session from storage (it is saved after every
step, so the text of the step that is still streaming appears when the step ends).

### Settings reference

Settings files merge in this order, later wins: `~/.coder/settings.json` (user),
`<root>/.coder/settings.json` (project, committed), `<root>/.coder/settings.local.json` (yours,
git-ignored by convention). Every key may appear in any file; an invalid file is an error (exit 2 in
print mode). `/config` edits the keys below in the user file or the local file (`u` / `l` switch the
scope; `Enter` or `Space` toggles or cycles, `Enter` edits text and numbers).

| Key | Default | Meaning | Project trust |
|---|---|---|---|
| `model` | provider default | model id | no |
| `provider` | from API keys | `openrouter` or `gateway` | no |
| `contextWindow` | 200000 without a catalog entry | context window override | no |
| `permissions.allow` / `ask` / `deny` | `[]` | rules (see Permissions); `ask` and `deny` only tighten | `allow` only |
| `permissions.defaultMode` | `default` | mode a new session starts in (`auto` allowed) | yes |
| `autoMode.model` / `autoMode.enabled` | session model / `true` | auto mode classifier model; `false` removes auto mode | yes |
| `permissions.additionalDirectories` | `[]` | extra mounted directories | yes |
| `mcpServers` | `{}` | MCP servers by name | yes |
| `theme` | `dark` | `dark`, `light` or `auto` (`auto` reads `COLORFGBG`); `/config` default scope: user | no |
| `outputStyle` | `default` | response style name | no |
| `notifications` | `bell` | `off`, `bell` or `desktop`; default scope: user | no |
| `askUserQuestionTimeout` | `0` | seconds until an unanswered question is dismissed (0 = never) | no |
| `statusLine` | none | `{ "command": "..." }` footer command | yes |
| `promptSuggestions` | `false` | next-prompt suggestion after each turn | no |
| `editorMode` | `normal` | `normal` or `vim`; default scope: user | no |
| `deferTools` | `true` | defer MCP tools and rarely used built-ins (see Deferred tools) | no |
| `hooks` | `{}` | shell hooks by event | yes |
| `sandbox.enabled` | `false` | OS sandbox for `bash` | turning it off needs trust; turning it on does not |
| `sandbox.network` | `false` | allow network in the sandbox | enabling needs trust |
| `sandbox.allowWrite` | `[]` | extra writable directories | yes |
| `lsp` | auto | language servers by name | yes |

Trust is explained under Project trust. `/config` also shows `model`, `provider` and `thinking`; those
live in the per-project preferences file, not in a settings file. `/status` shows which keys were
ignored for lack of trust.

### Hooks

Shell commands that run on agent events, configured in `hooks` (user, local, or a trusted project
file):

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "bash", "command": ".coder/hooks/check.sh", "timeoutMs": 5000 }],
    "PostToolUse": [{ "matcher": "edit_file|write_file", "command": "bunx biome format --write ." }]
  }
}
```

Each command runs with `/bin/sh -c` in the project root; the event JSON is written to its stdin;
`CODER_PROJECT_DIR` and `CODER_HOOK_EVENT` are set. Default timeout 60 s (`timeoutMs` per entry);
the process group is killed on timeout. All matching commands of an event run in parallel. `matcher`
is a regular expression that must match the whole tool name (omitted, empty or `*` match every tool);
it only applies to the tool events.

| Event | stdin JSON (besides `event`, `cwd`, `session_id`) | Exit code 2 | stdout JSON |
|---|---|---|---|
| `PreToolUse` | `tool_name`, `tool_input` | deny the call; stderr is the reason | `{ "decision": "approve" \| "deny" \| "ask", "reason" }` (the strictest answer among hooks wins) |
| `PostToolUse` | `tool_name`, `tool_input`, `tool_output` | stderr is appended to the output | `{ "additionalContext" }` is appended to the output |
| `UserPromptSubmit` | `prompt` | block the prompt; stderr is the reason | `{ "decision": "block", "reason" }`, or text / `{ "additionalContext" }` added as context |
| `Stop`, `SubagentStop` | `stop_hook_active`, `last_text` | keep working; stderr is the instruction (at most 3 times in a row) | `{ "decision": "block", "reason" }` does the same |
| `SessionStart` | none | ignored | none |
| `Notification` | `message` | ignored | none |

Exit 0 with no output means no opinion. A spawn failure, a timeout or any other exit code shows a
warning and is otherwise ignored: a broken hook never breaks the agent. A `systemMessage` string in
the stdout JSON is shown to you. An invalid `matcher` skips that hook with a warning.

- `PreToolUse` runs as a `tool.approve` hook of the hooks plugin, which is added to every agent
  after the permissions plugin. `approve`, `ask` and `deny` map to the matching approval statuses;
  when several hooks answer, the strictest wins. The decision is computed once per tool call and
  cached, so an approval round does not run the command twice. This deviates from the library rule
  that approval hooks are deterministic and side-effect free; see the plan.
- Hooks are your own code. A project's hooks run only after you trust the project.

### Output styles

`/output-style` (or `outputStyle`) changes how the agent words answers. Built-ins: `default` (no
extra text), `concise`, `explanatory` (adds short "Insight:" notes) and `learning` (leaves
`TODO(human)` parts for you). Custom styles are Markdown files with optional `name` and
`description` frontmatter; the body is the instruction:

| Location | Scope |
|---|---|
| `<root>/.coder/output-styles/*.md` | the project (only when trusted) |
| `~/.coder/output-styles/*.md` | you |

A project style beats a user style beats a built-in of the same name. The style is a session
instruction placed after the static instructions, so switching it rebuilds the prompt cache from
that point on (tools and the static prefix stay cached). Switch rarely.

### Themes, status line, notifications

- **Themes.** `/theme dark|light|auto` (or `theme`); `auto` reads `COLORFGBG`. `NO_COLOR` removes
  every colour.
- **Status line.** `statusLine.command` runs with this JSON on stdin and the first non-empty line
  of stdout (ANSI colours allowed) replaces the footer's right side. 2 s timeout, result cached for
  1 s, any failure shows nothing.

  ```json
  { "session_id": "...", "cwd": "/path", "mode": "default",
    "model": { "id": "anthropic/claude-sonnet-5.5" },
    "cost": { "total_cost_usd": 0.12 },
    "context": { "used_tokens": 12000, "window": 200000, "used_percentage": 6 } }
  ```
- **Notifications and title.** The terminal title is set to `coder · <task text>` (OSC 0). When a turn ends or the
  agent needs input (approval, question), `notifications` rings the bell (`bell`, default), sends a
  desktop notification (`desktop`: OSC 9 and OSC 777, plus `osascript` in Apple Terminal) or does
  nothing (`off`). Hooks on `Notification` fire at the same moments.
- **Focus view.** `/focus` shows only your prompts and the final answers (one-line tool summaries
  are hidden); toggle again to leave. `Ctrl+T` toggles the todo list.

### Deferred tools

Like Claude Code, coder keeps tool definitions out of the request until they are needed
(`deferTools: true`, the default). Deferred tools are listed **by name** (with a one-line
description) in the turn reminder under `Deferred tools`; the model loads the schema with
`tool_search` (for example `select:web_fetch`, or keywords) and calls the tool in its next step. The
card reads `Loaded tools · web_fetch`. Deferred: every MCP tool, `web_fetch`, `web_search`, `lsp`,
`agent_output`, `agent_stop`, `bash_output`, `kill_shell` and `request_directory_access`. Always
loaded: the file tools, `bash`, `agent`, `send_message`, `todo_write`, `ask_user_question`,
`exit_plan_mode` and the skill tools. `tool_search` needs no approval; the deferred tool itself asks
as usual. `/context` marks deferred tools and shows the tokens they do not cost. Set
`"deferTools": false` to send everything on every request. One MCP server can override the setting
with `"defer": true | false` in its entry of `mcpServers`.

This is the library's `deferTools` agent option (spec 02 §3.3) plus `mcpServer({ defer })`.

### LSP

The `lsp` tool gives the agent code intelligence from language servers. It is read-only (risk
`read`) and starts a server lazily, on the first file of its type.

```json
{ "lsp": { "python": { "command": ["pyright-langserver", "--stdio"], "extensions": [".py"] } } }
```

Without an `lsp` setting, coder starts `typescript-language-server --stdio` for `.ts .tsx .js .jsx
.mts .cts .mjs .cjs` when the binary is found in `node_modules/.bin` or on `PATH`; otherwise the
tool has no server. A request times out after 10 s; `diagnostics` waits up to 3 s for the server.
Paths are virtual (`/src/a.ts`), line and character are 1-based.

| Operation | Inputs | Returns |
|---|---|---|
| `definition`, `references`, `hover` | `path`, `line`, `character` | locations (up to 100) or hover text |
| `diagnostics` | `path` | errors and warnings of the file (up to 100) |
| `symbols` | `path` | outline of the file (up to 200) |
| `workspace_symbols` | `query`, optional `path` to pick the language | matching symbols (up to 200) |

### OS sandbox

`sandbox.enabled: true` (or `/sandbox`, or `/config`) runs every `bash` command (also background and
`!command` shells) inside an OS sandbox:

- **macOS:** `sandbox-exec` (Seatbelt) with a generated profile. Apple deprecated the tool, but it
  still ships with macOS.
- **Linux:** bubblewrap (`bwrap`) with the root mounted read-only.

What it restricts: **writes** (only the project root, `sandbox.allowWrite` directories and temp
directories are writable) and the **network** (off unless `sandbox.network` is true; local unix
sockets stay usable on macOS for git, ssh-agent and DNS).

What it does not restrict: **reads**. Everything on disk, secrets in your home directory included,
stays readable by a sandboxed command. It does not limit CPU or memory either, and it does not cover
the file tools (those use the virtual path tree) or MCP servers and hooks. When the platform tool is
missing, coder says so and commands run unsandboxed; `/doctor` and `/status` show the state. The
permission engine still asks as described in the Safety model; the sandbox is a second layer. A
write blocked by the sandbox is reported to the model with a hint (the library's `SANDBOX_HINT`);
whether the sandbox is on is part of the `bash` tool description (library); a live toggle reopens
the session handle so the description is resolved again.

### Doctor, memory

- **`/doctor`** checks: runtime, provider key, model in the catalog, `git`, `rg`, `$VISUAL` /
  `$EDITOR`, clipboard command, OS sandbox tool, settings files (valid JSON and schema), project
  trust, MCP servers, LSP servers and that the data directory is writable. Each is `ok`, `warn` or
  `error` with a detail.
- **`/memory`** lists the memory files the agent reads, in load order: user memory
  `~/.coder/CLAUDE.md` (or `AGENTS.md`), then the project `CLAUDE.md` (or `AGENTS.md`), then nested
  ones. When a directory has both, `CLAUDE.md` is loaded and the other is marked `ignored`.
  Missing ones are listed too; `Enter` shows the edit command for `$EDITOR`.
  User memory is added to the static instructions ahead of the project file (capped at 40 000
  characters) and applies to every project.

## Safety model

Read this before pointing the agent at anything you care about.

**The file tools use a virtual path tree.** The model never sees real paths.

| Virtual path | Real location |
|---|---|
| `/` | the project root (`--cwd`) |
| `/@dirs/<name>/` | an extra directory from `--add-dir`, settings, or an approved `request_directory_access` |
| `/.eharness/tool-outputs/` | large tool outputs evicted from the context (in `~/.coder/projects/<hash>/tool-outputs`); readable and writable by the file tools, not a working directory for shell reads |

- **Containment.** Every virtual path is joined to a real root, resolved with `realpath` and rejected
  if the result is outside that root. Symlinks that leave the root are refused by the file tools
  and are not listed by `glob`. A symlink swapped in between a read and a write is caught.
- **Ignore rules.** `.git/`, `node_modules/` and the root `.gitignore` hide paths from listings,
  `glob` and `grep`. They only hide; an explicit read of an ignored path still works.
- **Protected paths.** Writes to `.git`, `.coder/settings*.json` and `.coder/agents` always ask, in
  every mode, `bypassPermissions` included. This holds for the file tools and for shell commands
  (see below). Reads of `.env*` ask too (an allow rule for the path overrides this).
- **New directories.** The model calls `request_directory_access` with a path and a reason. It always
  asks. On approval the directory is mounted under `/@dirs/`. The tool refuses `/`, your home
  directory and any directory that contains the project, and it reports the real path when a
  symlink was followed.
- **Read rules filter listings.** `grep`, `list_files` and `glob` are approved on a directory, but
  their output drops every path that a `Read` deny or ask rule (the built-in `.env*` included)
  matches, and ends with `(N results hidden by permission rules)`.
- **`glob` containment.** The library `glob` lists through the guarded disk `FileSystem`, so symlinks
  that leave the mount and ignored paths never show up; patterns cannot name a path outside `path`.

**The shell is not sandboxed by default.** The `bash` tool runs `/bin/bash -c` with your user's
privileges. The name of the local sandbox module is historical. Protection comes from the permission
engine; the opt-in OS sandbox (see OS sandbox) adds write and network limits, not read limits:

- A command is auto-approved only if every part is a read-only command with a **per-command
  argument allow-list** (flags and positional arguments are checked, not just the program name) and
  every path it reads lies inside the project or a mounted directory. Examples of what the grammar
  refuses: `sort -o FILE`, `find -exec`/`-delete`/`-fprint`, `rg --pre`, `grep -f`, `tail -f`,
  `uniq in out` (only one file is accepted), `git diff --output`, `git -c`. `tree` is not on the
  list. `node` and `bun` are read-only only for `--version`.
- Anything else asks: writes, installs, network tools, unknown commands, complex commands
  (substitutions, subshells, heredocs), redirects to files.
- Any `$` expansion, `~user`, brace expansion or `xargs` stdin cannot be resolved, so the command
  asks.
- Recursive searches (`rg`, `grep -r`) and globs (`cat .e*`) ask when a `Read` ask or deny rule
  (the built-in `.env*` included) could match a file under the target. `rg <path>` is always
  treated as recursive.
- A non-read-only command whose text mentions `.git` or `.coder` asks in every mode, including
  `bypassPermissions`. The detection is textual (see Known limits).
- An allow rule never approves a command that redirects (or `tee`s) outside the working
  directories; it asks instead.

**Project trust.** `<root>/.coder/settings.json`, `<root>/.coder/agents/` and `<root>/.coder/skills/`
come with the repository, so a cloned repo could widen permissions or start MCP servers. Until you
trust the project, these keys of the project settings file are ignored: `permissions.allow`,
`permissions.defaultMode`, `permissions.additionalDirectories` and `mcpServers`. The project's
agents and skills are not loaded either. `model`, `contextWindow` and `permissions.ask`/`deny`
still apply (they only tighten). `settings.local.json` and the user settings are yours and always
apply.

- Interactive, on a TTY: coder asks `Trust this project? [y/N]` and names what it would enable.
- Print mode never asks: it warns on stderr and ignores the content. Pass `--trust-project` (CI).
- Trust is stored in `~/.coder/trusted.json` as a hash of the project settings file plus every
  project agent and skill file, keyed by the real project root. Any change to that content makes
  the project untrusted again.

Known limits:

- Shell path checks are lexical. A symlink inside the project that points outside is not detected
  by the shell check (the file tools do detect it).
- A repository's own git config (`diff.external`, textconv drivers, a pager) can run programs for
  auto-approved `git diff`, `git log` and `git show`.
- Protected-path detection for shell commands is textual: it looks for `.git` or `.coder` as a word
  in the command. A command that builds the path at run time (a variable, an encoded string, a
  script that does it) is not recognised. Commands with `$` expansions ask anyway, but a script you
  approved can touch anything.
- Pattern arguments (a `grep` regex, for example) can be treated as paths. This errs toward asking.
- Approving a command runs it as written. Read the prompt.
- In `bypassPermissions` the shell containment and ask checks are skipped (deny rules and protected
  paths still apply).
- Trust is per exact content, and the trust file is last-writer-wins when two coder processes
  trust different projects at the same moment.
- The permission mode is not persisted: a restart (or `--continue`) starts in the configured
  `defaultMode` again, not in the mode the session ended in.
- Subagent runs after a `/resume` are listed from the stored `data-subagent.run` parts; a run that was
  still running when the conversation was saved is shown as failed.
- The OS sandbox does not restrict reads, CPU or memory, and needs `sandbox-exec` (macOS, deprecated
  by Apple) or `bwrap` (Linux); Windows has none. Without the tool commands run unsandboxed.
- Rewind restores only files changed through the file tools. Shell changes, other tools and outside
  edits are not checkpointed. Only the last 50 turns per session have checkpoints.
- Hooks are arbitrary commands: a `PreToolUse` hook runs once per tool call and its answer is
  cached, which deviates from the library's deterministic-approval rule.
- Background shells live in the process: they stop when coder exits and are not restored on resume
  (background agents are listed from the stored state, but their processes died with coder).
- Image paste reads PNGs only (macOS `osascript`, Linux `wl-paste` / `xclip`); there is no Windows
  image paste.
- Vim mode covers the common subset listed above, not macros, registers by name or ex commands.
- Output style changes rebuild part of the prompt cache.

## Permissions

| Mode | Behaviour |
|---|---|
| `default` | reads and read-only commands inside the working dirs are allowed; edits and other commands ask |
| `acceptEdits` | file edits in writable dirs and simple `mkdir` / `touch` / `mv` / `cp` inside them are allowed |
| `plan` | read-only: edit tools are removed, only read-only commands run; `exit_plan_mode` asks you to approve the plan, then the previous mode is restored |
| `dontAsk` | anything that would ask is denied |
| `auto` | edits and read-only commands run; every other action is judged by a classifier model (below) |
| `bypassPermissions` | everything is allowed except deny rules and protected paths |

The mode lives in the permission engine, in memory. `Shift+Tab`, `/permissions mode` and approved
plans change it; it takes effect at the next step.

**`Shift+Tab` cycle.** `manual` (the footer's name for `default`), `accept edits`, `plan`, then
`bypass permissions` only when you opted in (`--allow-dangerously-skip-permissions`,
`--dangerously-skip-permissions`, or starting in it by flag or `permissions.defaultMode`), then `auto`
last. From a mode outside the cycle (`dontAsk`, or `auto` with auto mode disabled) the next press goes
to `manual`. `dontAsk` is never in the cycle.

**Auto mode** (library `eharness/permissions`, spec 18 §12) lets a classifier model approve or block
what no rule settles, instead of asking you. Deny and ask rules still win, narrow allow rules run
without the classifier (broad ones like `Bash(*)` are ignored in this mode), reads, edits inside the
working directories and read-only commands run, protected paths and `request_directory_access` still
ask you, and the rest (other shell commands, web fetch and search, MCP tools) goes to the classifier.
A block is a normal denied tool result the model reads, shown as a short notice under the prompt.
After 3 blocks in a row or 20 in total auto mode **pauses**: the footer says
`⏵⏵ auto mode paused · approve to resume` and actions ask you again until you approve one. The
classifier uses the session's current model through the provider you already use (so it costs tokens
on every classified action); override it with `"autoMode": { "model": "<id>" }` in settings or
`CODER_AUTO_MODEL`, or remove auto mode from the cycle with `"autoMode": { "enabled": false }`.
The session still **starts in `manual` mode** unless you ask for auto (`--permission-mode auto` or
`permissions.defaultMode: "auto"`): auto sends command text to a model, so it is opt-in. The footer
color of auto is blue (manual gray, accept edits purple, plan teal, don't ask yellow, bypass red).
The classifier is a heuristic layer, not a boundary; use deny rules for hard guarantees.

**Rules** are strings in `permissions.allow`, `permissions.ask` and `permissions.deny`:

| Rule | Matches |
|---|---|
| `Bash(bun test *)` | commands starting with `bun test` (a trailing ` *` also matches the bare command; `:*` is the same) |
| `Bash(git status)` | that exact command |
| `Read(.env*)`, `Read(./secrets/**)` | read tools on matching paths (gitignore patterns); also read-only shell commands that read a matching path, directory or glob |
| `Edit(src/**)` | edit tools on matching paths; also redirect targets of shell commands |
| `Agent(explore)` | the `agent` tool with that `subagent_type` |
| `WebFetch(domain:example.com)` | `web_fetch` for that host (`domain:*.example.com`: its subdomains); also lets it reach private hosts |
| `WebFetch`, `WebSearch` | the whole tool |
| `Edit`, `Bash`, `mcp__server__tool` | the whole tool |

Path specifiers: `//abs/path` is absolute, `~/x` is under the home directory, `/x` and `./x` are
relative to the project root, a bare `x` follows gitignore (no slash: matches at any depth). A bare
pattern also applies inside every mounted directory, not only the project root.

Aliases: `Read` = `read_file`, `list_files`, `grep`, `glob`. `Edit` and `Write` = `edit_file`,
`write_file`, `delete_file`. `Bash` = `bash`. `Agent` = `agent`. `WebFetch` = `web_fetch`. `WebSearch` = `web_search`. Real tool names work too. A rule
without a specifier on a tool (`Edit`) in `deny` also removes that tool from the model's tool list.

Bash allow rules must match every subcommand of a `&&`, `;`, `|` chain and never match a complex
command. Deny and ask rules match if any subcommand matches, and also apply to redirect targets
(`Edit` rules) and read paths (`Read` rules).

**Evaluation order:** deny rules; always-ask tools (`request_directory_access`, `exit_plan_mode`);
the plan-mode gate; protected paths (also in `bypassPermissions`); directories and globs that a
deny rule could cover; ask rules; allow rules (but not for a command that writes outside the working
dirs); built-in `.env*` ask rules; then the mode default. Ask rules and the built-in asks are
skipped in `bypassPermissions`. A global `dontAsk` turns every ask into a denial.

**"Don't ask again."** An approval prompt can remember a suggested rule for this session, or for the
project. "Project" writes it to `.coder/settings.local.json`. The suggestion is deliberately narrow:

- edits: the whole `Edit` tool;
- an ordinary command: `Bash(prog sub *)`, for example `Bash(git log *)`;
- interpreters, shells and wrappers (`bash -c`, `python3 -c`, `node`, `env`, `sudo`, `xargs`,
  `find`, `awk`, `sed`, `npx`, ...), commands whose second word is a flag, `git -c`/`-C`/`config`:
  the exact command only;
- no suggestion for compound or complex commands, commands containing `*`, protected paths,
  `exit_plan_mode` and `request_directory_access`. `bun` is an interpreter for the library engine:
  `bun test src/a.test.ts` offers the exact command, not a `bun test *` prefix.

**Settings files**, merged in this order (later wins for scalars, rules and directories are
concatenated): `~/.coder/settings.json`, `<root>/.coder/settings.json` (subject to project trust),
`<root>/.coder/settings.local.json`. Then CLI flags (`--model`, `--permission-mode`,
`--allowed-tools`, `--disallowed-tools`, `--add-dir`).

```json
{
  "provider": "openrouter",
  "model": "anthropic/claude-sonnet-5.5",
  "contextWindow": 200000,
  "permissions": {
    "defaultMode": "default",
    "allow": ["Bash(bun test *)", "Bash(bun run lint)", "Edit(src/**)"],
    "ask": ["Bash(git push *)"],
    "deny": ["Read(./secrets/**)", "Bash(rm -rf *)"],
    "additionalDirectories": ["../shared-lib"]
  },
  "mcpServers": {}
}
```

`/permissions allow|ask|deny <rule> [--project]` and `/permissions remove <kind> <rule>` edit the
rules at run time. `--project` writes to `settings.local.json`; `remove` also removes the rule from
that file.

**Audit log.** Every approval decision is appended as a JSON line to
`~/.coder/projects/<sha256(root)[0:16]>/audit.jsonl`.

## Subagents

The main agent can start subagents with the `agent` tool. Each runs as a child session with a fresh
context and returns only its final report. Progress (steps, last tool, text) streams into the UI as
preliminary tool results and shows in a tree.

| Built-in | Tools | Use |
|---|---|---|
| `general-purpose` | all | multi-step tasks that explore and change code |
| `explore` | read tools and read-only `bash` | fast codebase search and analysis |
| `plan` | read tools and read-only `bash` | returns a step-by-step plan and the critical files |

`explore` and `plan` always run in plan mode: no write tools, and their `bash` is limited to read-only
commands whatever mode the session is in (also `bypassPermissions`).

Define your own as a Markdown file in `<root>/.coder/agents/*.md` or `~/.coder/agents/*.md`, or pass
`--agents '{"name": {...}}'` for one session. On a name collision the first wins: `--agents`,
project, user, built-in.

```markdown
---
name: reviewer
description: Reviews a diff for bugs. Use after larger changes.
tools: Read, Grep, Glob, Bash
disallowedTools: Edit
model: inherit
permissionMode: plan
maxTurns: 20
omitProjectMemory: false
---
You review code. Report concrete bugs with `path:line`. Do not edit anything.
```

Fields: `name` (lowercase, digits, hyphens) and `description` are required, the body is the prompt.
Optional: `tools`, `disallowedTools` (comma list or array; aliases `Read`, `Grep`, `Glob`, `Edit`,
`Write`, `Bash`, `Agent`, `Task`, `TodoWrite` or real names), `model` (`inherit` or a model id),
`permissionMode`, `maxTurns` (default 50), `omitProjectMemory`. In `--agents` JSON the same fields
are used with `prompt` instead of a body. Invalid files are skipped with a warning.

Notes:

- `permissionMode` can only make an agent stricter: `plan` removes its non-read-only tools and runs
  its `bash` read-only whatever the session mode is. Other values are ignored, because the engine
  has one global mode.
- Project agents (`<root>/.coder/agents/`) are loaded only after you trust the project.
- Subagents never get `exit_plan_mode` or `request_directory_access`.
- Parallel runs: several `agent` calls in one step run concurrently, at most 8 at once per nesting
  depth (the cap is per depth so waiting parents cannot starve their children).
- Depth limit: 2 levels of nesting below the main agent; at the limit a child has no `agent` tool.
- Approvals: a subagent's tool calls go through the same permission engine. A question from a child
  is shown to you in the same prompt UI, labelled with the agent name, and the child waits in
  process (`subagents({ approvals: 'inline', answer })`). This does not survive a restart; the
  library's `'park'` strategy is for split web/server apps (ADR-0035).
- Messaging: the main agent (and subagents) have `send_message`; start an agent with a `name`
  (`agent { name: "reviewer", … }`) and address it later by name, task id (`agent-2`) or `main`.
  A running agent gets the message at its next step (shown as a dim `← reviewer: …` line in the
  transcript; the call reads `SendMessage → reviewer`); a finished agent is resumed on its own
  session with its full history, shows as running again in the footer and `/tasks`, and its report
  goes back to the sender. `explore` and `plan` are one-shot (`resumable: false`): they take
  messages while running, but finished ones are not resumed. `/tell <name|id> <message>` sends as
  you (plain user input, not an agent message); typing into the `/agents` transcript viewer is not
  supported. Agent messages are framed `<agent-message>` and are never an approval (ADR-0038).
- Transcripts: `/agents <n>` opens a child's stored messages. Runs are listed from the persisted
  `data-subagent.run` parts, so they are also available after a resume.

## Project memory, skills, MCP, sessions

- **User memory.** `~/.coder/CLAUDE.md`, else `~/.coder/AGENTS.md` (if present) is added to the instructions before the
  project file, for every project (see `/memory`).
- **Project memory.** Loaded by the library's `projectInstructions()` plugin
  (`eharness/filesystem`): per directory the first of `CLAUDE.md`, `AGENTS.md` wins (both present
  means `CLAUDE.md` only). The root file is added to the static instructions once per session;
  files in subfolders are listed as virtual paths so the model can read them when working there.
  `/init` asks the agent to write an `AGENTS.md` (or update an existing `CLAUDE.md`).
- **Skills.** If `<root>/.coder/skills/` exists and the project is trusted, it is loaded as a skill
  folder (`SKILL.md` per skill) through the filesystem plugin.
- **MCP.** `mcpServers` in a settings file maps a server name to an `mcpServer()` transport config.
  A project's `mcpServers` need project trust. Servers are attached to the main agent only; a
  server that fails to configure is skipped with a warning. Requires the optional peer
  `@ai-sdk/mcp`. MCP tools ask in every mode except `bypassPermissions`, unless an allow rule names
  them (`mcp__server__tool`). This path has no automated test yet.
- **Sessions.** JSON files in `~/.coder/projects/<sha256(root)[0:16]>/sessions/`, written with the
  example JSON-file adapters. `-c` picks the newest, `-r` / `/resume` a given one. The project data
  directory also holds `tool-outputs/`, `checkpoints/` and `audit.jsonl`. User data (`~/.coder`, or `CODER_HOME`):
  `settings.json`, `AGENTS.md`, `agents/`, `commands/`, `output-styles/`, `history.jsonl`, `trusted.json`, `models.json`, `openrouter-models.json`, `projects/`
  (each project folder also has `preferences.json`). Project trust also covers `.coder/commands/` and
  `.coder/output-styles/`.

## How it is built

| Folder (`src/`) | Role and eharness features it exercises |
|---|---|
| `main.tsx`, `print.ts` | CLI (commander) and headless output; `HarnessRun` streams, `TurnResult.usage` |
| `app/` | config (settings, trust), controller, agents, prompt, storage, models.dev catalog. `defineHarnessAgent`, `session.send` / `respond` / `fork` / `onRun`, `compaction`, `toolOutput` eviction, turn reminders (mode, extra dirs), cost and context window from the catalog, JSON-file adapters. `agent.ts` composes the shipped plugins per agent; `checkpoints.ts` (rewind policy), `tasks.ts` (task list), `web-search.ts` (provider search) |
| `workspace/` | `nodeWorkspace()` and the `request_directory_access` tool |
| `permissions/` | the library engine configured for the app (`engine.ts`: tool kinds, protected paths, rule scopes, always-ask directory access), the approval broker, `describeApproval`, the audit log |
| `agents/` | `drive.ts` answers `tool-pending` stops of the main agent (approvals, questions); `subagents.ts` is the `answer` callback of the `agent` tool; definitions from files (`load.ts`, `builtin.ts`) |
| `ui/` | Ink components: welcome box, transcript, tool cards, diffs, todo panel (`data-todos.list`), subagent tree, permission prompt, footer; `pages/` (alternate-screen pages) and `pickers/` (model, thinking) |

Tool order is stable (prompt-cache prefix), identical for every turn of an agent: the app tools
(`lsp`, `request_directory_access`), `bash` (+ `bash_output`, `kill_shell`), `agent`, the filesystem
tools (`glob` included), `todo_write`, `web_fetch`, `web_search`, `ask_user_question`, MCP tools (deferred tools keep their place; `tool_search` is last),
`exit_plan_mode` last.

Layering: `workspace/`, `permissions/`, `agents/` and `app/` never import Ink or React.
`ui/` and `print.ts` use a `CoderController` (`src/contracts.ts`).

## Library gaps found

Everything that was a gap in the example is now a shipped module or a library feature
([P31](../../docs/plans/P31-library-from-coder.md)); no workaround for a library gap is left. The
last ones were closed in `ecc9b59`: `alwaysAsk` tool kinds, `persist(rules, change)` with scopes,
`session.onRun`, the `session.fork` hook and `sessionIds` for checkpoints, `subagentTasks`, and the
sandbox state in the `bash` description. One small piece stays app-side: `session.children()` lists direct
children only, so `app/checkpoints.ts` reads nested subagent sessions from the stored state before
passing `sessionIds`.
