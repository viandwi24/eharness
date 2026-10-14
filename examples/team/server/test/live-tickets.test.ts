import { describe, expect, test } from 'bun:test'
import { issueLiveTicket, liveProfileOf, takeLiveTicket } from '../src/http/live-tickets.ts'

describe('live view tickets', () => {
  test('one use, bound to the profile, expire after a minute', () => {
    const a = issueLiveTicket('p1', 1000)
    expect(takeLiveTicket(a.ticket, 'p2', 1001)).toBe(false) // wrong profile, and it is gone now
    expect(takeLiveTicket(a.ticket, 'p1', 1001)).toBe(false)
    const b = issueLiveTicket('p1', 1000)
    expect(takeLiveTicket(b.ticket, 'p1', 1001)).toBe(true)
    expect(takeLiveTicket(b.ticket, 'p1', 1002)).toBe(false) // used once
    const c = issueLiveTicket('p1', 1000)
    expect(takeLiveTicket(c.ticket, 'p1', 1000 + 60_001)).toBe(false) // expired
    expect(takeLiveTicket(undefined, 'p1')).toBe(false)
  })
  test('only the live path takes a ticket', () => {
    expect(liveProfileOf('/browser/profiles/abc/live')).toBe('abc')
    expect(liveProfileOf('/browser/profiles/abc')).toBeUndefined()
    expect(liveProfileOf('/browser/profiles/abc/live/x')).toBeUndefined()
  })
})
