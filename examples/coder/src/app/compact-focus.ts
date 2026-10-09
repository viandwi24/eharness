/**
 * Compact with focus (`/compact <instructions>`): a plugin whose `compaction.prompt` hook adds
 * the pending focus text to the summarizer context, once.
 *
 * Integration: add `focus.plugin` to the MAIN agent, then
 * `compact = async (instructions) => { if (instructions) focus.setFocus(instructions); await session.compact() }`
 * (see {@link compactWithFocus}). The focus is consumed by the first summarization that reads it
 * and cleared when the compaction ends without summarizing (nothing to compact).
 */
import { definePlugin } from 'eharness'

export interface CompactFocus {
  plugin: ReturnType<typeof definePlugin>
  /** Set the focus for the next summarization (an empty text clears it). */
  setFocus(text: string | undefined): void
  /** The pending focus, if any. */
  pending(): string | undefined
}

/** The focus holder and its plugin (name `compact-focus`, no tools). */
export function createCompactFocus(): CompactFocus {
  let focus: string | undefined
  return {
    setFocus(text) {
      const clean = text?.trim()
      focus = clean ? clean : undefined
    },
    pending: () => focus,
    plugin: definePlugin({
      name: 'compact-focus',
      setup: () => ({
        hooks: {
          'compaction.prompt': (_ctx, out) => {
            if (focus === undefined) return
            out.context.push(`The user asked the summary to focus on: ${focus}`)
            focus = undefined
          },
        },
      }),
    }),
  }
}

/** `CoderController.compact(instructions)`: set the focus, run the compaction, never leave it pending. */
export async function compactWithFocus<T>(
  focus: CompactFocus,
  compact: () => Promise<T>,
  instructions?: string,
): Promise<T> {
  focus.setFocus(instructions)
  try {
    return await compact()
  } finally {
    focus.setFocus(undefined)
  }
}
