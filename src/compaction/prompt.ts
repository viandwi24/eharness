/**
 * The summarizer prompt (internal): default instructions (a continuation brief), the user prompt
 * around the transcript, and the `compaction.prompt` hook integration.
 *
 * @see docs/specs/06-compaction.md#53-summarize
 */

import type { HarnessUIMessage } from '../messages/types.ts'
import type { HarnessContext } from '../plugin/types.ts'
import type { HookRunner } from '../session/hooks.ts'

/** Default summarizer instructions. Changing the text is a minor change. */
export const DEFAULT_COMPACTION_PROMPT: string = `You summarize the earlier part of a conversation between a user and an AI agent. The agent will continue the work with your summary instead of the old messages, so write a continuation brief that lets it continue without them.

Write these sections, in this order, and leave out a section only when there is nothing for it:

1. Goal and constraints: what the user wants, and every requirement, preference and constraint they stated.
2. Decisions: what was decided or agreed, and why.
3. Current state: what has been done, what is in progress, and the results of tool calls that still matter.
4. Open questions: anything unresolved or waiting for the user.
5. Next steps: what the agent should do next.
6. Important identifiers: file paths, ids, names, URLs, commands and exact values needed to continue.

Rules:
- If the transcript starts with PREVIOUS SUMMARY, merge it into the new brief and keep everything that is still relevant.
- Be specific and factual. Keep identifiers exactly as written.
- Do not invent anything that is not in the transcript.
- Write plain text. Do not write tool calls, XML or any other markup.`

/** Build the summarizer user prompt for one (chunk of a) transcript. */
export function summarizerInput(transcript: string, context: readonly string[]): string {
  const parts = [
    'Summarize the following conversation transcript as instructed.',
    `<transcript>\n${transcript}\n</transcript>`,
  ]
  const lines = context.map((c) => c.trim()).filter((c) => c.length > 0)
  if (lines.length > 0) {
    parts.push(
      `Additional context to keep in the summary:\n${lines.map((l) => `- ${l}`).join('\n')}`,
    )
  }
  return parts.join('\n\n')
}

/**
 * Run the `compaction.prompt` hooks (plugin order): each may push `context` lines or replace
 * `prompt`. A throwing hook is reported through `onError` and skipped.
 */
export async function resolveSummarizerPrompt(args: {
  hooks: HookRunner | undefined
  contextOf: (owner: string) => HarnessContext
  configured: string | undefined
  onError: (owner: string, error: unknown) => void
  /** The messages being summarized (handed to the hooks as copies). */
  messages: readonly HarnessUIMessage[]
  /** Focus text of a manual `compact({ instructions })`. */
  instructions?: string | undefined
}): Promise<{ prompt: string; context: string[] }> {
  const instructions = args.instructions?.trim()
  const out: {
    context: string[]
    prompt?: string
    readonly messages: HarnessUIMessage[]
    readonly instructions?: string
  } = {
    context: [],
    messages: structuredClone([...args.messages]),
    ...(instructions ? { instructions } : {}),
  }
  if (args.configured !== undefined) out.prompt = args.configured
  for (const hook of args.hooks?.list('compaction.prompt') ?? []) {
    try {
      await hook.fn(args.contextOf(hook.owner), out)
    } catch (error) {
      args.onError(hook.owner, error)
    }
  }
  const prompt =
    typeof out.prompt === 'string' && out.prompt.trim().length > 0
      ? out.prompt
      : DEFAULT_COMPACTION_PROMPT
  const context = Array.isArray(out.context)
    ? out.context.filter((c): c is string => typeof c === 'string')
    : []
  // the caller's focus text comes last, after every plugin line
  if (instructions) context.push(`The user asked the summary to focus on: ${instructions}`)
  return { prompt, context }
}
