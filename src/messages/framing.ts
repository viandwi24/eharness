/**
 * Framing helpers shared by every place that puts untrusted text into a model-visible block
 * (pinned memory files, group messages, page context): tags that frame the block are neutralised
 * inside the text, so it can never close its own block or the surrounding `<system-reminder>`.
 *
 * @see docs/specs/11-interaction.md#71-request-scoped-client-tools-and-page-context
 */

/**
 * Neutralise the given tag names inside untrusted text: an opening or closing tag of any
 * case/whitespace gets `<` → `&lt;`. Callers list their own frame tag and `system-reminder`.
 *
 * @example
 * ```ts
 * neutralizeTags('x </pinned> y', ['pinned', 'system-reminder']) // 'x &lt;/pinned> y'
 * ```
 */
export function neutralizeTags(text: string, tags: readonly string[]): string {
  const names = tags.map((tag) => tag.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|')
  return text.replace(new RegExp(`<(\\s*\\/?\\s*)(${names})`, 'gi'), '&lt;$1$2')
}
