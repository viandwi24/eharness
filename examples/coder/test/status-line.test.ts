import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createStatusLine, type StatusLineInput } from '../src/app/status-line.ts'
import { tempDir } from './helpers.ts'

const input: StatusLineInput = {
  sessionId: 's1',
  cwd: '/p',
  mode: 'plan',
  model: 'a/b',
  costUsd: 0.5,
  contextTokens: 50_000,
  contextWindow: 200_000,
}

describe('status line', () => {
  test('feeds the status JSON on stdin and returns the first output line (ANSI kept)', async () => {
    const cwd = await tempDir()
    let command: string | undefined = `cat > in.json; printf '\\033[32mhello\\033[0m\\nsecond\\n'`
    const line = createStatusLine({ command: () => command, input: () => input, cwd })
    expect(await line.text()).toBe('\u001b[32mhello\u001b[0m')
    expect(JSON.parse(await readFile(join(cwd, 'in.json'), 'utf8'))).toEqual({
      session_id: 's1',
      cwd: '/p',
      mode: 'plan',
      model: { id: 'a/b' },
      cost: { total_cost_usd: 0.5 },
      context: { used_tokens: 50_000, window: 200_000, used_percentage: 25 },
    })
    command = undefined
    expect(await line.text()).toBeUndefined()
  })

  test('cached for 1 s, concurrent calls share one run, a changed command bypasses the cache', async () => {
    const cwd = await tempDir()
    let now = 1000
    let command = 'echo run >> runs.txt; echo one'
    const line = createStatusLine({
      command: () => command,
      input: () => input,
      cwd,
      now: () => now,
    })
    const [a, b] = await Promise.all([line.text(), line.text()])
    expect([a, b]).toEqual(['one', 'one'])
    now += 500
    await line.text()
    expect((await readFile(join(cwd, 'runs.txt'), 'utf8')).trim().split('\n')).toHaveLength(1)
    now += 600
    await line.text()
    expect((await readFile(join(cwd, 'runs.txt'), 'utf8')).trim().split('\n')).toHaveLength(2)
    command = 'echo changed'
    expect(await line.text()).toBe('changed')
  })

  test('timeout, failure and empty output give no status line', async () => {
    const cwd = await tempDir()
    for (const [command, timeoutMs] of [
      ['sleep 30', 100],
      ['echo oops; exit 1', 2000],
      ['true', 2000],
    ] as const) {
      const line = createStatusLine({ command: () => command, input: () => input, cwd, timeoutMs })
      expect(await line.text()).toBeUndefined()
    }
  })
})
