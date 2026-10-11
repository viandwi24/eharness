/** The audit log: one JSON line per approval decision (`<projectDataDir>/audit.jsonl`). */
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ApprovalDecision } from 'eharness'

/** The log rotates to `<file>.1` (replacing the previous one) when it grows past this. */
export const AUDIT_MAX_BYTES = 5_000_000
/** Strings of a tool input longer than this are cut in the log (file contents, long commands). */
const INPUT_STRING_MAX = 500

/** Copy of a tool input with every long string cut: the log records what was decided, not file bodies. */
export function clipInput(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > INPUT_STRING_MAX
      ? `${value.slice(0, INPUT_STRING_MAX)}...[${value.length - INPUT_STRING_MAX} more chars]`
      : value
  }
  if (depth > 6 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => clipInput(v, depth + 1))
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 50)
      .map(([k, v]) => [k, clipInput(v, depth + 1)]),
  )
}

/**
 * An `onDecision` callback for `permissionsPlugin()` that appends every decision to `file`
 * (owner-only permissions, size-based rotation, long tool inputs cut).
 *
 * @param file - The JSON-lines file.
 * @param agent - Subagent name recorded with each line (undefined for the main agent).
 */
export function auditLog(
  file: string,
  agent?: string,
): (decision: ApprovalDecision) => Promise<void> {
  return async (e) => {
    try {
      const line = JSON.stringify({
        at: new Date().toISOString(),
        agent,
        toolName: e.toolName,
        approved: e.approved,
        by: e.by,
        reason: e.reason,
        input: clipInput(e.input),
      })
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      try {
        if ((await stat(file)).size > AUDIT_MAX_BYTES) await rename(file, `${file}.1`)
      } catch {
        // no file yet
      }
      await appendFile(file, `${line}\n`, { mode: 0o600 })
    } catch {
      // the audit log must never break a turn
    }
  }
}
