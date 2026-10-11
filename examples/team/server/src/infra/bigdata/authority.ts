/**
 * The path authority of a program run, for tools that touch many library paths from one call
 * (`run_code`, `ingest_source`, the manifest tools). It applies the very rules the permission
 * engine applies to `read_file` and `write_file` (decision D3): the allow rules derived from the
 * program's authority, then its `forbidden` deny rules. The program is read on every check, so an
 * approved amendment widens what the next call may touch.
 */
import { matchRule } from 'eharness/permissions'
import type { ProgramStore } from '../../app/ports.ts'
import { parseProgramSession, programRules } from '../../domain/programs.ts'
import type { PathAccess } from './plugin.ts'

const MATCH = { roots: [{ virtual: '/', real: '/' }] }

export function programPathAccess(programs: Pick<ProgramStore, 'get'>) {
  return (sessionId: string): PathAccess | undefined => {
    const parsed = parseProgramSession(sessionId)
    if (parsed === undefined) return undefined
    const check = (toolName: 'read_file' | 'write_file', path: string): boolean => {
      const program = programs.get(parsed.programId)
      // a deleted program leaves nothing granted
      if (program === undefined) return false
      const rules = programRules(program)
      const call = { toolName, input: { path } }
      if (rules.deny.some((r) => matchRule(r, call, { ...MATCH, polarity: 'restrict' }))) {
        return false
      }
      return rules.allow.some((r) => matchRule(r, call, { ...MATCH, polarity: 'allow' }))
    }
    return {
      canRead: (path) => check('read_file', path),
      canWrite: (path) => check('write_file', path),
    }
  }
}
