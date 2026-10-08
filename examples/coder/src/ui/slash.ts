/** Slash commands of the interactive UI: registry, parsing and the commands themselves. */
import type { Todo } from 'eharness/todos'
import type { CoderController, CoderMessage } from '../contracts.ts'

/** What a command may do to the UI. */
export interface SlashContext {
  controller: CoderController
  /** Text after the command name, trimmed. */
  args: string
  /** Current model id (changes with `/model`). */
  model: string
  /** Print dim system lines into the transcript. */
  print(text: string, tone?: 'info' | 'error'): void
  /** Clear the transcript view. */
  reset(): void
  /** Replace the transcript with these stored messages. */
  load(messages: CoderMessage[]): void
  /** Open the session picker. */
  pickSession(): void
  /** Start a turn with this prompt. */
  submit(prompt: string): void
  /** The latest todo list, if any. */
  todos(): Todo[] | null
  setModelLabel(model: string): void
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
  'Analyse this project: its layout, languages, build, test and lint commands, conventions and anything a new contributor should know. Then write an AGENTS.md at the project root that captures it concisely (commands first). If an AGENTS.md already exists, improve it instead of replacing it.'

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** All commands, in `/help` order. */
export const slashCommands: SlashCommand[] = [
  {
    name: 'help',
    description: 'List the commands and keys',
    run: (ctx) => {
      const lines = slashCommands.map(
        (c) => `  /${c.name}${c.usage ? ` ${c.usage}` : ''}`.padEnd(22) + c.description,
      )
      ctx.print(
        [
          'Commands:',
          ...lines,
          '',
          'Keys: enter send · shift+enter or \\ + enter newline · esc interrupt · shift+tab mode',
          '      ctrl+o expand tool output · ctrl+c twice exit · up/down history',
        ].join('\n'),
      )
    },
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
    run: async (ctx) => {
      ctx.print('Compacting the conversation…')
      try {
        await ctx.controller.compact()
        ctx.print('Conversation compacted.')
      } catch (error) {
        ctx.print(`Compaction failed: ${error instanceof Error ? error.message : error}`, 'error')
      }
      ctx.refreshStats()
    },
  },
  {
    name: 'model',
    usage: '<id>',
    description: 'Show or switch the model',
    run: (ctx) => {
      if (!ctx.args) {
        ctx.print(`Model: ${ctx.model}. Switch with /model <id>.`)
        return
      }
      ctx.controller.setModel(ctx.args)
      ctx.setModelLabel(ctx.args)
      ctx.print(`Model set to ${ctx.args}.`)
      ctx.refreshStats()
    },
  },
  {
    name: 'permissions',
    description: 'Show the permission mode and rules',
    run: (ctx) => {
      const rules = ctx.controller.permissions.rules()
      const list = (name: string, items: string[]): string =>
        `  ${name}: ${items.length > 0 ? items.join(', ') : '(none)'}`
      ctx.print(
        [
          `Mode: ${ctx.controller.permissions.mode}`,
          list('allow', rules.allow),
          list('ask', rules.ask),
          list('deny', rules.deny),
        ].join('\n'),
      )
    },
  },
  {
    name: 'agents',
    description: 'List the available subagents',
    run: (ctx) => {
      const agents = ctx.controller.agents()
      ctx.print(
        agents.length === 0
          ? 'No subagents defined.'
          : agents.map((a) => `  ${a.name} (${a.source}): ${a.description}`).join('\n'),
      )
    },
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
        ctx.print(`Cannot resume ${id}: ${error instanceof Error ? error.message : error}`, 'error')
      }
    },
  },
  {
    name: 'cost',
    description: 'Show context usage and cost',
    run: async (ctx) => {
      const s = await ctx.controller.stats()
      const pct = s.contextWindow > 0 ? Math.round((s.contextTokens / s.contextWindow) * 100) : 0
      ctx.print(
        `Context: ${formatTokens(s.contextTokens)} / ${formatTokens(s.contextWindow)} tokens (${pct}%)` +
          (s.costUsd === undefined ? '' : ` · cost $${s.costUsd.toFixed(4)}`),
      )
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
    name: 'init',
    description: 'Ask the agent to write an AGENTS.md for this project',
    run: (ctx) => ctx.submit(INIT_PROMPT),
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

/** Commands whose name starts with the typed prefix (`/re` → `resume`). */
export function matchSlash(input: string): SlashCommand[] {
  const match = /^\/([\w-]*)$/.exec(input)
  if (!match) return []
  const prefix = (match[1] as string).toLowerCase()
  return slashCommands.filter((c) => c.name.startsWith(prefix))
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
    ctx.print(`/${command.name} failed: ${error instanceof Error ? error.message : error}`, 'error')
  }
  return true
}
