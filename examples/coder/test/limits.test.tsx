/** The per-turn safety ceiling: config and flags, the cost and time caps, the readable stop notices and /cost. */
import { describe, expect, test } from 'bun:test'
import { scriptedModel } from 'eharness/testing'
import { render } from 'ink-testing-library'
import { loadConfig } from '../src/app/config.ts'
import { createController } from '../src/app/controller.ts'
import { limitStopNotice } from '../src/app/limits.ts'
import { createSettingsManager } from '../src/app/settings.ts'
import type { CoderController, RunHooks } from '../src/contracts.ts'
import { CostBody } from '../src/ui/pages/CostPage.tsx'
import { onCleanup, setup, writeFiles } from './helpers.ts'

const read = { toolName: 'read_file', input: { path: '/a.txt' } }

async function run(controller: CoderController, text: string) {
  const hooks: RunHooks = {
    onRun(r) {
      void (async () => {
        const reader = (r.stream as ReadableStream).getReader()
        while (!(await reader.read()).done) {}
      })()
    },
  }
  return controller.run(text, hooks)
}

describe('limits config', () => {
  test('defaults to $5 and 30 minutes; settings and flags override; 0 turns a cap off', async () => {
    const { root, config } = await setup({ 'a.txt': 'a' })
    expect(config.maxTurnCostUsd).toBe(5)
    expect(config.maxTurnMinutes).toBe(30)
    await writeFiles(config.userDir, {
      'settings.json': JSON.stringify({ limits: { maxTurnCostUsd: 2 } }),
    })
    const fromUser = await loadConfig({ cwd: root })
    expect([fromUser.maxTurnCostUsd, fromUser.maxTurnMinutes]).toEqual([2, 30])
    const flags = await loadConfig({ cwd: root, maxCost: 0, maxTime: 7 })
    expect([flags.maxTurnCostUsd, flags.maxTurnMinutes]).toEqual([0, 7])
  })

  test('an untrusted project cannot lift the ceiling', async () => {
    const { config } = await setup({
      '.coder/settings.json': JSON.stringify({ limits: { maxTurnCostUsd: 1000 } }),
    })
    expect(config.maxTurnCostUsd).toBe(5)
    expect(config.untrusted).toContain('limits')
  })

  test('/config lists and saves the caps', async () => {
    const { config } = await setup()
    const mgr = createSettingsManager({ config })
    const list = await mgr.settings()
    expect(list.find((s) => s.key === 'limits.maxTurnCostUsd')).toMatchObject({ value: 5 })
    await mgr.updateSetting('limits.maxTurnMinutes', 10, 'local')
    expect(mgr.setting('limits')).toEqual({ maxTurnMinutes: 10 })
    await expect(mgr.updateSetting('limits.maxTurnCostUsd', -1, 'local')).rejects.toThrow(
      'at least 0',
    )
  })
})

describe('the caps stop a turn', () => {
  test('cost cap: stops with cost-cap and the notice says how to raise it', async () => {
    const { config } = await setup({ 'a.txt': 'a' }, { maxCost: 1.5 })
    // $1000 per million tokens: each 1000-token step costs $1
    const controller = await createController({
      config,
      model: scriptedModel(
        Array.from({ length: 6 }, () => ({
          toolCalls: [read],
          usage: { inputTokens: 1000, outputTokens: 0 },
        })),
      ),
      models: () => ({ pricing: { input: 1000, output: 1000 } }),
    })
    onCleanup(() => controller.close())
    const result = await run(controller, 'go')
    expect(result.stop).toBe('cost-cap')
    expect(result.steps).toBe(2)
    const notice = limitStopNotice(result.stop, config)
    expect(notice).toContain('cost cap ($1.50)')
    expect(notice).toContain('--max-cost')
    // the conversation is intact: a new message starts a fresh turn
    expect((await controller.messages()).length).toBeGreaterThan(0)
  })

  test('time cap: stops after the step that crossed it', async () => {
    const { config } = await setup({ 'a.txt': 'a' }, { maxTime: 0.0005 }) // 30 ms
    const controller = await createController({
      config,
      model: scriptedModel(Array.from({ length: 6 }, () => ({ toolCalls: [read], delayMs: 40 }))),
    })
    onCleanup(() => controller.close())
    const result = await run(controller, 'go')
    expect(result.stop).toBe('plugin:turn-time-limit:time')
    expect(result.steps).toBeLessThan(6)
    const notice = limitStopNotice(result.stop, config)
    expect(notice).toContain('time cap')
    expect(notice).toContain('--max-time')
  })

  test('0 means no cap: the turn completes', async () => {
    const { config } = await setup({ 'a.txt': 'a' }, { maxCost: 0, maxTime: 0 })
    const controller = await createController({
      config,
      model: scriptedModel([
        { toolCalls: [read], delayMs: 20, usage: { inputTokens: 1000, outputTokens: 0 } },
        { text: 'done' },
      ]),
      models: () => ({ pricing: { input: 1000, output: 1000 } }),
    })
    onCleanup(() => controller.close())
    expect((await run(controller, 'go')).stop).toBe('complete')
  })

  test('other stops have no limit notice; headless text says --continue', () => {
    const limits = { maxTurnCostUsd: 5, maxTurnMinutes: 30 }
    expect(limitStopNotice('max-steps', limits)).toBeUndefined()
    expect(limitStopNotice('cost-cap', limits, true)).toContain('--continue')
  })
})

describe('/cost', () => {
  test('shows the caps and how to raise them', () => {
    const { lastFrame } = render(
      <CostBody
        u={{ inputTokens: 1, outputTokens: 1, turns: 1, durationMs: 1000, costUsd: 0.1 }}
        model="a/b"
        limits={{ maxTurnCostUsd: 5, maxTurnMinutes: 0 }}
      />,
    )
    const f = lastFrame() ?? ''
    expect(f).toContain('Limits per turn')
    expect(f).toContain('$5.00')
    expect(f).toContain('none')
    expect(f).toContain('--max-cost')
  })
})
