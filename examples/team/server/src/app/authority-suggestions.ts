/**
 * Authority suggestions: when the runs of a program are refused the same tool again and again, the
 * Decision Center gets one item per program and tool ("Add <tool> to the authority of program
 * <name>?"). It is an ordinary amendment without a parked run: approving it merges the tool into the
 * authority through the same path as `request_authority` (`approveDecision`); rejecting it silences
 * the suggestion for that program and tool. Never a forbidden tool, never a risky one.
 */
import type { AmendmentPayload, Decision } from '../domain/decisions.ts'
import { checkTitle } from '../domain/decisions.ts'
import {
  type DeniedToolCandidate,
  deniedToolCandidates,
  safeToSuggest,
  type ToolEvent,
} from '../domain/health.ts'
import { normalizeAuthority, PROGRAM_FILE_TOOLS, type Program } from '../domain/programs.ts'
import { changed } from './decisions.ts'
import type { Deps } from './ports.ts'

/** The suggestion of a decision, when it is one. */
const suggestionOf = (d: Decision): { tool: string } | undefined =>
  d.kind === 'amendment' ? (d.payload as AmendmentPayload).suggestion : undefined

/** True when an open or rejected suggestion for this program and tool exists (do not ask again). */
function alreadyAsked(deps: Deps, programId: string, tool: string): boolean {
  return (['open', 'rejected'] as const).some((status) =>
    deps.decisions
      .list({ status, kind: 'amendment', limit: 500 })
      .some((d) => d.programId === programId && suggestionOf(d)?.tool === tool),
  )
}

/** Tool kind and whether it can be granted, from the agent's own inventory; undefined when unknown. */
async function toolInfo(
  deps: Deps,
  program: Program,
  tool: string,
): Promise<{ kind: string; granted: boolean } | undefined> {
  const authority = normalizeAuthority({ tools: [tool] })
  let inspection = deps.programRunner.inspect(program.agentId, authority)
  if (inspection === undefined) {
    try {
      await deps.programRunner.prepare(program.agentId)
    } catch {
      return undefined
    }
    inspection = deps.programRunner.inspect(program.agentId, authority)
  }
  const found = inspection?.grant.tools.find((t) => t.name === tool)
  // a tool the inventory cannot resolve is unknown (the run that was refused it had it): the name
  // rules decide; a tool that is switched off or gated is never suggested
  if (found === undefined || found.status === 'unavailable') return undefined
  return { kind: found.kind, granted: found.status === 'granted' }
}

const when = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

function bodyOf(c: DeniedToolCandidate, program: Program): string {
  return [
    `Runs of **${program.name}** were refused \`${c.tool}\` as outside the program's authority: **${c.denials}** times in **${c.runs}** run${c.runs === 1 ? '' : 's'} (${when(c.firstSeen)} to ${when(c.lastSeen)} UTC).`,
    '',
    '## Evidence',
    ...c.sessions.slice(0, 5).map((s) => `- run \`${s}\``),
    '',
    `Approving adds \`${c.tool}\` to the authority of the program: later runs may use it. Rejecting keeps it out and this question is not asked again for this program and tool.`,
  ].join('\n')
}

/**
 * Creates the suggestions the denials of the last day call for. Idempotent: a program and tool
 * with an open or rejected suggestion is skipped. Returns the new decisions.
 */
export async function suggestAuthority(
  deps: Deps,
  tools: readonly ToolEvent[],
  now: number,
): Promise<Decision[]> {
  const programs = new Map(deps.programs.list({}).map((p) => [p.id, p]))
  const candidates = deniedToolCandidates(
    tools,
    new Map(
      [...programs].map(([id, p]) => [id, { forbidden: p.forbidden, tools: p.authority.tools }]),
    ),
    now,
    PROGRAM_FILE_TOOLS,
  )
  const created: Decision[] = []
  for (const c of candidates) {
    const program = programs.get(c.programId)
    if (program === undefined || program.status !== 'active') continue
    // the program may have been widened since the denials
    if (alreadyAsked(deps, program.id, c.tool)) continue
    const info = await toolInfo(deps, program, c.tool)
    if (info !== undefined && !info.granted) continue
    if (!safeToSuggest(c.tool, info?.kind)) continue
    const payload: AmendmentPayload = {
      authority: normalizeAuthority({ tools: [c.tool] }),
      why: `Runs of this program were refused ${c.tool} ${c.denials} times in ${c.runs} run${c.runs === 1 ? '' : 's'}.`,
      suggestion: { tool: c.tool, runs: c.runs, denials: c.denials },
    }
    const d = deps.decisions.insert({
      id: deps.ids.next(),
      kind: 'amendment',
      title: checkTitle(`Add ${c.tool} to the authority of program ${program.name}?`),
      body: bodyOf(c, program),
      agentId: program.agentId,
      sessionId: null,
      programId: program.id,
      payload,
      waitId: null,
      createdAt: now,
    })
    changed(deps, d, 'created')
    created.push(d)
  }
  return created
}
