import { describe, expect, test } from 'bun:test'
import { DomainError } from '../src/domain/errors.ts'
import { createChangeFeed } from '../src/infra/eh/change-feed.ts'
import { mapConfigError } from '../src/infra/eh/config-errors.ts'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('change feed', () => {
  test('one poller calls each handler for events of other instances only', async () => {
    const events: Array<{ seq: number; type: string; payload: Record<string, unknown> }> = []
    const feed = {
      lastSeq: () => events.length,
      events: (after: number, limit: number) => events.filter((e) => e.seq > after).slice(0, limit),
    }
    const changes = createChangeFeed({ feed, instance: 'me', pollMs: 5, warn: () => undefined })
    const seen: string[] = []
    changes.on('providers-changed', () => void seen.push('providers'))
    changes.on('connectors-changed', () => {
      seen.push('connectors')
      throw new Error('a failing handler does not stop the others')
    })
    changes.on('providers-changed', () => void seen.push('providers 2'))
    events.push({ seq: 1, type: 'providers-changed', payload: { instance: 'me' } })
    events.push({ seq: 2, type: 'connectors-changed', payload: { instance: 'other' } })
    events.push({ seq: 3, type: 'file-changed', payload: {} })
    await wait(40)
    changes.close()
    expect(seen).toEqual(['connectors'])
    // other instance: both handlers of a type run, once per poll
    const again = createChangeFeed({ feed, instance: 'me', pollMs: 5, warn: () => undefined })
    again.on('providers-changed', () => void seen.push('p1'))
    again.on('providers-changed', () => void seen.push('p2'))
    events.push({ seq: 4, type: 'providers-changed', payload: { instance: 'other' } })
    events.push({ seq: 5, type: 'providers-changed', payload: { instance: 'other' } })
    await wait(40)
    again.close()
    expect(seen.slice(1)).toEqual(['p1', 'p2'])
  })
})

describe('mapConfigError', () => {
  const names = {
    noun: 'thing',
    idKey: 'id',
    notFoundReasons: ['gone'],
    conflicts: { 'read-only': 'READ_ONLY' },
  }
  const raise = (reason: string): unknown => {
    try {
      mapConfigError(
        { code: 'EH_CONFIG_INVALID', message: 'm', details: { reason, id: 'x' } },
        names,
      )
    } catch (error) {
      return error
    }
  }
  test('maps reasons to domain errors', () => {
    expect(raise('gone')).toMatchObject({ code: 'NOT_FOUND' })
    expect(raise('read-only')).toMatchObject({ code: 'READ_ONLY' })
    expect(raise('bad-field')).toMatchObject({ code: 'BAD_FIELD' })
    expect(raise('gone')).toBeInstanceOf(DomainError)
    expect(() => mapConfigError(new TypeError('x'), names)).toThrow(TypeError)
  })
})
