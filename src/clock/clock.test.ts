import { describe, expect, test } from 'bun:test'
import { defineHarnessAgent } from '../index.ts'
import { inMemoryMessages, inMemoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import {
  addToMoment,
  clock,
  diffMoments,
  durationWords,
  formatInZone,
  fromZoned,
  isValidTimeZone,
  offsetLabel,
  parseMoment,
  runDatetime,
  zonedParts,
} from './index.ts'

const NY = 'America/New_York'
const JKT = 'Asia/Jakarta'
const utc = (s: string): number => Date.parse(s)

describe('time helpers', () => {
  test('isValidTimeZone', () => {
    expect(isValidTimeZone(NY)).toBe(true)
    expect(isValidTimeZone('Mars/Olympus')).toBe(false)
  })

  test('zonedParts and offsets, with and without DST', () => {
    expect(zonedParts(utc('2026-10-13T02:41:07Z'), JKT)).toMatchObject({
      year: 2026,
      month: 10,
      day: 13,
      hour: 9,
      minute: 41,
      second: 7,
      weekday: 2,
    })
    expect(offsetLabel(utc('2026-07-01T00:00:00Z'), JKT)).toBe('UTC+07:00')
    expect(offsetLabel(utc('2026-07-01T00:00:00Z'), NY)).toBe('UTC-04:00')
    expect(offsetLabel(utc('2026-01-01T00:00:00Z'), NY)).toBe('UTC-05:00')
    expect(formatInZone(utc('2026-10-13T02:41:07Z'), JKT)).toBe(
      'Tuesday 2026-10-13 09:41:07 Asia/Jakarta (UTC+07:00)',
    )
  })

  test('fromZoned: gap resolves forward, overlap resolves to the first', () => {
    // 2026-03-08 02:30 does not exist in New York: 03:30 EDT
    const gap = fromZoned({ year: 2026, month: 3, day: 8 }, { hour: 2, minute: 30 }, NY)
    expect(new Date(gap).toISOString()).toBe('2026-03-08T07:30:00.000Z')
    // 2026-11-01 01:30 happens twice: the first is EDT (05:30Z)
    const overlap = fromZoned({ year: 2026, month: 11, day: 1 }, { hour: 1, minute: 30 }, NY)
    expect(new Date(overlap).toISOString()).toBe('2026-11-01T05:30:00.000Z')
    const plain = fromZoned({ year: 2026, month: 6, day: 1 }, { hour: 9, minute: 0 }, JKT)
    expect(new Date(plain).toISOString()).toBe('2026-06-01T02:00:00.000Z')
  })

  test('addToMoment keeps the wall clock across DST', () => {
    const start = fromZoned({ year: 2026, month: 3, day: 7 }, { hour: 9, minute: 0 }, NY)
    const next = addToMoment(start, NY, { days: 1 })
    expect(zonedParts(next, NY)).toMatchObject({ day: 8, hour: 9, minute: 0 })
    // 23 real hours, because the day is one hour short
    expect(next - start).toBe(23 * 3_600_000)
    // hours are exact
    expect(addToMoment(start, NY, { hours: 24 }) - start).toBe(24 * 3_600_000)
  })

  test('months clamp to the last day, negative months wrap years', () => {
    const jan31 = fromZoned({ year: 2026, month: 1, day: 31 }, { hour: 10, minute: 0 }, JKT)
    expect(zonedParts(addToMoment(jan31, JKT, { months: 1 }), JKT)).toMatchObject({
      month: 2,
      day: 28,
    })
    expect(zonedParts(addToMoment(jan31, JKT, { months: -2 }), JKT)).toMatchObject({
      year: 2025,
      month: 11,
      day: 30,
    })
  })

  test('diffMoments and durationWords', () => {
    const a = fromZoned({ year: 2026, month: 3, day: 7 }, { hour: 23, minute: 0 }, NY)
    const b = fromZoned({ year: 2026, month: 3, day: 8 }, { hour: 23, minute: 0 }, NY)
    expect(diffMoments(a, b, NY)).toEqual({ ms: 23 * 3_600_000, minutes: 1380, calendarDays: 1 })
    expect(durationWords(90_061_000)).toBe('1 day 1 hour 1 minute')
    expect(durationWords(5_000)).toBe('0 minutes')
  })

  test('parseMoment formats and bad input', () => {
    const now = utc('2026-10-13T00:00:00Z')
    expect(parseMoment('now', JKT, now)).toBe(now)
    expect(parseMoment('2026-10-13', JKT, now)).toBe(utc('2026-10-12T17:00:00Z'))
    expect(parseMoment('2026-10-13 09:00:30', JKT, now)).toBe(utc('2026-10-13T02:00:30Z'))
    expect(parseMoment('2026-10-13T09:00:00+02:00', JKT, now)).toBe(utc('2026-10-13T07:00:00Z'))
    expect(parseMoment('2026-02-30', JKT, now)).toBeUndefined()
    expect(parseMoment('2026-10-13 25:00', JKT, now)).toBeUndefined()
    expect(parseMoment('tomorrow', JKT, now)).toBeUndefined()
  })
})

describe('runDatetime', () => {
  const now = utc('2026-10-13T02:41:07Z')
  test('now shows the default zone, a second zone and UTC', () => {
    const out = runDatetime({ zone: NY }, JKT, now)
    expect(out).toContain('Default time: Tuesday 2026-10-13 09:41:07 Asia/Jakarta')
    expect(out).toContain('America/New_York: Monday 2026-10-12 22:41:07')
    expect(out).toContain('UTC: 2026-10-13T02:41:07Z')
  })

  test('invalid zones and moments return error strings', () => {
    expect(runDatetime({ zone: 'Nope/Zone' }, JKT, now)).toStartWith('ERROR: unknown timezone')
    expect(runDatetime({ from_zone: 'Nope' }, JKT, now)).toStartWith('ERROR: unknown timezone')
    expect(runDatetime({ action: 'convert', time: 'soon' }, JKT, now)).toStartWith(
      'ERROR: could not read time',
    )
    expect(runDatetime({ action: 'add', time: 'now' }, JKT, now)).toStartWith('ERROR: add needs')
    // an invalid default zone falls back to UTC instead of throwing
    expect(runDatetime({}, 'Nope', now)).toContain('Default timezone: UTC')
  })

  test('add and diff', () => {
    const add = runDatetime(
      { action: 'add', time: '2026-03-07 09:00', from_zone: NY, days: 1 },
      NY,
      now,
    )
    expect(add).toContain('Sunday 2026-03-08 09:00:00 America/New_York (UTC-04:00)')
    const diff = runDatetime(
      { action: 'diff', time: '2026-10-13 09:00', to: '2026-10-12 09:00' },
      JKT,
      now,
    )
    expect(diff).toContain('The second moment is earlier by: 1 day')
    expect(diff).toContain('Calendar days apart (default timezone): -1')
  })
})

describe('clock plugin', () => {
  test('the model calls datetime with an async timezone', async () => {
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'datetime', input: { action: 'now' } }] },
      { text: 'done' },
    ])
    const agent = defineHarnessAgent({
      model,
      contextWindow: 100_000,
      storage: { messages: inMemoryMessages(), state: inMemoryState() },
      plugins: [clock({ timezone: async () => JKT, now: () => utc('2026-10-13T02:41:07Z') })],
    })
    await agent.session('s').send('time?').result
    expect(JSON.stringify(model.calls[1]?.prompt)).toContain('Tuesday 2026-10-13 09:41:07')
    expect(model.calls[0]?.tools?.map((t) => t.name)).toContain('datetime')
  })

  test('toolName renames the tool', async () => {
    const model = scriptedModel([{ text: 'x' }])
    const agent = defineHarnessAgent({
      model,
      contextWindow: 100_000,
      storage: { messages: inMemoryMessages(), state: inMemoryState() },
      plugins: [clock({ timezone: 'UTC', toolName: 'time' })],
    })
    await agent.session('s').send('hi').result
    expect(model.calls[0]?.tools?.map((t) => t.name)).toEqual(['time'])
  })
})
