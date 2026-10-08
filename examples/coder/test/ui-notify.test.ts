import { describe, expect, test } from 'bun:test'
import { notify, setTerminalTitle } from '../src/ui/notify.ts'

function rig(env: NodeJS.ProcessEnv = {}, platform = 'linux') {
  const out: string[] = []
  const spawned: Array<[string, string[]]> = []
  return {
    out,
    spawned,
    io: {
      write: (d: string) => void out.push(d),
      spawn: (c: string, a: string[]) => void spawned.push([c, a]),
      env,
      platform,
    },
  }
}

describe('notify', () => {
  test('off writes nothing', () => {
    const r = rig()
    notify('hi', 'off', r.io)
    expect(r.out).toEqual([])
  })
  test('bell', () => {
    const r = rig()
    notify('hi', 'bell', r.io)
    expect(r.out).toEqual(['\x07'])
  })
  test('desktop writes OSC 9 and OSC 777', () => {
    const r = rig()
    notify('done', 'desktop', r.io)
    expect(r.out).toEqual(['\x1b]9;done\x07', '\x1b]777;notify;coder;done\x07'])
    expect(r.spawned).toEqual([])
  })
  test('Apple Terminal falls back to osascript with escaped quotes', () => {
    const r = rig({ TERM_PROGRAM: 'Apple_Terminal' }, 'darwin')
    notify('say "hi"', 'desktop', r.io)
    expect(r.spawned).toHaveLength(1)
    expect(r.spawned[0]?.[0]).toBe('osascript')
    expect(r.spawned[0]?.[1][1]).toContain('display notification "say \\"hi\\""')
  })
  test('never throws', () => {
    expect(() =>
      notify('x', 'desktop', {
        write: () => {
          throw new Error('boom')
        },
      }),
    ).not.toThrow()
  })
  test('terminal title', () => {
    const r = rig()
    setTerminalTitle('coder · repo', r.io)
    expect(r.out).toEqual(['\x1b]0;coder · repo\x07'])
  })
})
