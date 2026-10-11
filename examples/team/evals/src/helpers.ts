/** Small helpers scenarios use in their checks. */
import type { CheckContext, CheckOutcome } from './types.ts'

/** The text of a produced file, or undefined. */
export const output = (ctx: CheckContext, path: string): string | undefined => ctx.outputs[path]

export function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Recall and precision of a reported id set against the truth set. */
export function recallPrecision(
  truth: Iterable<string>,
  reported: Iterable<string>,
): { recall: number; precision: number } {
  const t = new Set(truth)
  const r = new Set(reported)
  let hit = 0
  for (const id of r) if (t.has(id)) hit++
  return { recall: t.size === 0 ? 1 : hit / t.size, precision: r.size === 0 ? 0 : hit / r.size }
}

/** Fraction of `required` headings (case-insensitive `## Name`) present in a Markdown text. */
export function sectionCoverage(
  text: string,
  required: readonly string[],
): { score: number; missing: string[] } {
  const heads = new Set(
    [...text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => (m[1] as string).toLowerCase()),
  )
  const missing = required.filter((s) => !heads.has(s.toLowerCase()))
  return {
    score: required.length === 0 ? 1 : (required.length - missing.length) / required.length,
    missing,
  }
}

export const outcome = (
  score: number,
  detail: string,
  metrics?: Record<string, number>,
): CheckOutcome => ({
  score,
  detail,
  ...(metrics === undefined ? {} : { metrics }),
})
