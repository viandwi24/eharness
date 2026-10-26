/**
 * The script engine (ADR-0065, P59 W3): TypeScript run in QuickJS inside a Worker, `ctx` calls
 * answered by the host, dry runs, every limit (CPU, memory, wall time, call count, sizes), and
 * escape attempts — a script reaches nothing but `ctx`, and nothing it does reaches the server.
 */
import { describe, expect, test } from 'bun:test'
import { type HostMethodDoc, scriptTypes } from '../src/domain/scripts.ts'
import { type HostHandler, runScript } from '../src/infra/scripts/executor.ts'

const echo: HostHandler = async (args) => ({ got: args })

describe('running scripts', () => {
  test('the event goes in, ctx calls are answered and traced, logs are kept, the result comes back', async () => {
    const sent: unknown[] = []
    const r = await runScript({
      source: `
        interface Msg { chat: string; text: string }
        export default async function (event: { text: string; chat: string }, ctx: any) {
          console.log('got', event.text)
          if (!event.text.toLowerCase().includes('halo')) return { skipped: true }
          const m: Msg = { chat: 'Group B', text: 'new halo message: ' + JSON.stringify(event) }
          const res = await ctx.channels.send(m)
          ctx.log('sent', res.id)
          return { forwarded: res.id }
        }`,
      event: { chat: 'Chat A', text: 'Halo semua' },
      host: {
        'channels.send': async (args) => {
          sent.push(args)
          return { id: 'msg-1' }
        },
      },
    })
    expect(r).toMatchObject({
      outcome: 'ok',
      result: { forwarded: 'msg-1' },
      logs: ['got Halo semua', 'sent msg-1'],
    })
    expect(sent).toEqual([
      { chat: 'Group B', text: 'new halo message: {"chat":"Chat A","text":"Halo semua"}' },
    ])
    expect(r.calls).toEqual([
      expect.objectContaining({ method: 'channels.send', ok: true, result: { id: 'msg-1' } }),
    ])
  })

  test('a plain (not async) default export works; parallel calls resolve', async () => {
    expect(
      (await runScript({ source: 'export default (e) => e.n * 2', event: { n: 21 }, host: {} }))
        .result,
    ).toBe(42)
    const r = await runScript({
      source: `export default async (e, ctx) => {
        const all = await Promise.all([1, 2, 3].map((n) => ctx.tables.get({ n })))
        return all.map((a) => a.got.n)
      }`,
      event: {},
      host: { 'tables.get': echo },
    })
    expect(r).toMatchObject({ outcome: 'ok', result: [1, 2, 3] })
    expect(r.calls).toHaveLength(3)
  })

  test('a host error is the script error; the script may catch it', async () => {
    const host = {
      'library.read': async () => {
        throw new Error('no such file: /library/x.md')
      },
    }
    const caught = await runScript({
      source: `export default async (e, ctx) => { try { await ctx.library.read({ path: '/library/x.md' }) } catch (err) { return 'caught: ' + err.message } }`,
      event: {},
      host,
    })
    expect(caught).toMatchObject({ outcome: 'ok', result: 'caught: no such file: /library/x.md' })
    expect(caught.calls[0]).toMatchObject({ ok: false, error: 'no such file: /library/x.md' })
    const uncaught = await runScript({
      source: `export default async (e, ctx) => { await ctx.library.read({ path: '/x' }) }`,
      event: {},
      host,
    })
    expect(uncaught).toMatchObject({
      outcome: 'error',
      error: 'Error: no such file: /library/x.md',
    })
    const thrown = await runScript({
      source: `export default () => { throw new TypeError('bad input') }`,
      event: {},
      host: {},
    })
    expect(thrown).toMatchObject({ outcome: 'error', error: 'TypeError: bad input' })
  })

  test('a dry run records side effects instead of doing them; reads still run', async () => {
    let sent = 0
    const r = await runScript({
      source: `export default async (e, ctx) => {
        const row = await ctx.tables.get({ id: 1 })
        const res = await ctx.channels.send({ chat: 'B', text: 'hi ' + row.got.id })
        return res
      }`,
      event: {},
      host: {
        'tables.get': echo,
        'channels.send': async () => {
          sent++
          return { id: 'real' }
        },
      },
      dryRun: { sideEffects: new Set(['channels.send']) },
    })
    expect(sent).toBe(0)
    expect(r).toMatchObject({ outcome: 'ok', result: { dryRun: true } })
    expect(r.calls.map((c) => [c.method, c.dryRun === true])).toEqual([
      ['tables.get', false],
      ['channels.send', true],
    ])
    expect(r.calls[1]?.args).toEqual({ chat: 'B', text: 'hi 1' })
  })

  test('scripts that do not compile, import, or have no default export are refused with a sentence', async () => {
    expect(
      (await runScript({ source: 'export default (e) => {\n  return e *\n}', event: {}, host: {} }))
        .error,
    ).toMatch(/does not compile: Unexpected } \(line 3, column 1\)/)
    expect(
      (
        await runScript({
          source: 'import fs from "fs"\nexport default () => fs',
          event: {},
          host: {},
        })
      ).error,
    ).toContain('cannot import modules')
    expect(
      (
        await runScript({
          source: 'export default async () => (await import("fs"))',
          event: {},
          host: {},
        })
      ).error,
    ).toContain('cannot import modules')
    expect((await runScript({ source: 'const x = 1', event: {}, host: {} })).error).toContain(
      'needs a default export',
    )
    expect((await runScript({ source: 'export default 5', event: {}, host: {} })).error).toContain(
      'is not a function',
    )
  })
})

describe('limits', () => {
  test('an endless loop is stopped by the CPU limit', async () => {
    const r = await runScript({
      source: 'export default () => { while (true) {} }',
      event: {},
      host: {},
      limits: { cpuMs: 200 },
    })
    expect(r.outcome).toBe('cpu')
    expect(r.error).toContain('200 ms of CPU time')
  })

  test('an endless loop after an await is stopped too', async () => {
    const r = await runScript({
      source: 'export default async (e, ctx) => { await ctx.x.y({}); for (;;) {} }',
      event: {},
      host: { 'x.y': echo },
      limits: { cpuMs: 200 },
    })
    expect(r.outcome).toBe('cpu')
  })

  test('a memory bomb is stopped by the memory limit', async () => {
    const r = await runScript({
      source: 'export default () => { const a = []; for (;;) a.push("x".repeat(1e5) + a.length) }',
      event: {},
      host: {},
      limits: { memoryMb: 16, cpuMs: 10_000 },
    })
    expect(r.outcome).toBe('memory')
  })

  test('waiting forever is stopped by the wall time; time spent waiting is not CPU', async () => {
    const r = await runScript({
      source: 'export default async (e, ctx) => { await ctx.slow.call({}) }',
      event: {},
      host: { 'slow.call': () => new Promise(() => {}) },
      limits: { wallMs: 300 },
    })
    expect(r.outcome).toBe('timeout')
    const slept = await runScript({
      source: 'export default async (e, ctx) => { await ctx.sleep(150); return "awake" }',
      event: {},
      host: {},
      limits: { cpuMs: 50 },
    })
    expect(slept).toMatchObject({ outcome: 'ok', result: 'awake' })
  })

  test('too many ctx calls, and values over the size limit, are refused', async () => {
    const many = await runScript({
      source:
        'export default async (e, ctx) => { for (let i = 0; i < 50; i++) await ctx.a.b({ i }) }',
      event: {},
      host: { 'a.b': echo },
      limits: { maxHostCalls: 10 },
    })
    expect(many.outcome).toBe('limit')
    const big = await runScript({
      source:
        'export default async (e, ctx) => { try { await ctx.a.b({ s: "x".repeat(5000) }) } catch (err) { return err.message } }',
      event: {},
      host: { 'a.b': echo },
      limits: { maxValueChars: 1000 },
    })
    expect(big.result).toContain('characters; at most 1000')
    const bigResult = await runScript({
      source: 'export default () => "x".repeat(5000)',
      event: {},
      host: {},
      limits: { maxValueChars: 1000 },
    })
    expect(bigResult.outcome).toBe('error')
    const logs = await runScript({
      source: 'export default () => { for (let i = 0; i < 1000; i++) console.log("line", i) }',
      event: {},
      host: {},
      limits: { maxLogLines: 5 },
    })
    expect(logs.logs).toHaveLength(5)
  })
})

describe('escape attempts', () => {
  test('no host globals: fetch, process, require, Bun, timers, the host functions', async () => {
    const r = await runScript({
      source: `export default () => ({
        fetch: typeof fetch, process: typeof process, Bun: typeof Bun,
        // Bun's transpiler folds \`typeof require\` into a constant, so call it instead
        require: (() => { try { require('fs'); return 'callable' } catch { return 'undefined' } })(),
        setTimeout: typeof setTimeout, host: typeof __host, log: typeof __log, worker: typeof postMessage,
        viaFunction: typeof Function('return this')().process,
      })`,
      event: {},
      host: {},
    })
    expect(r.result).toEqual({
      fetch: 'undefined',
      process: 'undefined',
      require: 'undefined',
      Bun: 'undefined',
      setTimeout: 'undefined',
      host: 'undefined',
      log: 'undefined',
      worker: 'undefined',
      viaFunction: 'undefined',
    })
  })

  test('ctx is frozen: a script cannot add or replace methods', async () => {
    const r = await runScript({
      source: `'use strict'
        export default async (e, ctx) => {
          const tries = []
          try { ctx.channels.send = () => 'hijacked' } catch (err) { tries.push('replace refused') }
          try { ctx.admin = {} } catch (err) { tries.push('add refused') }
          return { tries, still: typeof ctx.admin }
        }`,
      event: {},
      host: { 'channels.send': echo },
    })
    expect(r.result).toEqual({ tries: ['replace refused', 'add refused'], still: 'undefined' })
  })

  test('prototype pollution inside the script never reaches the server', async () => {
    await runScript({
      source: `export default () => { Object.prototype.polluted = 'yes'; Array.prototype.push = () => 0; JSON.parse = () => 'evil' }`,
      event: {},
      host: {},
    })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(JSON.parse('1')).toBe(1)
    const arr: number[] = []
    arr.push(1)
    expect(arr).toEqual([1])
  })

  test('a host method the caller did not give is not there', async () => {
    const r = await runScript({
      source:
        'export default async (e, ctx) => ({ admin: typeof ctx.admin, send: typeof ctx.channels?.send })',
      event: {},
      host: { 'tables.get': echo },
    })
    expect(r.result).toEqual({ admin: 'undefined', send: 'undefined' })
  })

  test('many scripts at once, failing or not, leave the server serving', async () => {
    const runs = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        runScript({
          source: i % 2 ? 'export default () => { while (true) {} }' : 'export default (e) => e.i',
          event: { i },
          host: {},
          limits: { cpuMs: 150 },
        }),
      ),
    )
    expect(runs.map((r) => r.outcome)).toEqual(['ok', 'cpu', 'ok', 'cpu', 'ok', 'cpu', 'ok', 'cpu'])
  })
})

describe('the scripts.d.ts', () => {
  test('nests the host methods and marks side effects', () => {
    const docs: HostMethodDoc[] = [
      {
        name: 'channels.send',
        args: '{ chat: string; text: string }',
        returns: '{ id: string }',
        doc: 'Post a message.',
        sideEffect: true,
      },
      {
        name: 'tables.query',
        args: '{ table: string; filter?: object }',
        returns: 'unknown[]',
        doc: 'Rows.',
        sideEffect: false,
      },
    ]
    const dts = scriptTypes(docs)
    expect(dts).toContain(
      '  channels: {\n    /** Post a message. (recorded, not done, in a dry run) */\n    send(input: { chat: string; text: string }): Promise<{ id: string }>\n  }',
    )
    expect(dts).toContain('query(input: { table: string; filter?: object }): Promise<unknown[]>')
    expect(dts).toContain('type Script = ')
  })
})
