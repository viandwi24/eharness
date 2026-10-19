/**
 * The program authority gate: the closed-world check of a program (or rehearsal) run, read from
 * the program on every call. Extracted from `agent-factory.ts`; the rule building and the
 * refusal texts live in `domain/programs.ts`.
 */
import type { ActivatedConnectors } from 'eharness/connectors'
import { matchRule } from 'eharness/permissions'
import type { ProgramStore } from '../../../app/ports.ts'
import { forbiddenReason, outsideAuthorityReason, programRules } from '../../../domain/programs.ts'
import { MEMORY_TOOL_KINDS } from '../connector-catalog.ts'
import type { SessionGate } from '../permission-plugin.ts'

export interface ProgramGateInput {
  programId: string
  out: ActivatedConnectors
  programs?: Pick<ProgramStore, 'get'> | undefined
}

export function createProgramGate(
  input: ProgramGateInput,
): SessionGate & { rules: { allow: string[]; deny: string[] } } {
  const { out } = input
  const parsed = { programId: input.programId }
  const deps = { programs: input.programs }
  const tools = Object.entries(out.toolNameMap).map(([name, origin]) => ({
    name,
    connectorId: origin.connectorId,
    connectionIds: origin.connectionIds,
  }))
  const match = {
    roots: [{ virtual: '/', real: '/' }],
    toolKinds: { ...MEMORY_TOOL_KINDS, ...out.rules.toolKinds },
  }
  // a deleted program leaves nothing granted: its session can still be read, never act
  const current = (): {
    name: string
    rules: { allow: string[]; deny: string[] }
    readable: string[]
  } => {
    const program = deps.programs?.get(parsed.programId)
    return {
      name: program?.name ?? parsed.programId,
      readable:
        program === undefined ? [] : [...program.authority.read, ...program.authority.write],
      rules: program === undefined ? { allow: [], deny: [] } : programRules(program, tools),
    }
  }
  return {
    rules: current().rules,
    refuse(call) {
      const { name, rules, readable } = current()
      for (const rule of rules.deny) {
        if (matchRule(rule, call, { ...match, polarity: 'restrict' })) {
          return forbiddenReason(name, call.toolName, rule)
        }
      }
      const granted = rules.allow.some((rule) =>
        matchRule(rule, call, { ...match, polarity: 'allow' }),
      )
      if (granted) return undefined
      // a search or listing without a path scans the whole tree: say where it may look
      const listing =
        (match.toolKinds as Record<string, { listing?: unknown } | undefined>)[call.toolName]
          ?.listing !== undefined
      return outsideAuthorityReason(name, call.toolName, listing ? readable : [])
    },
    askedReason: (toolName) => outsideAuthorityReason(current().name, toolName),
    // the engine learns rules the program gained since the session opened (session scope)
    async sync(engine) {
      const { rules } = current()
      for (const rule of rules.allow) await engine.addRule('allow', rule, 'session')
      for (const rule of rules.deny) await engine.addRule('deny', rule, 'session')
    },
  }
}
