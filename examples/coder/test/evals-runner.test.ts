/** The eval harness itself, offline: scripted replay of recorded transcripts (docs/guides/coding-agent.md). */
import { describe, expect, test } from 'bun:test'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadTasks, renderMarkdown, runSuite, validateSuite } from '../evals/runner.ts'
import { tempDir } from './helpers.ts'

/** A one-task suite in a temp dir. */
async function miniSuite(opts: {
  script: unknown[]
  check?: string
  timeoutSec?: number
}): Promise<string> {
  const dir = await tempDir('coder-eval-suite-')
  const task = join(dir, 'tasks', 'one')
  await mkdir(join(task, 'fixture'), { recursive: true })
  await writeFile(join(task, 'fixture', 'a.txt'), 'before\n')
  await writeFile(
    join(task, 'task.json'),
    JSON.stringify({
      id: 'one',
      title: 'One',
      prompt: 'change a.txt',
      check: opts.check ?? 'grep -q after a.txt',
      timeoutSec: opts.timeoutSec ?? 60,
      maxCostUsd: 0.5,
    }),
  )
  await writeFile(join(task, 'script.json'), JSON.stringify(opts.script))
  return join(dir, 'tasks')
}

describe('eval suite', () => {
  test('has 15-25 tasks, each well formed; every check fails on its pristine fixture', async () => {
    const tasks = await loadTasks()
    expect(tasks.length).toBeGreaterThanOrEqual(15)
    expect(tasks.length).toBeLessThanOrEqual(25)
    for (const t of tasks) {
      expect(t.prompt.length).toBeGreaterThan(20)
      expect(t.timeoutSec).toBeGreaterThan(0)
    }
    expect(await validateSuite()).toEqual([])
  }, 60_000)

  test('scripted replay passes a sample of the real tasks and writes the reports', async () => {
    const out = await tempDir('coder-eval-out-')
    const report = await runSuite({
      scripted: true,
      only: ['fix-failing-test', 'rename-across-files', 'fix-type-error', 'edit-config'],
      concurrency: 2,
      out,
    })
    expect(report.tasks).toBe(4)
    expect(report.passed).toBe(4)
    expect(report.passRate).toBe(1)
    expect(report.totalToolCalls).toBeGreaterThan(8)
    const [run] = await readdir(out)
    const json = JSON.parse(await readFile(join(out, run as string, 'report.json'), 'utf8'))
    expect(json.results).toHaveLength(4)
    expect(await readFile(join(out, run as string, 'report.md'), 'utf8')).toContain('| task |')
  }, 60_000)

  test('a script that does not fix the project fails with check-failed and a tail', async () => {
    const tasksDir = await miniSuite({ script: [{ text: 'I did nothing.' }] })
    const report = await runSuite({ scripted: true, tasksDir })
    expect(report.passed).toBe(0)
    expect(report.results[0]?.reason).toBe('check-failed')
    expect(renderMarkdown(report)).toContain('FAIL (check-failed)')
  }, 60_000)

  test('a script that fixes it passes; the check sees hidden files only after the run', async () => {
    const tasksDir = await miniSuite({
      script: [
        { toolCalls: [{ toolName: 'read_file', input: { path: '/a.txt' } }] },
        { toolCalls: [{ toolName: 'write_file', input: { path: '/a.txt', content: 'after\n' } }] },
        { text: 'done' },
      ],
      check: 'test -f check/marker.txt && grep -q after a.txt',
    })
    const task = join(tasksDir, 'one')
    await mkdir(join(task, 'check'))
    await writeFile(join(task, 'check', 'marker.txt'), 'hidden')
    const report = await runSuite({ scripted: true, tasksDir })
    expect(report.passed).toBe(1)
    expect(report.results[0]?.toolCalls).toBe(2)
  }, 60_000)

  test('a run that exceeds its timeout is killed and reported', async () => {
    const tasksDir = await miniSuite({ script: [{ text: 'slow', delayMs: 20_000 }], timeoutSec: 2 })
    const report = await runSuite({ scripted: true, tasksDir })
    expect(report.results[0]?.passed).toBe(false)
    expect(report.results[0]?.reason).toBe('timeout')
  }, 60_000)

  test('unknown task ids and a missing script are reported, not ignored', async () => {
    await expect(runSuite({ scripted: true, only: ['nope'] })).rejects.toThrow('unknown task ids')
    const tasksDir = await miniSuite({ script: [] })
    const { rm } = await import('node:fs/promises')
    await rm(join(tasksDir, 'one', 'script.json'))
    const report = await runSuite({ scripted: true, tasksDir })
    expect(report.results[0]?.reason).toBe('no-script')
  }, 60_000)
})
