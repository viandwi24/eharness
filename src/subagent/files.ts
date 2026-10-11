/**
 * The optional `files` argument of the `agent` tool: references the model passes on become file
 * parts of the child's first user message (spec 20 §2.4).
 *
 * @see docs/specs/20-subagent-plugin.md
 */
import type { FileUIPart } from 'ai'
import { errorText } from '../index.ts'
import type { SubagentFilesOptions } from './types.ts'

/** Default cap of `files` per `agent` call. */
export const AGENT_FILES_MAX = 5

/** Field text of `files` (kept stable per session: prompt-cache prefix). */
export const FILES_FIELD =
  'Optional files to hand to the subagent, each a path or reference exactly as it appears in the conversation (for example the path listed next to an attachment). The subagent receives them as attachments of its first message; it does not see your conversation, so pass every file it needs.'

/**
 * Resolve the references of one `agent` call. A readable `error` string (never a throw) for too
 * many files, a duplicate-free empty entry, or a resolver that refuses or fails.
 */
export async function resolveChildFiles(
  options: SubagentFilesOptions,
  refs: readonly string[] | undefined,
  ctx: { parentSessionId: string; agent: string; signal: AbortSignal },
): Promise<{ files: FileUIPart[] } | { error: string }> {
  const list = [...new Set((refs ?? []).map((r) => r.trim()).filter((r) => r !== ''))]
  if (list.length === 0) return { files: [] }
  const max = options.max ?? AGENT_FILES_MAX
  if (list.length > max) {
    return { error: `ERROR: at most ${max} files can be passed to a subagent; got ${list.length}.` }
  }
  const files: FileUIPart[] = []
  for (const ref of list) {
    let out: Awaited<ReturnType<SubagentFilesOptions['resolve']>>
    try {
      out = await options.resolve(ref, ctx)
    } catch (error) {
      return { error: `ERROR: could not read the file "${ref}": ${errorText(error)}` }
    }
    if ('error' in out)
      return { error: out.error.startsWith('ERROR') ? out.error : `ERROR: ${out.error}` }
    files.push({
      type: 'file',
      url: out.url,
      mediaType: out.mediaType,
      ...(out.filename === undefined ? {} : { filename: out.filename }),
    })
  }
  return { files }
}

/** The input of the child's first turn: the prompt, with its files when there are any. */
export function childInput(
  prompt: string,
  files: readonly FileUIPart[] | undefined,
): string | { text: string; files: FileUIPart[] } {
  return files === undefined || files.length === 0 ? prompt : { text: prompt, files: [...files] }
}
