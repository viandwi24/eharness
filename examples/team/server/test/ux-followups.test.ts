/**
 * UX follow-ups (not run by the author, see the report): reminders for web-chat agents, the
 * instruction marker, the auto-allowed marker, escalation stand-down options, plan card words
 * (server side), the Telegram login copy and the account limit defaults.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webCryptoVault } from 'eharness/providers'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import { createEscalation } from '../src/app/decisions.ts'
import { withoutCenterHints } from '../src/domain/decisions.ts'
import { LEAD_PLAYBOOK } from '../src/domain/prompts.ts'
import { USER_GOVERNOR } from '../src/infra/channels/governor.ts'
import { RateLimitsSchema } from '../src/infra/channels/policy.ts'
import { webReminderSession } from '../src/infra/channels/reminders.ts'
import { openDatabase } from '../src/infra/db/client.ts'
import {
  clearInstruction,
  isInstruction,
  markInstruction,
  withInstruction,
} from '../src/infra/eh/instruction-marks.ts'
import { autoAllowedVia, markAutoAllowed } from '../src/infra/eh/permission-plugin.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { sqliteMessages } from '../src/infra/eh/storage.ts'
import { describeErrorTitled, errorTitle } from '../src/infra/telegram-user/errors.ts'
import {
  accountLimitDefaults,
  paceOf,
  paceOverrides,
  USER_RATE_DEFAULTS,
} from '../src/infra/telegram-user/service.ts'
import { compose, type Server } from '../src/main.ts'
import { postAs, userMessage } from './support/http.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 6000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(15)
  }
}
const TUNING = { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 }
const wire = (m: ScriptedModel): string => JSON.stringify(m.prompts)
const call = (toolName: string, input: Record<string, unknown>, id: string): ScriptedStepInput => ({
  toolCalls: [{ toolName, input, toolCallId: id }],
})

function instance(steps: ScriptedStepInput[]): {
  server: Server
  lead: ScriptedModel
  leadId: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'team-ux-'))
  dirs.push(dir)
  const lead = scriptedModel(steps)
  const config: ModelConfig = {
    provider: 'scripted',
    defaultModel: 'none',
    resolve: (id) =>
      id === 'm-lead'
        ? lead
        : scriptedModel([
            () => {
              throw new Error(`unexpected model call: ${id}`)
            },
          ]),
  }
  const server = compose({
    dbFile: join(dir, 'team.db'),
    instanceId: 'ux-test',
    models: config,
    env: {},
    tuning: TUNING,
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    channels: {
      vault: webCryptoVault(new Uint8Array(32).fill(9)),
      purgeEveryMs: 0,
      maintenanceMs: 0,
    },
  })
  servers.push(server)
  const def = server.deps.agents.getBySlug('lead')
  if (def === undefined) throw new Error('seed missing')
  updateAgent(server.deps, def.id, { model: 'm-lead' })
  return { server, lead, leadId: def.id }
}

describe('reminders for web-chat agents', () => {
  test('the lead sets a reminder in its thread without approval; it fires into the thread and the bell, no model call', async () => {
    const { server, lead, leadId } = instance([
      call(
        'reminder',
        { action: 'create', message: 'Time to stand up', request: 'remind me', inMinutes: 3 },
        'w1',
      ),
      { text: 'Set for you.' },
    ])
    await (
      await server.app.request(
        '/sessions/dm:lead/chat',
        postAs('dm:lead', userMessage('remind me in 3 minutes to stand up')),
      )
    ).text()
    expect(wire(lead)).toContain('Reminder set (id ')
    // the prompt names propose_plan (to say a reminder is not a plan); what matters is it is never called
    expect(wire(lead)).not.toContain('"toolName":"propose_plan"')
    const [rem] = server.channels.reminders.list('web')
    expect(rem?.status).toBe('active')
    expect(webReminderSession(rem as NonNullable<typeof rem>)).toBe(`dm:${leadId}`)
    expect(rem?.agentId).toBe(leadId)
    // it is on the Routines page next to the channel reminders
    const page = (await (await server.app.request('/routines')).json()) as {
      reminders: Array<{ id: string; connectionId: string; sessionId?: string; place: string }>
    }
    expect(page.reminders.find((r) => r.id === rem?.id)).toMatchObject({
      connectionId: 'web',
      sessionId: `dm:${leadId}`,
      place: 'This chat',
    })
    const calls = lead.prompts.length
    await server.routines.tick(Date.now() + 4 * 60_000)
    await until('the reminder lands in the thread', async () =>
      JSON.stringify(
        await (await server.app.request('/sessions/dm:lead/messages?limit=50')).json(),
      ).includes('Reminder: Time to stand up'),
    )
    expect(
      server.deps.notifications.list({ open: true, limit: 20 }).some((n) => n.title === 'Reminder'),
    ).toBe(true)
    expect(lead.prompts.length).toBe(calls)
    expect(server.channels.reminders.get(rem?.id as string)?.status).toBe('done')
  })

  test('a repeating reminder shows its next fire on the Routines page', async () => {
    const { server } = instance([
      call(
        'reminder',
        { action: 'create', message: 'Time to stand up', time: '17:00', repeat: 'weekdays' },
        'w1',
      ),
      { text: 'Set.' },
    ])
    await (
      await server.app.request(
        '/sessions/dm:lead/chat',
        postAs('dm:lead', userMessage('remind me every weekday at 17:00')),
      )
    ).text()
    const [rem] = server.channels.reminders.list('web', { status: 'active' })
    expect(rem?.schedule.kind).toBe('cron')
    const page = (await (await server.app.request('/routines')).json()) as {
      reminders: Array<{ id: string; nextAt?: number }>
    }
    const next = page.reminders.find((r) => r.id === rem?.id)?.nextAt
    expect(typeof next).toBe('number')
    expect(next as number).toBeGreaterThan(Date.now())
  })

  test('a message that restates the request is refused, cancel works', async () => {
    const { server, lead } = instance([
      call('reminder', { action: 'create', message: 'remind me to stand up', inMinutes: 5 }, 'w1'),
      call('reminder', { action: 'create', message: 'Time to stand up', inMinutes: 5 }, 'w2'),
      call('reminder', { action: 'list' }, 'w3'),
      { text: 'ok' },
    ])
    await (
      await server.app.request('/sessions/dm:lead/chat', postAs('dm:lead', userMessage('go')))
    ).text()
    expect(wire(lead)).toContain('message must be the reminder itself')
    const [rem] = server.channels.reminders.list('web', { status: 'active' })
    expect(rem).toBeDefined()
    server.channels.reminders.cancel(rem?.id as string)
    expect(server.channels.reminders.get(rem?.id as string)?.status).toBe('cancelled')
  })

  test('the lead playbook sends reminders to the reminder tool', () => {
    expect(LEAD_PLAYBOOK).toContain('`reminder` tool')
    expect(LEAD_PLAYBOOK).toContain('Never use')
  })
})

describe('instruction marker', () => {
  test('the next user message of a marked session is flagged, once, and keeps the flag on re-save', async () => {
    const conn = openDatabase(':memory:')
    const store = sqliteMessages(conn.sqlite)
    const msg = (id: string, text: string) => ({
      id,
      role: 'user' as const,
      parts: [{ type: 'text' as const, text }],
    })
    markInstruction('task:t1:1')
    await store.save('task:t1:1', [msg('m1', 'do the thing')])
    await store.save('task:t1:1', [msg('m2', 'a person replies')])
    const [a, b] = await store.load({ sessionId: 'task:t1:1' })
    expect(isInstruction(a?.metadata)).toBe(true)
    expect(isInstruction(b?.metadata)).toBe(false)
    // an in-memory copy without the flag, saved again, keeps it
    await store.save('task:t1:1', [msg('m1', 'do the thing')])
    expect(isInstruction((await store.load({ sessionId: 'task:t1:1' }))[0]?.metadata)).toBe(true)
    // a mark does not outlive its send
    await withInstruction('task:t2:1', async () => {})
    await store.save('task:t2:1', [msg('x', 'person')])
    expect(isInstruction((await store.load({ sessionId: 'task:t2:1' }))[0]?.metadata)).toBe(false)
    clearInstruction('task:t1:1')
    conn.close()
  })
})

describe('auto-allowed marker', () => {
  test('marks the tool calls of an assistant message that were let through', () => {
    const auto = new Map([['c1', autoAllowedVia('plugin:permissions', 'manual')]])
    const out = markAutoAllowed(
      {
        id: 'a',
        role: 'assistant',
        parts: [{ type: 'tool-read_file', toolCallId: 'c1' }, { type: 'text' }],
      },
      auto,
    )
    expect((out as { metadata?: unknown } | undefined)?.metadata).toEqual({
      app: { autoAllowed: { c1: 'rule' } },
    })
    expect(autoAllowedVia('grant', 'manual')).toBe('grant')
    expect(autoAllowedVia('plugin:permissions', 'bypass')).toBe('mode')
    expect(markAutoAllowed({ id: 'a', role: 'user', parts: [] }, auto)).toBeUndefined()
    expect(
      markAutoAllowed({ id: 'a', role: 'assistant', parts: [{ type: 'text' }] }, auto),
    ).toBeUndefined()
  })
})

describe('escalation payload', () => {
  test('standDown lists the flagged options and the ones on the fallback word list', () => {
    const { server, leadId } = instance([])
    const d = createEscalation(server.deps, {
      agentId: leadId,
      sessionId: 'program:p1:1',
      waitId: 'w1',
      title: 'Stock low',
      question: 'What now?',
      options: ['Reorder now', 'Keep waiting', 'Call the supplier'],
      standDown: ['Call the supplier'],
    })
    expect(d.kind === 'escalation' && d.payload.standDown).toEqual([
      'Keep waiting',
      'Call the supplier',
    ])
  })
})

describe('proposal text', () => {
  test('sentences that send the reader to the Decision Center are removed', () => {
    expect(
      withoutCenterHints('Check stock daily.\nApprove or edit it in the Decision Center.'),
    ).toBe('Check stock daily.')
    expect(withoutCenterHints('Plain body.')).toBe('Plain body.')
  })
})

describe('telegram account copy', () => {
  test('error headings match the error; limit defaults are exposed', () => {
    expect(errorTitle({ kind: 'code-invalid', text: 'X' })).toBe('Wrong code')
    expect(errorTitle({ kind: 'code-expired', text: 'X' })).toBe('Code expired')
    expect(errorTitle({ kind: 'flood', seconds: 600, text: 'X' })).toBe(
      'Too many tries, wait 10 min',
    )
    expect(describeErrorTitled({ kind: 'code-invalid', text: 'X' })).toBe(
      'Wrong code: That code is not right.',
    )
    const d = accountLimitDefaults()
    expect(d.dmDailyMax).toBe(30)
    expect(d.groupMax).toBe(USER_RATE_DEFAULTS.groupMax)
    // the pace defaults are the user account governor's
    expect(d.gapAdminMinMs).toBe(USER_GOVERNOR.gap.admin.minMs)
    expect(d.adminPerMinute).toBe(USER_GOVERNOR.admin.perMinute)
    expect(d.parkWaitMs).toBe(USER_GOVERNOR.parkWaitMs)
  })

  test('the pace form writes only what it gives, over what is stored', () => {
    const stored = { read: { burst: 9 }, gap: { edit: { minMs: 500, maxMs: 900 } } }
    const g = paceOverrides(stored, { gapAdminMinMs: 5000, gapAdminMaxMs: 12_000, adminBurst: 1 })
    expect(g).toEqual({
      read: { burst: 9 },
      gap: { edit: { minMs: 500, maxMs: 900 }, admin: { minMs: 5000, maxMs: 12_000 } },
      admin: { burst: 1 },
    })
    // the stored object is not touched
    expect(stored).toEqual({ read: { burst: 9 }, gap: { edit: { minMs: 500, maxMs: 900 } } })
    expect(RateLimitsSchema.safeParse({ governor: g }).success).toBe(true)
    const view = paceOf(g)
    expect(view).toMatchObject({
      gapAdminMinMs: 5000,
      gapAdminMaxMs: 12_000,
      gapEditMinMs: 500,
      adminBurst: 1,
      adminPerMinute: USER_GOVERNOR.admin.perMinute,
    })
  })
})
