/**
 * Waits without bound (K-03): a hook, a model stream, a tool source or an MCP server that never
 * answers must not hold a turn, a session lock or `run.result` forever; and error logging (K-05).
 */
import { describe, expect, test } from 'bun:test'
import {
  defineHarnessAgent,
  definePlugin,
  defineToolSource,
  type HarnessWarning,
} from '../index.ts'
import { createMcpServer } from '../mcp/server.ts'
import { fakeMcpServer } from '../mcp/test-kit.ts'
import { inMemoryMessages, inMemoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { serializeError } from './log-safe.ts'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const never = (): Promise<never> => new Promise(() => {})
const guard = <T>(p: Promise<T>, ms = 3000): Promise<T | 'HUNG'> =>
  Promise.race([p, new Promise<'HUNG'>((r) => setTimeout(() => r('HUNG'), ms))])

function build(config: Record<string, unknown>, warnings: HarnessWarning[]) {
  return defineHarnessAgent({
    model: scriptedModel([{ text: 'one' }, { text: 'two' }]),
    contextWindow: 100_000,
    storage: { messages: inMemoryMessages(), state: inMemoryState() },
    logger: quiet,
    onWarning: (w: HarnessWarning) => warnings.push(w),
    ...config,
  } as never)
}

describe('hooks are bounded (K-03)', () => {
  for (const hook of ['turn.start', 'turn.end', 'turn.prepare', 'step.end', 'model.call']) {
    test(`a never-resolving ${hook} hook does not hold the turn or the session lock`, async () => {
      const warnings: HarnessWarning[] = []
      const plugin = definePlugin({
        name: 'stuck',
        setup: () => ({ hooks: { [hook]: never } }),
      } as never)
      const agent = build({ plugins: [plugin], hooks: { timeoutMs: 30 } }, warnings)
      const s = agent.session('s')
      const first = await guard(s.send('a').result)
      expect(first).not.toBe('HUNG')
      expect(s.running).toBe(false)
      expect(await guard(s.send('b').result)).not.toBe('HUNG')
      await new Promise((r) => setTimeout(r, 100)) // observers may report after the turn
      expect(warnings.some((w) => w.code === 'W_HOOK_TIMEOUT')).toBe(true)
      await agent.close()
    })
  }

  test('input.submit stays fail-closed: a hung hook blocks the input with a generic text', async () => {
    const warnings: HarnessWarning[] = []
    const plugin = definePlugin({
      name: 'gate',
      setup: () => ({ hooks: { 'input.submit': never } }),
    } as never)
    const agent = build({ plugins: [plugin], hooks: { timeoutMs: 30 } }, warnings)
    const result = (await guard(agent.session('s').send('a').result)) as any
    expect(result).not.toBe('HUNG')
    expect(result.stop).not.toBe('complete')
    expect(warnings.some((w) => w.code === 'W_HOOK_TIMEOUT')).toBe(true)
    await agent.close()
  })

  test('a throwing input.submit hook blocks with "Input check failed." and logs the cause', async () => {
    const warnings: HarnessWarning[] = []
    const logged: unknown[] = []
    const plugin = definePlugin({
      name: 'gate',
      setup: () => ({
        hooks: {
          'input.submit': () => {
            throw new Error('connect ECONNREFUSED https://internal.example.com/x?key=SECRET')
          },
        },
      }),
    } as never)
    const agent = build(
      {
        plugins: [plugin],
        logger: { ...quiet, error: (m: string, d: unknown) => logged.push([m, d]) },
      },
      warnings,
    )
    const s = agent.session('s')
    const result = (await s.send('a').result) as any
    expect(result.stop).toBe('blocked')
    expect(JSON.stringify(warnings)).not.toContain('SECRET')
    expect(warnings.some((w) => w.code === 'W_HOOK_FAILED')).toBe(true)
    expect(String(((logged[0] as any)[1] as any).error.message)).toContain('ECONNREFUSED')
    await agent.close()
  })
})

describe('model stream idle timeout (K-03)', () => {
  test('a stream that goes silent fails the step instead of hanging', async () => {
    const agent = defineHarnessAgent({
      model: scriptedModel([{ text: 'late', delayMs: 5_000 }]),
      contextWindow: 100_000,
      settings: { timeout: { chunkMs: 40, firstChunkMs: 40 } },
      storage: { messages: inMemoryMessages(), state: inMemoryState() },
      logger: quiet,
    } as never)
    const result = (await guard(agent.session('s').send('a').result, 4000)) as any
    expect(result).not.toBe('HUNG')
    expect(result.stop).toBe('timeout')
    await agent.close()
  })
})

describe('tool sources are bounded and backed off (K-03)', () => {
  test('a hanging source fails with W_TOOL_SOURCE_FAILED, the turn goes on, and it is not re-asked within the backoff', async () => {
    const warnings: HarnessWarning[] = []
    let asked = 0
    const source = defineToolSource({
      id: 'stuck',
      list: () => {
        asked++
        return never()
      },
    } as never)
    const agent = build(
      { tools: [source], toolSources: { timeoutMs: 30, retryAfterMs: 60_000 } },
      warnings,
    )
    const s = agent.session('s')
    expect(await guard(s.send('a').result)).not.toBe('HUNG')
    expect(await guard(s.send('b').result)).not.toBe('HUNG')
    expect(asked).toBe(1)
    expect(warnings.filter((w) => w.code === 'W_TOOL_SOURCE_FAILED').length).toBe(1)
    await agent.close()
  })
})

describe('MCP connect is bounded (K-03)', () => {
  test('a server that never answers initialize fails with EH_MCP_TIMEOUT', async () => {
    const server = fakeMcpServer([])
    const transport = () => {
      const t = server.transport()
      t.start = () => never()
      return t
    }
    const source = createMcpServer({ name: 'x', transport, timeoutMs: 40 }, undefined as never)
    const warnings: HarnessWarning[] = []
    const agent = build({ tools: [source], toolSources: { retryAfterMs: 0 } }, warnings)
    expect(await guard(agent.session('s').send('a').result)).not.toBe('HUNG')
    expect(warnings.some((w) => w.code === 'W_TOOL_SOURCE_FAILED')).toBe(true)
    await agent.close()
  })
})

describe('error logging is safe (K-05)', () => {
  test('serializeError keeps name, message, code, status and the cause chain only', () => {
    const err = Object.assign(new Error('Unauthorized at https://api.x.com/v1?key=sk-123'), {
      name: 'APICallError',
      statusCode: 401,
      requestBodyValues: { secret: 'body' },
      responseHeaders: { authorization: 'Bearer abc' },
      cause: Object.assign(new Error('socket'), { code: 'ECONNRESET' }),
    })
    const out = serializeError(err)
    const text = JSON.stringify(out)
    expect(out.statusCode).toBe(401)
    expect(out.cause?.code).toBe('ECONNRESET')
    expect(text).not.toContain('sk-123')
    expect(text).not.toContain('body')
    expect(text).not.toContain('Bearer')
  })
})
