/** The audit log: one JSON line per approval decision (`<projectDataDir>/audit.jsonl`). */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ApprovalDecision } from 'eharness'

/**
 * An `onDecision` callback for `permissionsPlugin()` that appends every decision to `file`.
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
        input: e.input,
      })
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, `${line}\n`)
    } catch {
      // the audit log must never break a turn
    }
  }
}
