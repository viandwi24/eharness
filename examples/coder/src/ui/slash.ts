/** Slash commands of the interactive UI: registry, parsing and the commands themselves. */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { errorText } from 'eharness'
import type { Todo } from 'eharness/todos'
import type {
  CoderController,
  CoderMessage,
  CompactSummary,
  CustomCommand,
  PermissionRules,
} from '../contracts.ts'
import {
  PERMISSION_MODES,
  type PermissionMode,
  THINKING_LEVELS,
  type ThinkingLevel,
} from '../contracts.ts'
import type { PageSpec } from './pages/spec.ts'
import { formatTokens } from './Spinner.tsx'
import type { SubagentRun } from './state.ts'

/** What a command may do to the UI. */
export interface SlashContext {
  controller: CoderController
  /** Text after the command name, trimmed. */
  args: string
  /** Current model id (changes with `/model`). */
  model: string
  /** Show an animated status line (`✻ Compacting conversation… (3s)`) until called with null. */
  activity?(status: string | null): void
  /** Print dim system lines into the transcript. */
  print(text: string, tone?: 'info' | 'error'): void
  /** Clear the transcript view. */
  reset(): void
  /** Replace the transcript with these stored messages. */
  load(messages: CoderMessage[]): void
  /** Subagent runs seen in this session, oldest first. */
  subagents(): SubagentRun[]
  /** Open a fullscreen page (`/context`, `/status`, `/cost`, `/help`, `/agents`, `/permissions`). */
  openPage(page: PageSpec): void
  /** Open the session picker. */
  pickSession(): void
  /** Open the model picker. */
  pickModel(): void
  /** Open the thinking-level picker. */
  pickThinking(): void
  /** Start a turn with this prompt. */
  submit(prompt: string): void
  /** Run the last reply again (`/retry`). */
  retry(): void
  /** The latest todo list, if any. */
  todos(): Todo[] | null
  setModelLabel(model: string): void
  /** Open the rewind menu. */
  openRewind(): void
  /** Ask a side question in an inline box. */
  sideQuestion(question: string): void
  /** Open the output-style picker. */
  pickOutputStyle(): void
  /** Apply a theme now. */
  applyTheme(name: 'dark' | 'light' | 'auto'): void
  /** Apply the prompt editor mode now. */
  applyEditorMode(mode: 'normal' | 'vim'): void
  /** Toggle the focus view. */
  toggleFocus(): void
  /** Copy to the system clipboard; resolves with how it was copied. */
  copy(text: string): Promise<string>
  /** The session name or the footer changed. */
  refreshTitle(): void
  /** Re-read the status bar numbers. */
  refreshStats(): void
  exit(): void
}

/** One slash command. */
export interface SlashCommand {
  name: string
  /** Argument hint, e.g. `<id>`. */
  usage?: string
  description: string
  run(ctx: SlashContext): Promise<void> | void
}

/** Fixed prompt of `/init`. */
export const INIT_PROMPT =
  'Analyse this project: its layout, languages, build, test and lint commands, conventions and anything a new contributor should know. Then write an AGENTS.md at the project root that captures it concisely (commands first). If a CLAUDE.md already exists at the project root, update that file instead (it takes precedence over AGENTS.md); if an AGENTS.md already exists, improve it instead of replacing it.'

/**
 * Prompt of `/commit`. Everything runs through the normal tools: every git command is a `bash`
 * call that the permission engine decides on, and the confirmation is an `ask_user_question`.
 * Nothing is staged implicitly and nothing is pushed.
 */
export function commitPrompt(hint: string): string {
  return [
    'Commit the changes that are already staged, step by step. Follow these rules exactly:',
    '1. Run `git diff --cached --stat` and `git diff --cached` (and `git log -5 --format=%s` for the style of this repository). If nothing is staged, say so, list what is unstaged with `git status --short`, tell the user to stage what they want (for example `git add <files>`), and STOP. Never run `git add`, `git commit -a`, `git stash`, `git reset`, `git push` or `--amend` yourself.',
    '2. Draft one Conventional Commit message from the staged diff: `type(scope): summary` (feat, fix, docs, refactor, test, chore, build, ci, perf; imperative, under 72 characters), then an optional short body explaining why. Do not mention that an AI wrote it and add no co-author or attribution lines unless the repository history does.',
    '3. Call `ask_user_question` once: show the diff summary (the files and line counts) and the full proposed message in the question text, with the options "Commit" and "Cancel". An "Other" answer is the user\'s edited message: use it as is.',
    '4. Only on "Commit" or an edited message, run `git commit` with that message (`-m` for the subject and a second `-m` for the body). Pass the message safely (single quotes or a heredoc). Report the new commit hash and subject. On "Cancel", stop and change nothing.',
    hint ? `The user adds: ${hint}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/**
 * Prompt of `/pr`: draft title and body from the branch diff and open the pull request with
 * `gh pr create`, after the user confirmed. `gh` and `git` run as permission-gated `bash` calls.
 */
export function prPrompt(hint: string): string {
  return [
    'Open a pull request for the current branch, step by step. Follow these rules exactly:',
    '1. Check the tools: run `gh --version`. If `gh` is not installed, say so and tell the user to install the GitHub CLI (https://cli.github.com) and run `gh auth login`, then STOP. Also run `git status --short` and `git branch --show-current`; if the branch is `main`/`master` or detached, STOP and ask the user to switch to a feature branch.',
    '2. Find the base branch (`gh repo view --json defaultBranchRef -q .defaultBranchRef.name`, else `main`). Read the branch changes with `git log <base>..HEAD --format=%s%n%b`, `git diff <base>...HEAD --stat` and `git diff <base>...HEAD`. If there is nothing ahead of the base, say so and STOP. Tell the user if there are uncommitted changes (they will not be in the pull request); never commit for them.',
    '3. Draft a title (Conventional Commit style, under 70 characters) and a Markdown body: a short summary, the notable changes as bullets, and a test plan. Base it on the diff, not on guesses.',
    '4. Call `ask_user_question` once: show the base and head branches, the diff summary, the title and the body, and whether the branch is pushed (`git rev-parse --abbrev-ref @{u}`; if it has no upstream, say that `git push -u origin HEAD` will run first). Options: "Create pull request", "Create as draft", "Cancel".',
    '5. Only on a create option: push the branch if needed (`git push -u origin HEAD`), then run `gh pr create --base <base> --title <title> --body <body>` (add `--draft` for a draft; pass the text safely with single quotes or `--body-file -` and a heredoc). Print the pull request URL. On "Cancel", stop and change nothing.',
    hint ? `The user adds: ${hint}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

const RULE_KINDS: readonly (keyof PermissionRules)[] = ['allow', 'ask', 'deny']

function isRuleKind(value: string | undefined): value is keyof PermissionRules {
  return RULE_KINDS.includes(value as keyof PermissionRules)
}

const PERMISSIONS_USAGE =
  'Usage: /permissions [allow|ask|deny <rule> [--project] | remove allow|ask|deny <rule> | mode <mode> [--yes]]'

/** Split `<word> <rest>`; the rest keeps its inner spaces (rules like `Bash(bun test *)`). */
function splitWord(text: string): [string, string] {
  const match = /^(\S+)\s*([\s\S]*)$/.exec(text.trim())
  return match ? [match[1] as string, (match[2] as string).trim()] : ['', '']
}

async function runPermissions(ctx: SlashContext): Promise<void> {
  const engine = ctx.controller.permissions
  if (!ctx.args) return ctx.openPage({ kind: 'permissions' })
  const [sub, rest] = splitWord(ctx.args)
  try {
    if (isRuleKind(sub)) {
      const project = /(^|\s)--project$/.test(rest)
      const rule = rest.replace(/\s*--project$/, '').trim()
      if (!rule) return ctx.print(PERMISSIONS_USAGE, 'error')
      await engine.addRule(sub, rule, project ? 'project' : 'session')
      ctx.print(`Added ${sub} rule ${rule} (${project ? 'project' : 'this session'}).`)
    } else if (sub === 'remove') {
      const [kind, rule] = splitWord(rest)
      if (!isRuleKind(kind) || !rule) return ctx.print(PERMISSIONS_USAGE, 'error')
      const removed = await engine.removeRule(kind, rule)
      ctx.print(
        removed ? `Removed ${kind} rule ${rule}.` : `No ${kind} rule ${rule}.`,
        removed ? 'info' : 'error',
      )
    } else if (sub === 'mode') {
      const confirmed = /(^|\s)--yes$/.test(rest)
      const name = rest.replace(/\s*--yes$/, '').trim()
      if (!PERMISSION_MODES.includes(name as PermissionMode)) {
        return ctx.print(`Unknown mode "${name}". Modes: ${PERMISSION_MODES.join(', ')}.`, 'error')
      }
      if (name === 'bypassPermissions' && !confirmed) {
        return ctx.print(
          'bypassPermissions disables every approval prompt. Confirm with: /permissions mode bypassPermissions --yes',
          'error',
        )
      }
      engine.setMode(name as PermissionMode)
      ctx.print(`Mode set to ${name}.`)
    } else {
      ctx.print(PERMISSIONS_USAGE, 'error')
    }
  } catch (error) {
    ctx.print(`Permissions: ${errorText(error)}`, 'error')
  }
}

async function openTranscript(ctx: SlashContext): Promise<void> {
  const runs = ctx.subagents()
  const n = Number(ctx.args)
  const run = Number.isInteger(n) ? runs[n - 1] : undefined
  if (!run) {
    ctx.print(
      runs.length === 0
        ? 'No subagent runs in this session yet.'
        : `No run "${ctx.args}". Pick 1-${runs.length} (see /agents).`,
      'error',
    )
    return
  }
  ctx.openPage({
    kind: 'agent',
    target: {
      sessionId: run.sessionId,
      name: run.name,
      agent: run.name,
      description: run.description,
      status: run.status,
    },
  })
}

type Theme = 'dark' | 'light' | 'auto'
const THEMES: readonly Theme[] = ['dark', 'light', 'auto']

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** `YYYYMMDD-HHMMSS` in local time. */
function exportStamp(d: Date): string {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
}

/** All commands, in `/help` order. */
export const slashCommands: SlashCommand[] = [
  {
    name: 'help',
    description: 'Commands and keyboard shortcuts',
    run: (ctx) => ctx.openPage({ kind: 'help' }),
  },
  {
    name: 'clear',
    description: 'Start a new session',
    run: async (ctx) => {
      await ctx.controller.clear()
      ctx.reset()
      ctx.refreshStats()
    },
  },
  {
    name: 'compact',
    description: 'Summarise the conversation to free context',
    usage: '[instructions]',
    run: async (ctx) => {
      ctx.activity?.('Compacting conversation')
      try {
        const result = await ctx.controller.compact(ctx.args || undefined)
        ctx.activity?.(null)
        ctx.print(compactedLine(result))
      } catch (error) {
        ctx.activity?.(null)
        ctx.print(`Compaction failed: ${errorText(error)}`, 'error')
      }
      ctx.refreshStats()
    },
  },
  {
    name: 'context',
    description: 'Show what fills the context window',
    run: (ctx) => ctx.openPage({ kind: 'context' }),
  },
  {
    name: 'status',
    description: 'Show version, model, mounts, trust and settings',
    run: (ctx) => ctx.openPage({ kind: 'status' }),
  },
  {
    name: 'cost',
    description: 'Show token usage and estimated cost',
    run: (ctx) => ctx.openPage({ kind: 'cost' }),
  },
  {
    name: 'model',
    usage: '[id]',
    description: 'Pick a model, or switch with /model <id> (alt+p)',
    run: (ctx) => {
      if (!ctx.args) return ctx.pickModel()
      ctx.controller.setModel(ctx.args)
      ctx.setModelLabel(ctx.args)
      ctx.print(`Model set to ${ctx.args}.`)
      ctx.refreshStats()
    },
  },
  {
    name: 'thinking',
    usage: '[level]',
    description: `Pick the thinking level, or /thinking <${THINKING_LEVELS.join('|')}> (alt+t)`,
    run: (ctx) => {
      if (!ctx.args) return ctx.pickThinking()
      if (!THINKING_LEVELS.includes(ctx.args as ThinkingLevel)) {
        return ctx.print(
          `Unknown thinking level "${ctx.args}". Levels: ${THINKING_LEVELS.join(', ')}.`,
          'error',
        )
      }
      ctx.controller.setThinking(ctx.args as ThinkingLevel)
      ctx.print(`Thinking set to ${ctx.args}.`)
      ctx.refreshStats()
    },
  },
  {
    name: 'permissions',
    usage: '[allow|ask|deny <rule> [--project] | remove <kind> <rule> | mode <mode>]',
    description: 'Show or edit the permission mode and rules',
    run: (ctx) => runPermissions(ctx),
  },
  {
    name: 'agents',
    usage: '[n]',
    description: 'Subagents and their runs; /agents <n> opens the agent (live, you can message it)',
    run: (ctx) => (ctx.args ? openTranscript(ctx) : ctx.openPage({ kind: 'agents' })),
  },
  {
    name: 'transcript',
    usage: '<n>',
    description: 'Open the conversation of subagent run n (see /agents)',
    run: (ctx) => openTranscript(ctx),
  },
  {
    name: 'resume',
    usage: '[id]',
    description: 'Pick a stored session, or resume one by id',
    run: async (ctx) => {
      if (!ctx.args) {
        ctx.pickSession()
        return
      }
      const id = ctx.args
      try {
        await ctx.controller.resume(id)
        ctx.load(await ctx.controller.messages())
        ctx.print(`Resumed session ${id}.`)
        ctx.refreshStats()
      } catch (error) {
        ctx.print(`Cannot resume ${id}: ${errorText(error)}`, 'error')
      }
    },
  },
  {
    name: 'todos',
    description: 'Show the current todo list',
    run: (ctx) => {
      const todos = ctx.todos()
      const mark = { pending: '☐', in_progress: '◐', completed: '☑', cancelled: '☒' } as const
      ctx.print(
        !todos || todos.length === 0
          ? 'No todos.'
          : todos.map((t) => `  ${mark[t.status]} ${t.content}`).join('\n'),
      )
    },
  },
  {
    name: 'diff',
    description: 'Review the working-tree changes',
    run: (ctx) => ctx.openPage({ kind: 'diff' }),
  },
  {
    name: 'plan',
    usage: '[description]',
    description: 'Switch to plan mode, optionally starting with a task',
    run: (ctx) => {
      ctx.controller.permissions.setMode('plan')
      ctx.print('Mode set to plan.')
      if (ctx.args) ctx.submit(ctx.args)
    },
  },
  {
    name: 'retry',
    description: 'Run the last reply again (after an interruption or a bad answer)',
    run: (ctx) => ctx.retry(),
  },
  {
    name: 'rewind',
    description: 'Restore the code and/or conversation to a previous prompt (esc esc)',
    run: (ctx) => ctx.openRewind(),
  },
  {
    name: 'branch',
    usage: '[name]',
    description: 'Copy the conversation into a new session and switch to it',
    run: async (ctx) => {
      const id = await ctx.controller.branch(ctx.args || undefined)
      ctx.load(await ctx.controller.messages())
      ctx.print(`Branched into session ${id}${ctx.args ? ` (${ctx.args})` : ''}.`)
      ctx.refreshTitle()
      ctx.refreshStats()
    },
  },
  {
    name: 'rename',
    usage: '<name>',
    description: 'Name this session',
    run: async (ctx) => {
      if (!ctx.args) return ctx.print('Usage: /rename <name>', 'error')
      await ctx.controller.rename(ctx.args)
      ctx.print(`Session renamed to "${ctx.args}".`)
      ctx.refreshTitle()
    },
  },
  {
    name: 'export',
    usage: '[file]',
    description: 'Write the conversation as text (default coder-export-<time>.txt)',
    run: async (ctx) => {
      const text = await ctx.controller.exportText()
      const root = ctx.controller.config.root
      const target = ctx.args
        ? isAbsolute(ctx.args)
          ? ctx.args
          : resolve(root, ctx.args)
        : join(root, `coder-export-${exportStamp(new Date())}.txt`)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, text, 'utf8')
      ctx.print(`Exported the conversation to ${target}`)
    },
  },
  {
    name: 'copy',
    usage: '[n]',
    description: 'Copy the latest assistant response (or the n-th latest) to the clipboard',
    run: async (ctx) => {
      const n = ctx.args ? Number(ctx.args) : 1
      if (!Number.isInteger(n) || n < 1) return ctx.print('Usage: /copy [n]', 'error')
      const text = await ctx.controller.assistantText(n)
      if (!text) return ctx.print('No assistant response to copy.', 'error')
      ctx.print(`Copied ${text.length} characters (${await ctx.copy(text)}).`)
    },
  },
  {
    name: 'btw',
    usage: '<question>',
    description: 'Ask a side question without adding it to the conversation',
    run: (ctx) => {
      if (!ctx.args) return ctx.print('Usage: /btw <question>', 'error')
      ctx.sideQuestion(ctx.args)
    },
  },
  {
    name: 'recap',
    description: 'One-line recap of this session',
    run: async (ctx) => ctx.print(`Recap: ${await ctx.controller.recap()}`),
  },
  {
    name: 'add-dir',
    usage: '<path>',
    description: 'Give the agent access to another directory',
    run: async (ctx) => {
      if (!ctx.args) return ctx.print('Usage: /add-dir <path>', 'error')
      const mount = await ctx.controller.addDirectory(ctx.args)
      ctx.print(`Added ${ctx.args} as ${mount}`)
    },
  },
  {
    name: 'memory',
    description: 'Memory files the agent reads',
    run: (ctx) => ctx.openPage({ kind: 'memory' }),
  },
  {
    name: 'config',
    description: 'View and change settings',
    run: (ctx) => ctx.openPage({ kind: 'config' }),
  },
  {
    name: 'tasks',
    description: 'Background shell commands and agents',
    run: (ctx) => ctx.openPage({ kind: 'tasks' }),
  },
  {
    name: 'tell',
    description: 'Message a subagent: /tell <name|id> <message>',
    run: async (ctx) => {
      const space = ctx.args.search(/\s/)
      const to = space < 0 ? ctx.args : ctx.args.slice(0, space)
      const message = space < 0 ? '' : ctx.args.slice(space).trim()
      if (to === '' || message === '') {
        ctx.print('Usage: /tell <name|id> <message>', 'error')
        return
      }
      const result = await ctx.controller.sendAgentMessage(to, message)
      if (!result.ok) ctx.print(result.error.replace(/^ERROR: /, ''), 'error')
      else
        ctx.print(
          result.status === 'resumed'
            ? `Resumed ${result.id} with your message.`
            : `Message delivered to ${to}.`,
        )
    },
  },
  {
    name: 'doctor',
    description: 'Check the environment',
    run: (ctx) => ctx.openPage({ kind: 'doctor' }),
  },
  {
    name: 'browser',
    description: 'Show the state of the browser and run_python tools',
    run: async (ctx) => {
      const info = await ctx.controller.browserStatus()
      ctx.print(info.lines.join('\n'))
    },
  },
  {
    name: 'output-style',
    usage: '[name]',
    description: 'Pick the response style',
    run: async (ctx) => {
      if (!ctx.args) return ctx.pickOutputStyle()
      const styles = await ctx.controller.outputStyles()
      if (!styles.some((s) => s.name === ctx.args)) {
        return ctx.print(
          `Unknown output style "${ctx.args}". Styles: ${styles.map((s) => s.name).join(', ')}.`,
          'error',
        )
      }
      await ctx.controller.updateSetting('outputStyle', ctx.args, 'local')
      ctx.print(`Output style set to ${ctx.args}.`)
    },
  },
  {
    name: 'theme',
    usage: '[dark|light|auto]',
    description: 'Show or set the color theme',
    run: async (ctx) => {
      if (!ctx.args) {
        return ctx.print(
          `Theme: ${ctx.controller.setting('theme') ?? 'auto'}. Use /theme <dark|light|auto>.`,
        )
      }
      if (!THEMES.includes(ctx.args as Theme)) {
        return ctx.print(`Unknown theme "${ctx.args}". Themes: ${THEMES.join(', ')}.`, 'error')
      }
      await ctx.controller.updateSetting('theme', ctx.args, 'user')
      ctx.applyTheme(ctx.args as Theme)
      ctx.print(`Theme set to ${ctx.args}.`)
    },
  },
  {
    name: 'sandbox',
    description: 'Toggle the OS sandbox of the bash tool',
    run: async (ctx) => {
      const now = (await ctx.controller.status()).sandbox.enabled
      await ctx.controller.updateSetting('sandbox.enabled', !now, 'local')
      ctx.print(`Sandbox ${!now ? 'enabled' : 'disabled'}.`)
    },
  },
  {
    name: 'vim',
    description: 'Toggle vim keys in the prompt editor',
    run: async (ctx) => {
      const next = ctx.controller.setting('editorMode') === 'vim' ? 'normal' : 'vim'
      await ctx.controller.updateSetting('editorMode', next, 'user')
      ctx.applyEditorMode(next)
      ctx.print(`Editor mode: ${next}.`)
    },
  },
  {
    name: 'focus',
    description: 'Toggle the focus view (only prompts and final answers)',
    run: (ctx) => ctx.toggleFocus(),
  },
  {
    name: 'init',
    description:
      'Ask the agent to write or update the project instructions (AGENTS.md / CLAUDE.md)',
    run: (ctx) => ctx.submit(INIT_PROMPT),
  },
  {
    name: 'commit',
    usage: '[hint]',
    description:
      'Commit the staged changes with a drafted Conventional Commit message (asks first)',
    run: (ctx) => ctx.submit(commitPrompt(ctx.args)),
  },
  {
    name: 'pr',
    usage: '[hint]',
    description: 'Open a pull request for this branch with gh (drafts title and body, asks first)',
    run: (ctx) => ctx.submit(prPrompt(ctx.args)),
  },
  {
    name: 'exit',
    description: 'Quit',
    run: (ctx) => ctx.exit(),
  },
]

/** Parse `/name args`; null when the text is not a slash command. */
export function parseSlash(text: string): { name: string; args: string } | null {
  const match = /^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/.exec(text.trim())
  return match ? { name: match[1] as string, args: (match[2] ?? '').trim() } : null
}

/** One entry of the `/` completion list: a built-in, a custom command or a skill. */
export interface SlashSuggestion {
  name: string
  usage?: string
  description: string
  /** Set for custom commands and skills. */
  source?: CustomCommand['source']
}

/** Commands (built-ins first, then `custom`) whose name starts with the typed prefix. */
export function matchSlash(
  input: string,
  custom: readonly CustomCommand[] = [],
): SlashSuggestion[] {
  const match = /^\/([\w-]*)$/.exec(input)
  if (!match) return []
  const prefix = (match[1] as string).toLowerCase()
  const builtin: SlashSuggestion[] = slashCommands.filter((c) => c.name.startsWith(prefix))
  const names = new Set(slashCommands.map((c) => c.name))
  const extra = custom
    .filter((c) => !names.has(c.name) && c.name.toLowerCase().startsWith(prefix))
    .map(
      (c): SlashSuggestion => ({
        name: c.name,
        ...(c.argumentHint ? { usage: c.argumentHint } : {}),
        description: c.description,
        source: c.source,
      }),
    )
  return [...builtin, ...extra]
}

/** True when `name` is a built-in slash command. */
export function isBuiltin(name: string): boolean {
  return slashCommands.some((c) => c.name === name)
}

/**
 * Run a slash command. Returns false when `text` is not a slash command; an unknown command prints
 * an error and returns true.
 */
export async function runSlash(text: string, ctx: Omit<SlashContext, 'args'>): Promise<boolean> {
  const parsed = parseSlash(text)
  if (!parsed) return false
  const command = slashCommands.find((c) => c.name === parsed.name)
  if (!command) {
    ctx.print(`Unknown command /${parsed.name}. Type /help.`, 'error')
    return true
  }
  try {
    await command.run({ ...ctx, args: parsed.args })
  } catch (error) {
    ctx.print(`/${command.name} failed: ${errorText(error)}`, 'error')
  }
  return true
}

/** `✻ Conversation compacted (52k → 8.1k tokens · ctrl+o for history)`, like Claude Code. */
export function compactedLine(result: CompactSummary | null): string {
  if (result === null) return 'Nothing to compact yet.'
  const parts: string[] = []
  if (result.tokens) {
    parts.push(
      `${formatTokens(result.tokens.before)} → ${formatTokens(result.tokens.after)} tokens`,
    )
  }
  parts.push('ctrl+o for history')
  return `✻ Conversation compacted (${parts.join(' · ')})`
}
