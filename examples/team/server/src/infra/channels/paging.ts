/**
 * Helpers of the server-side tables (the Channels pages): a safe LIKE pattern, a whitelisted ORDER
 * BY and the page window. Every table endpoint filters, sorts and counts in SQL; only the rows of
 * one page are turned into views.
 */

/** A `LIKE ... ESCAPE '\'` pattern that matches `text` anywhere (`%`, `_` and `\` are literal). */
export const likePattern = (text: string): string => `%${text.replace(/[\\%_]/g, '\\$&')}%`

export interface SortColumn {
  /** The SQL expression to order by. */
  expr: string
  /** The direction when the request names none. */
  defaultOrder: 'asc' | 'desc'
}

/**
 * `ORDER BY` of a whitelisted sort. An unknown sort falls back to `fallback`; `tie` (a unique
 * column) keeps the pages stable.
 */
export function orderBy(
  columns: Record<string, SortColumn>,
  sort: string | undefined,
  order: 'asc' | 'desc' | undefined,
  fallback: string,
  tie: string,
): string {
  const key = sort !== undefined && columns[sort] !== undefined ? sort : fallback
  const col = columns[key] as SortColumn
  const dir = (order ?? col.defaultOrder) === 'asc' ? 'ASC' : 'DESC'
  return `ORDER BY ${col.expr} ${dir}, ${tie} ${dir}`
}

/** `LIMIT ? OFFSET ?` arguments of a page. */
export const windowOf = (page: number, limit: number): [number, number] => [
  limit,
  Math.max(0, (page - 1) * limit),
]
