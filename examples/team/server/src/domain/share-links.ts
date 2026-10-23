/**
 * Public share links in agent text. Pure.
 *
 * Models retype long random tokens and get a few characters wrong, or keep pasting the link of an
 * artifact that was deleted or made private again. `fixShareLinks` looks at every `/s/<token>` (and
 * `/art/s/<token>/...`) in a text: a token that is not live but is one or two typos away from
 * exactly one live token is repaired; any other unknown token is marked, so a person is told the
 * link is dead instead of opening it.
 */

/** A live public share: the token of an artifact that is public and not deleted. */
export interface KnownShare {
  token: string
  artifactId: string
  title: string
}

export interface FixShareLinksOptions {
  /** Appended after a dead link (default `DEAD_LINK_MARKER`). */
  marker?: string
  /** Largest edit distance of a repair (default 3). */
  maxDistance?: number
  /** Largest length difference of a repair (default 2). */
  maxLengthDelta?: number
}

export interface FixedShareLink {
  from: string
  to: string
  title: string
}

export interface FixShareLinksResult {
  text: string
  fixed: FixedShareLink[]
  /** The unknown tokens that were marked (once per distinct token). */
  dead: string[]
}

export const DEAD_LINK_MARKER = ' (link no longer available)'

/** Shorter words after `/s/` are not tokens (real ones are 22 characters). */
const MIN_TOKEN_LENGTH = 16

/**
 * `<origin>` (optional) `/art`? `/s/` `<token>` and the rest of the URL. The rest never contains
 * a parenthesis, a quote or a space, so a markdown target ends where the link does.
 */
const LINK =
  /((?:https?:\/\/[^\s/()<>"'[\]]+)?(?:\/art)?\/s\/)([A-Za-z0-9_-]+)((?:[/?#][^\s()<>"'[\]]*)?)/g

/** Optimal string alignment distance: insert, delete, substitute, swap of neighbours. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0
  const rows: number[][] = []
  for (let i = 0; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0)
    row[0] = i
    rows.push(row)
  }
  const first = rows[0] as number[]
  for (let j = 0; j <= b.length; j++) first[j] = j
  for (let i = 1; i <= a.length; i++) {
    const row = rows[i] as number[]
    const prev = rows[i - 1] as number[]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let d = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, ((rows[i - 2] as number[])[j - 2] as number) + 1)
      }
      row[j] = d
    }
  }
  return (rows[a.length] as number[])[b.length] as number
}

/** The one live share this unknown token is a typo of, or undefined (none, or more than one). */
function closest(
  token: string,
  known: readonly KnownShare[],
  maxDistance: number,
  maxLengthDelta: number,
): KnownShare | undefined {
  const near: KnownShare[] = []
  const seen = new Set<string>()
  for (const k of known) {
    if (seen.has(k.token)) continue
    seen.add(k.token)
    if (Math.abs(k.token.length - token.length) > maxLengthDelta) continue
    if (editDistance(token, k.token) <= maxDistance) near.push(k)
  }
  return near.length === 1 ? near[0] : undefined
}

/** Tidy the end of a bare URL: the sentence's own punctuation is not part of it. */
function trimTail(rest: string): string {
  return rest.replace(/[.,;:!?]+$/, '')
}

export function fixShareLinks(
  text: string,
  known: readonly KnownShare[],
  opts: FixShareLinksOptions = {},
): FixShareLinksResult {
  const marker = opts.marker ?? DEAD_LINK_MARKER
  const maxDistance = opts.maxDistance ?? 3
  const maxLengthDelta = opts.maxLengthDelta ?? 2
  const live = new Set(known.map((k) => k.token))
  const fixed: FixedShareLink[] = []
  const dead: string[] = []
  let out = ''
  let cursor = 0

  for (const m of text.matchAll(LINK)) {
    const index = m.index ?? 0
    const prefix = m[1] as string
    const token = m[2] as string
    const tokenAt = index + prefix.length
    if (tokenAt < cursor) continue
    const before = index > 0 ? (text[index - 1] as string) : ''
    // a relative `/s/` must start a word: `/docs/s/...` or `a/s/b` is not a share link
    if (!prefix.startsWith('http') && /[\w.\-/]/.test(before)) continue
    if (token.length < MIN_TOKEN_LENGTH) continue
    if (live.has(token)) continue
    const near = closest(token, known, maxDistance, maxLengthDelta)
    if (near !== undefined) {
      out += text.slice(cursor, tokenAt) + near.token
      cursor = tokenAt + token.length
      fixed.push({ from: token, to: near.token, title: near.title })
      continue
    }
    if (!dead.includes(token)) dead.push(token)
    const rest = trimTail(m[3] as string)
    let end = tokenAt + token.length + rest.length
    if (before === '(' && index >= 2 && text[index - 2] === ']') {
      // a markdown target: the marker goes behind its closing parenthesis, never inside it
      const close = text.indexOf(')', end)
      const line = text.indexOf('\n', end)
      if (close !== -1 && (line === -1 || close < line)) end = close + 1
    }
    out += text.slice(cursor, end)
    cursor = end
    if (!text.startsWith(marker, cursor)) out += marker
  }
  out += text.slice(cursor)
  return { text: out, fixed, dead }
}
