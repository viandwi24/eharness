import { describe, expect, test } from 'bun:test'
import {
  canIsolateUids,
  createUidPool,
  isolationInfo,
  killUidArgv,
  setprivArgs,
  wrapperScript,
} from '../src/isolation.ts'

describe('uid pool', () => {
  test('hands out distinct uids, reuses released ones, runs dry', () => {
    const pool = createUidPool(20_000, 2)
    expect(pool.acquire()).toBe(20_000)
    expect(pool.acquire()).toBe(20_001)
    expect(pool.acquire()).toBeNull()
    pool.release(20_000)
    expect(pool.inUse()).toBe(1)
    expect(pool.acquire()).toBe(20_000)
  })
  test('rejects a bad base or size', () => {
    expect(() => createUidPool(0, 1)).toThrow()
    expect(() => createUidPool(20_000, 0)).toThrow()
  })
})

describe('command wrapping', () => {
  test('setpriv drops uid, gid, groups and privileges', () => {
    expect(setprivArgs(20_007)).toEqual([
      '--reuid=20007',
      '--regid=20007',
      '--clear-groups',
      '--no-new-privs',
      '--',
    ])
  })
  test('the wrapper script reads the uid from the environment and drops privileges', () => {
    const s = wrapperScript()
    expect(s).toContain('uid="$EH_SANDBOX_UID"')
    expect(s).toContain('unset EH_SANDBOX_UID')
    expect(s).toContain(
      'exec setpriv --reuid="$uid" --regid="$uid" --clear-groups --no-new-privs -- /bin/bash "$@"',
    )
    expect(s).toContain('-ge 1000')
  })
  test('kill argv runs as the uid itself', () => {
    expect(killUidArgv(20_002)).toEqual([
      'setpriv',
      '--reuid=20002',
      '--regid=20002',
      '--clear-groups',
      '--no-new-privs',
      '--',
      '/bin/sh',
      '-c',
      'kill -9 -1',
    ])
  })
})

describe('mode and honesty', () => {
  test('uids need root on Linux', () => {
    expect(canIsolateUids('linux', 0)).toBe(true)
    expect(canIsolateUids('linux', 10_001)).toBe(false)
    expect(canIsolateUids('darwin', 0)).toBe(false)
    expect(canIsolateUids('linux', undefined)).toBe(false)
  })
  test('isolation info states the mode', () => {
    expect(isolationInfo({ uids: true, osSandbox: false })).toEqual({
      isolated: true,
      label: 'sandbox-server container, one user per session',
    })
    expect(isolationInfo({ uids: false, osSandbox: false })).toEqual({
      isolated: false,
      label: 'sandbox-server, shared user (not isolated between sessions)',
    })
    expect(isolationInfo({ uids: false, osSandbox: true }).isolated).toBe(true)
  })
})
