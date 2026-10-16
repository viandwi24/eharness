/**
 * A change proposal (`propose_plan` with `program`) amends an existing program instead of creating
 * a second one: same id, schedule, notes and runs. Also the guards that refuse a new program with
 * the name of an existing one (at proposal and at approval). No model calls.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedModel } from 'eharness/testing'
import {
  approveDecision,
  getDecision,
  proposeFromAgent,
  rejectDecision,
} from '../src/app/decisions.ts'
import type { Deps } from '../src/app/ports.ts'
import { createProgram, deleteProgram, updateProgram } from '../src/app/programs.ts'
import type { Decision } from '../src/domain/decisions.ts'
import { compose, type Server } from '../src/main.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(): { deps: Deps; agentId: string; slug: string } {
  const dir = mkdtempSync(join(tmpdir(), 'team-changes-'))
  dirs.push(dir)
  const server = compose({
    dbFile: join(dir, 'team.db'),
    instanceId: 'changes-test',
    models: { provider: 'scripted', defaultModel: 'none', resolve: () => scriptedModel([]) },
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
  })
  servers.push(server)
  const agent = server.deps.agents.getBySlug('researcher')
  if (agent === undefined) throw new Error('seed missing')
  return { deps: server.deps, agentId: agent.id, slug: 'researcher' }
}

const propose = (
  deps: Deps,
  agentId: string,
  input: Partial<Parameters<typeof proposeFromAgent>[1]> & { title: string },
): ReturnType<typeof proposeFromAgent> =>
  proposeFromAgent(deps, {
    agentId,
    sessionId: null,
    runner: 'researcher',
    runOnce: false,
    program: {},
    ...input,
  })

function existing(deps: Deps, agentId: string, name = 'Weekly review') {
  const program = createProgram(deps, {
    agentId,
    name,
    brief: 'Review the library.',
    authority: { read: ['/library/**'] },
    trigger: { kind: 'schedule', spec: { kind: 'every', everyMs: 3_600_000 } },
    gates: ['sending email'],
  })
  updateProgram(deps, program.id, {})
  deps.programs.update(program.id, { notes: ['warn once'] }, deps.clock.now())
  return program
}

describe('change proposals', () => {
  test('approving adds authority to the same program and keeps id, notes and schedule', async () => {
    const { deps, agentId } = setup()
    const program = existing(deps, agentId)
    const { decision, duplicate } = propose(deps, agentId, {
      title: 'Add web access',
      target: program.name,
      addAuthority: { tools: ['web_fetch', 'web_search'], write: ['/library/reports/**'] },
      program: { gates: ['sending email', 'spending money'] },
    })
    expect(duplicate).toBe(false)
    expect(decision.kind).toBe('change')
    const d = decision as Extract<Decision, { kind: 'change' }>
    expect(d.programId).toBe(program.id)
    expect(d.payload.diff.map((l) => l.field).sort()).toEqual(['authority', 'gates'])
    expect(d.payload.diff.find((l) => l.field === 'authority')?.after).toContain('use web_fetch')
    // nothing happens before the decision
    expect(deps.programs.get(program.id)?.authority.tools).toEqual([])

    const approved = await approveDecision(deps, d.id, { note: 'ok' })
    expect(approved).toMatchObject({ status: 'approved', decidedBy: 'client' })
    expect(approved.outcome).toMatchObject({ decision: 'approved', programId: program.id })
    const after = deps.programs.get(program.id)
    expect(after?.authority.tools).toEqual(['web_fetch', 'web_search'])
    expect(after?.authority.read).toEqual(['/library/**'])
    expect(after?.authority.write).toEqual(['/library/reports/**'])
    expect(after?.gates).toEqual(['sending email', 'spending money'])
    expect(after?.notes).toEqual(['warn once'])
    expect(after?.trigger).toEqual(program.trigger)
    expect(deps.programs.list({})).toHaveLength(1)
  })

  test('removing authority and rejecting leaves the program unchanged', async () => {
    const { deps, agentId } = setup()
    const program = existing(deps, agentId)
    const { decision } = propose(deps, agentId, {
      title: 'Narrow',
      target: program.id,
      removeAuthority: { read: ['/library/**'] },
    })
    const before = deps.programs.get(program.id)
    const rejected = await rejectDecision(deps, decision.id, { note: 'no' })
    expect(rejected.status).toBe('rejected')
    expect(deps.programs.get(program.id)?.authority.read).toEqual(['/library/**'])
    expect(deps.programs.get(program.id)?.updatedAt).toBe(before?.updatedAt as number)
  })

  test('a change that changes nothing, renames, or sends a full authority is refused', () => {
    const { deps, agentId } = setup()
    const program = existing(deps, agentId)
    const base = { title: 'x', target: program.id }
    expect(() =>
      propose(deps, agentId, { ...base, program: { gates: ['sending email'] } }),
    ).toThrow(/Nothing to change/)
    expect(() => propose(deps, agentId, { ...base, program: { name: 'Other' } })).toThrow(
      /cannot rename/,
    )
    expect(() =>
      propose(deps, agentId, { ...base, program: { authority: { tools: ['web_fetch'] } } }),
    ).toThrow(/addAuthority/)
  })

  test('a proposal id that became a program resolves; an unknown program is refused', async () => {
    const { deps, agentId } = setup()
    const first = propose(deps, agentId, {
      title: 'Daily check',
      program: { name: 'Daily check', brief: 'Check.' },
    }).decision
    const approved = await approveDecision(deps, first.id)
    const { decision } = propose(deps, agentId, {
      title: 'tweak',
      target: first.id,
      program: { escalation: 'Ask when unsure.' },
    })
    expect(decision.programId).toBe(approved.programId as string)
    expect(() =>
      propose(deps, agentId, { title: 'x', target: 'nope', program: { escalation: 'y' } }),
    ).toThrow(/nope/)
  })

  test('approving fails readably when the program was deleted or changed meanwhile', async () => {
    const { deps, agentId } = setup()
    const a = existing(deps, agentId, 'Alpha')
    const b = existing(deps, agentId, 'Beta')
    const da = propose(deps, agentId, {
      title: 'a',
      target: a.id,
      program: { escalation: 'Ask first.' },
    }).decision
    const db = propose(deps, agentId, {
      title: 'b',
      target: b.id,
      program: { escalation: 'Ask first.' },
    }).decision
    deleteProgram(deps, a.id)
    await expect(approveDecision(deps, da.id)).rejects.toThrow(/was deleted/)
    updateProgram(deps, b.id, { escalation: 'Something else.' })
    await expect(approveDecision(deps, db.id)).rejects.toThrow(/changed after this was proposed/)
    // both stay open: nothing was half decided
    expect(getDecision(deps, da.id).status).toBe('open')
    expect(getDecision(deps, db.id).status).toBe('open')
    // a note edit does not block it
    const c = existing(deps, agentId, 'Gamma')
    const dc = propose(deps, agentId, {
      title: 'c',
      target: c.id,
      program: { escalation: 'Ask first.' },
    }).decision
    deps.programs.update(c.id, { notes: ['new agreement'] }, deps.clock.now())
    expect((await approveDecision(deps, dc.id)).status).toBe('approved')
  })
})

describe('duplicate programs', () => {
  test('a new proposal with the name of an existing program is refused with the change hint', () => {
    const { deps, agentId } = setup()
    const program = existing(deps, agentId)
    for (const name of ['Weekly review', '  weekly REVIEW ']) {
      expect(() =>
        propose(deps, agentId, { title: 'More access', program: { name, brief: 'B' } }),
      ).toThrow(
        `A program named ${program.name} already exists (id ${program.id}). To change it, call propose_plan with program: '${program.id}' and only the fields to change.`,
      )
    }
    // an amendment-like title that names the program
    expect(() =>
      propose(deps, agentId, {
        title: 'Amendment: Weekly review - add web',
        program: { name: 'Weekly review v2', brief: 'B' },
      }),
    ).toThrow(/already exists/)
    // another agent may use the name
    expect(() =>
      proposeFromAgent(deps, {
        agentId,
        sessionId: null,
        runner: 'writer',
        title: 'Same name elsewhere',
        runOnce: false,
        program: { name: 'Weekly review', brief: 'B' },
      }),
    ).not.toThrow()
  })

  test('approving a proposal whose name now duplicates a program is refused', async () => {
    const { deps, agentId } = setup()
    const d = propose(deps, agentId, {
      title: 'New',
      program: { name: 'Daily check', brief: 'Check.' },
    }).decision
    existing(deps, agentId, 'Daily check')
    await expect(approveDecision(deps, d.id)).rejects.toThrow(/already exists/)
    expect(getDecision(deps, d.id).status).toBe('open')
    expect(deps.programs.list({})).toHaveLength(1)
  })
})
