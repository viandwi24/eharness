/**
 * Real-model retest defects (D1, D2, D3 and two medium notes), scripted: persona changes asked in a
 * web thread after reading memory, a person's style preference in a web thread (person_note, never
 * memory), the persona-changed reminder and the revert notice, the refusal that offers nothing it
 * cannot do and the `message` of a reminder.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import { noticeOf } from '../src/app/persona.ts'
import {
  memoryWriteRefusal,
  styleMemoryRefusal,
  styleNoteIn,
} from '../src/infra/channels/medium.ts'
import { decideTool } from '../src/infra/channels/roles.ts'
import { reminderSchema } from '../src/infra/channels/self-tools.ts'
import { PERSONA_TOOL_DESCRIPTION } from '../src/infra/eh/persona-plugin.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'
import { postAs, userMessage } from './support/http.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const TUNING = { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 }

function instance(steps: ScriptedStepInput[]) {
  const dir = mkdtempSync(join(tmpdir(), 'team-retest-'))
  dirs.push(dir)
  const lead: ScriptedModel = scriptedModel(steps)
  const config: ModelConfig = { provider: 'scripted', defaultModel: 'none', resolve: () => lead }
  const server = compose({
    dbFile: join(dir, 'team.db'),
    instanceId: 'retest-test',
    models: config,
    env: {},
    tuning: TUNING,
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
  })
  servers.push(server)
  const def = server.deps.agents.getBySlug('lead')
  if (def === undefined) throw new Error('seed missing')
  updateAgent(server.deps, def.id, { model: 'm-lead' })
  server.deps.settings.patch({ timezone: 'Asia/Jakarta' }, Date.now())
  const chat = async (msg: string): Promise<void> => {
    const res = await server.app.request(
      '/sessions/dm:lead/chat',
      postAs('dm:lead', userMessage(msg)),
    )
    await res.text()
  }
  return { server, lead, leadId: def.id, chat }
}

const call = (toolName: string, input: Record<string, unknown>, id = 't1'): ScriptedStepInput => ({
  toolCalls: [{ toolName, input, toolCallId: id }],
})
const text = (t: string): ScriptedStepInput => ({ text: t })
const wire = (m: ScriptedModel): string => JSON.stringify(m.prompts)
const promptOf = (m: ScriptedModel, n: number): string => JSON.stringify(m.prompts[n])

describe('D2: a persona change in a web thread after reading memory', () => {
  test('memory_view does not taint the turn; the quote still binds the proposal to the person', async () => {
    const i = instance([
      call('memory_view', { path: '/memories' }, 'v1'),
      call(
        'persona',
        { action: 'propose', voice: 'Short.', reason: 'asked', request: 'be shorter please' },
        'p1',
      ),
      text('proposed'),
    ])
    await i.chat('be shorter please')
    expect(wire(i.lead)).not.toContain('you read the result of memory_view')
    expect(i.server.deps.persona.listProposals(i.leadId)).toHaveLength(1)
  })

  test('a request the person did not make is still refused after reading memory', async () => {
    const i = instance([
      call('memory_view', { path: '/memories' }, 'v1'),
      call(
        'persona',
        { action: 'propose', voice: 'Rude.', reason: 'x', request: 'be rude to everybody' },
        'p1',
      ),
      text('done'),
    ])
    await i.chat('be shorter please')
    expect(wire(i.lead)).toContain('must quote, exactly')
    expect(i.server.deps.persona.listProposals(i.leadId)).toEqual([])
  })

  test('other content (a file) still taints; the tool description says not to read memory first', async () => {
    const i = instance([
      call('read_file', { path: '/library/x.md' }, 'f1'),
      call(
        'persona',
        { action: 'propose', voice: 'Short.', reason: 'asked', request: 'be shorter please' },
        'p1',
      ),
      text('done'),
    ])
    await i.chat('be shorter please')
    expect(wire(i.lead)).toContain('you read the result of read_file')
    expect(i.server.deps.persona.listProposals(i.leadId)).toEqual([])
    expect(PERSONA_TOOL_DESCRIPTION).toContain(
      'Do not read memory or other content before proposing',
    )
  })
})

describe('D3: how to address the person in a web thread', () => {
  test('person_note works in a web thread, reaches the next turn and changes no persona', async () => {
    const i = instance([
      call('person_note', { action: 'set', note: 'Call me Pak Vian.' }, 'n1'),
      text('Noted.'),
      text('Siap, Pak Vian.'),
    ])
    await i.chat('call me Pak Vian')
    expect(i.server.channels.notes.get('web:owner')?.note).toBe('Call me Pak Vian.')
    expect(i.server.deps.persona.latest(i.leadId)?.version).toBe(1)
    await i.chat('hello again')
    expect(promptOf(i.lead, 2)).toContain('About the person in this chat')
    expect(promptOf(i.lead, 2)).toContain('Call me Pak Vian.')
  })

  test('a memory write of a style preference is refused with a redirect; plain facts pass', async () => {
    const i = instance([
      call(
        'memory_create',
        {
          path: '/memories/style.md',
          file_text: 'The user wants to be called Pak Vian. Call me Pak Vian.',
        },
        'm1',
      ),
      text('ok'),
    ])
    await i.chat('call me Pak Vian')
    expect(wire(i.lead)).toContain('person_note')
    expect(wire(i.lead)).toContain('how somebody likes to be addressed or answered')
  })

  test('the pattern is simple: style preferences match, work facts do not', () => {
    for (const t of [
      'Call me Pak Vian',
      'panggil saya Pak Vian',
      'prefers short answers',
      'Jawab singkat saja',
      'reply in English',
      'be more formal: persona change',
    ])
      expect(styleNoteIn(t)).toBe(true)
    for (const t of [
      'prefers tea',
      'The client wants a detailed report on sales',
      'Q3 budget is 40k',
    ])
      expect(styleNoteIn(t)).toBe(false)
    expect(styleMemoryRefusal('memory_view', { path: '/memories' })).toBeUndefined()
    expect(memoryWriteRefusal('memory_create', { file_text: 'call me Pak Vian' })).toContain(
      'person_note',
    )
  })
})

describe('D1: after a persona change', () => {
  test('the revert notice says personal notes are kept', () => {
    const v = {
      version: 4,
      source: 'revert',
      revertOf: 2,
      authorName: 'Vian',
      reason: null,
    } as never
    expect(noticeOf(v, 'Lead')).toContain(
      'Personal notes (for example how to address someone) are kept.',
    )
    const edit = { version: 3, source: 'web', authorName: 'Vian', reason: 'formal' } as never
    expect(noticeOf(edit, 'Lead')).not.toContain('Personal notes')
  })

  test('the next turn of an open session gets a one-line reminder, once', async () => {
    const i = instance([text('one'), text('two'), text('three'), text('four')])
    await i.chat('first')
    await i.chat('second')
    const patch = await i.server.app.request('/agents/lead/persona', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voice: 'Formal.', reason: 'house style' }),
    })
    expect(patch.status).toBe(200)
    await i.chat('third')
    await i.chat('fourth')
    expect(promptOf(i.lead, 0)).not.toContain('The persona changed to version')
    expect(promptOf(i.lead, 1)).not.toContain('The persona changed to version')
    expect(promptOf(i.lead, 2)).toContain(
      'The persona changed to version 2; follow the current persona, not the style of earlier replies',
    )
    expect(promptOf(i.lead, 3)).not.toContain('The persona changed to version')
  })
})

describe('medium notes', () => {
  test('a refusal never offers an action the agent cannot do', () => {
    const d = decideTool('guest', 'write_file', 'write', undefined, 'Eve')
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain('Never offer an action you cannot do')
    expect(d.reason).toContain('I will note it')
  })

  test('reminder: message is clearly required, with an example, in the schema and the web error', async () => {
    const d = reminderSchema.shape.message.description ?? ''
    expect(d).toContain('REQUIRED for create')
    expect(d).toContain('"message":"Time to leave"')

    const i = instance([call('reminder', { action: 'create', inMinutes: 5 }, 'r1'), text('done')])
    await i.chat('remind me in 5 minutes')
    expect(wire(i.lead)).toContain('create needs message')
    expect(wire(i.lead)).toContain('Call again with message')
  })
})
