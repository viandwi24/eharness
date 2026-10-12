/** P40 value pass: authority validation, remembered decisions, task titles. Pure, no server. */
import { describe, expect, test } from 'bun:test'
import { isStandDownChoice, memoryPromptSection, subjectOf } from '../src/domain/decision-memory.ts'
import {
  type AuthoritySources,
  EMPTY_AUTHORITY,
  inspectAuthority,
  similarTools,
} from '../src/domain/programs.ts'
import { titleFromText } from '../src/domain/tasks.ts'

const sources: AuthoritySources = {
  connections: [
    {
      connectionId: 'conn-1',
      connectorId: 'mcp-remote',
      slug: 'tracker-demo',
      toolPrefix: 'tracker_demo',
      label: 'Tracker demo',
    },
  ],
  tools: [
    {
      name: 'tracker_demo_list_tasks',
      connectorId: 'mcp-remote',
      connectionIds: ['conn-1'],
      kind: 'read',
      off: false,
      pinned: false,
    },
    {
      name: 'tracker_demo_update_task',
      connectorId: 'mcp-remote',
      connectionIds: ['conn-1'],
      kind: 'write',
      off: false,
      pinned: true,
    },
  ],
  definitionIds: ['mcp-remote', 'github'],
  availability: {
    available: new Set(['tracker_demo_list_tasks', 'tracker_demo_update_task', 'read_file']),
    channelTools: [],
    channelsBound: false,
  },
}

describe('inspectAuthority', () => {
  test('a tool prefix that names one connection is repaired to its id', () => {
    const r = inspectAuthority({ ...EMPTY_AUTHORITY, connectors: ['tracker-demo'] }, sources)
    expect(r.errors).toEqual([])
    expect(r.authority.connectors).toEqual(['conn-1'])
    expect(r.repaired).toEqual([{ from: 'tracker-demo', to: 'conn-1' }])
    const tools = r.grant.connectors[0]?.tools ?? []
    expect(tools.map((t) => [t.name, t.status])).toEqual([
      ['tracker_demo_list_tasks', 'granted'],
      ['tracker_demo_update_task', 'gate'],
    ])
  })

  test('real ids are kept; unknown and not-enabled connectors are refused with the options', () => {
    expect(
      inspectAuthority({ ...EMPTY_AUTHORITY, connectors: ['mcp-remote'] }, sources).errors,
    ).toEqual([])
    const unknown = inspectAuthority({ ...EMPTY_AUTHORITY, connectors: ['nope'] }, sources)
    expect(unknown.errors[0]).toContain('conn-1')
    const off = inspectAuthority({ ...EMPTY_AUTHORITY, connectors: ['github'] }, sources)
    expect(off.errors[0]).toContain('not have enabled')
  })

  test('a mistyped tool is an error with a suggestion; an unrelated unknown one is not', () => {
    const typo = inspectAuthority(
      { ...EMPTY_AUTHORITY, tools: ['tracker_demo_list_task'] },
      sources,
    )
    expect(typo.errors[0]).toContain('tracker_demo_list_tasks')
    const other = inspectAuthority({ ...EMPTY_AUTHORITY, tools: ['zzz_unrelated'] }, sources)
    expect(other.errors).toEqual([])
    expect(other.grant.tools[0]?.status).toBe('unavailable')
    expect(similarTools('list_tasks', ['tracker_demo_list_tasks'])).toEqual([
      'tracker_demo_list_tasks',
    ])
  })
})

describe('remembered decisions', () => {
  test('stand-down answers are recognised', () => {
    for (const c of ['Keep waiting', 'Skip this', 'Not now', 'Ignore it'])
      expect(isStandDownChoice(c)).toBe(true)
    for (const c of ['Escalate to the CEO', 'Reassign to Budi'])
      expect(isStandDownChoice(c)).toBe(false)
  })
  test('the subject is the record id of the title, else the title', () => {
    expect(subjectOf('T-05 is blocked and overdue')).toBe('T-05')
    expect(subjectOf('Release gate stuck 2026-10-12')).toBe('release gate stuck')
  })
  test('only unexpired answers reach the run prompt', () => {
    const base = {
      id: 'a',
      programId: 'p',
      subject: 'T-05',
      question: 'q',
      choice: 'Keep waiting',
      note: '',
      decisionId: 'd',
      decidedAt: 1_000,
    }
    expect(memoryPromptSection([{ ...base, expiresAt: 5_000 }], 2_000).join('\n')).toContain(
      'T-05: "Keep waiting"',
    )
    expect(memoryPromptSection([{ ...base, expiresAt: 1_500 }], 2_000)).toEqual([])
  })
})

describe('titleFromText', () => {
  test('never the raw prompt: skips role boilerplate, markdown and cuts at the sentence', () => {
    expect(
      titleFromText(
        'You are producing a SOURCED RESEARCH BRIEF.\n\n## Task: Weekly metrics review vs live dashboard\nMore detail follows.',
      ),
    ).toBe('Weekly metrics review vs live dashboard')
    expect(titleFromText('Summarise the overnight changes. Then list what needs me.')).toBe(
      'Summarise the overnight changes',
    )
    expect(titleFromText('x'.repeat(200)).length).toBe(80)
    expect(titleFromText('')).toBe('Task')
  })
})
