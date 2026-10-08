/** The edits of an `edit_file` call: the single form (`old_string`/`new_string`) or `edits[]`. */

/** One replacement of an `edit_file` call. */
export interface FileEdit {
  oldString: string
  newString: string
  replaceAll: boolean
}

/**
 * Normalise the input of an `edit_file` call (spec 08): `edits[]` when present, else the single
 * `old_string`/`new_string` pair. Malformed entries are skipped; `[]` when nothing usable is there.
 */
export function editsOf(input: unknown): FileEdit[] {
  if (typeof input !== 'object' || input === null) return []
  const record = input as Record<string, unknown>
  const one = (value: unknown): FileEdit[] => {
    if (typeof value !== 'object' || value === null) return []
    const e = value as Record<string, unknown>
    if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') return []
    return [
      { oldString: e.old_string, newString: e.new_string, replaceAll: e.replace_all === true },
    ]
  }
  if (Array.isArray(record.edits)) return record.edits.flatMap(one)
  return one(record)
}
