/**
 * Only a delegated turn the launcher's `agent` call started directly is foreground: a new chat
 * message stops it. Inbox turns (a background start, a `send_message` resume, a wake) are not,
 * so a running worker is never aborted because somebody wrote in the chat.
 */
import { describe, expect, test } from 'bun:test'
import { delegatedApprovals, isForegroundTurn } from '../src/infra/channels/delegated-approvals.ts'

type Started = { parentSessionId: string; childSessionId: string; foreground: boolean }

function hook(started: Started[]) {
  const plugin = delegatedApprovals({
    gateway: () => ({ delegatedTurnStarted: (s: Started) => started.push(s) }) as never,
    agentOf: () => undefined,
  })
  const def = (
    plugin as unknown as {
      '~def': { setup: (ctx: unknown) => { hooks: Record<string, (ctx: unknown) => void> } }
    }
  )['~def']
  const hooks = def.setup({}).hooks
  return hooks['turn.start'] as (ctx: unknown) => void
}

const ctx = (source: unknown) => ({
  session: {
    id: 'channel:c:n:worker:call_1',
    parent: { sessionId: 'channel:c:n', toolCallId: 'call_1' },
  },
  turn: source === undefined ? {} : { source },
})

describe('delegated turns: foreground or not', () => {
  test('a turn started directly by the agent call is foreground', () => {
    expect(isForegroundTurn(ctx(undefined) as never)).toBe(true)
  })

  test('inbox turns are never foreground: background start, send_message resume, wake', () => {
    const started: Started[] = []
    const start = hook(started)
    start(
      ctx({
        kind: 'inbox',
        id: 'i1',
        key: 'subagent-bg:call_1',
        ids: ['i1'],
        keys: ['subagent-bg:call_1'],
      }),
    )
    start(ctx({ kind: 'inbox', id: 'i2', ids: ['i2'], keys: [] }))
    start(ctx(undefined))
    expect(started.map((s) => s.foreground)).toEqual([false, false, true])
    expect(started[0]).toMatchObject({
      parentSessionId: 'channel:c:n',
      childSessionId: 'channel:c:n:worker:call_1',
    })
  })
})
