/** The eval framework, tested with scripted models only: no real model call, no network. */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedModel } from 'eharness/testing'
import communityAudit, { truthIds } from '../scenarios/community-audit/scenario.ts'
import researchQueue from '../scenarios/research-queue/scenario.ts'
import writerDrafts from '../scenarios/writer-drafts/scenario.ts'
import { main, parseArgs } from '../src/cli.ts'
import { assertMayRun, flatCatalog } from '../src/models.ts'
import { compareReports, loadReport, writeReport } from '../src/report.ts'
import { runScenario } from '../src/runner.ts'

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
})
const catalog = flatCatalog({ input: 3, output: 15 })
const base = { modelId: 'scripted', budgetUsd: 1, catalog }

const goodJudge = (n = 1) =>
  scriptedModel(
    Array.from({ length: n }, () => ({
      text: JSON.stringify({
        criteria: ['clarity', 'evidence', 'actionable', 'no-fabrication'].map((id) => ({
          id,
          score: 5,
          reason: 'good',
        })),
      }),
    })),
  )

const write = (path: string, content: string) => ({
  toolName: 'write_file',
  input: { path, content },
})

describe('eval framework', () => {
  test('community-audit: recall and precision against the planted truth', async () => {
    const truth = truthIds()
    const half = truth.slice(0, Math.floor(truth.length / 2))
    const model = scriptedModel([
      {
        toolCalls: [
          write(
            '/out/audit.json',
            JSON.stringify({ incidents: [{ type: 'spam', ids: [...half, 'bogus-1'] }] }),
          ),
          write('/out/audit.md', `# Audit\n${'Spam and raid evidence. '.repeat(10)}`),
        ],
      },
      { text: 'done' },
    ])
    const { report } = await runScenario(communityAudit, {
      ...base,
      model,
      judgeModel: goodJudge(),
    })
    const recall = report.checks.find((c) => c.id === 'recall')
    const precision = report.checks.find((c) => c.id === 'precision')
    expect(recall?.score).toBeCloseTo(half.length / truth.length, 5)
    expect(precision?.score).toBeCloseTo(half.length / (half.length + 1), 5)
    expect(report.checks.find((c) => c.id === 'audit-json-shape')?.passed).toBe(true)
    expect(report.checks.find((c) => c.id === 'report-quality')?.score).toBe(1)
    expect(recall?.passed).toBe(false) // recall below the bar of 0.8
    expect(report.outputs.sort()).toEqual(['/out/audit.json', '/out/audit.md'])
  }, 30_000)

  test('a perfect answer passes; costs are priced and reported', async () => {
    const model = scriptedModel([
      {
        toolCalls: [
          write('/out/audit.json', JSON.stringify({ incidents: [{ ids: truthIds() }] })),
          write('/out/audit.md', `# Audit\n${'All incidents found. '.repeat(10)}`),
        ],
        usage: { inputTokens: 1000, outputTokens: 100 },
      },
      { text: 'done', usage: { inputTokens: 1000, outputTokens: 100 } },
    ])
    const { report } = await runScenario(communityAudit, {
      ...base,
      model,
      judgeModel: goodJudge(),
    })
    expect(report.passed).toBe(true)
    expect(report.totalScore).toBeCloseTo(1, 5)
    expect(report.agentCostUsd).toBeCloseTo((2 * (1000 * 3 + 100 * 15)) / 1e6, 8)
    expect(report.costUsd).toBeGreaterThan(report.agentCostUsd) // the judge call is priced too
  }, 30_000)

  test('research-queue and writer-drafts run end to end with deterministic checks', async () => {
    const reports = researchQueue.tasks.flatMap((t) => [
      {
        toolCalls: [
          write(
            `/out/${t.id}.md`,
            '# Report\n## Summary\nshort\n## Findings\n- a\n## Sources\n/sources/fermentation.md\n/sources/invented.md\n',
          ),
        ],
      },
      { text: 'ok' },
    ])
    const r = await runScenario(researchQueue, {
      ...base,
      model: scriptedModel(reports),
      judgeModel: scriptedModel([]),
    })
    expect(r.report.tasks).toHaveLength(2)
    expect(r.report.checks.find((c) => c.id === 'sections')?.score).toBe(1)
    expect(r.report.checks.find((c) => c.id === 'sources-real')?.score).toBeCloseTo(0.5, 5)
    // a judge that returns garbage fails that check, never the run
    expect(r.report.checks.find((c) => c.id === 'report-quality')?.detail).toContain('judge failed')

    const drafts = writerDrafts.tasks.flatMap((t) => [
      {
        toolCalls: [
          write(
            `/out/${t.id}.md`,
            `## Hook\nx\n## Outline\ny\n## Script\n${'word '.repeat(100)}\n`,
          ),
        ],
      },
      { text: 'ok' },
    ])
    const w = await runScenario(writerDrafts, {
      ...base,
      model: scriptedModel(drafts),
      judgeModel: scriptedModel([]),
    })
    const sections = w.report.checks.find((c) => c.id === 'required-sections')
    expect(sections?.score).toBeCloseTo(0.75, 5) // "Call to action" missing
    expect(sections?.detail).toContain('Call to action')
  }, 30_000)

  test('the budget cap stops the run', async () => {
    // each call costs 3 dollars at these prices; the cap is 0.01
    const model = scriptedModel(
      Array.from({ length: 10 }, (_, i) => ({
        toolCalls: [write(`/out/f${i}.md`, 'x')],
        usage: { inputTokens: 1_000_000, outputTokens: 0 },
      })),
    )
    const { report } = await runScenario(writerDrafts, {
      ...base,
      budgetUsd: 0.01,
      model,
      judgeModel: scriptedModel([]),
    })
    expect(report.budgetExceeded).toBe(true)
    expect(report.passed).toBe(false)
    expect(report.warnings.join()).toContain('W_BUDGET')
    expect(model.calls.length).toBeLessThanOrEqual(2)
    expect(report.tasks.some((t) => t.stop === 'cost-cap' || t.stop === 'skipped-budget')).toBe(
      true,
    )
    // rubric grading is skipped once the budget is used up: the judge is never called
    expect(report.checks.find((c) => c.id === 'script-quality')?.skipped).toBe(true)
  }, 30_000)

  test('reports are written and two runs compare', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evals-'))
    dirs.push(root)
    const run = async (content: string, at: number) => {
      const model = scriptedModel(
        writerDrafts.tasks.flatMap((t) => [
          { toolCalls: [write(`/out/${t.id}.md`, content)] },
          { text: 'ok' },
        ]),
      )
      const { report, outputs } = await runScenario(writerDrafts, {
        ...base,
        model,
        judgeModel: goodJudge(),
        now: () => at,
      })
      await writeReport(root, report, outputs)
      return report
    }
    const a = await run('## Hook\nx\n', Date.UTC(2026, 0, 1))
    const b = await run(
      '## Hook\nx\n## Outline\ny\n## Script\nz\n## Call to action\nw\n',
      Date.UTC(2026, 0, 2),
    )
    const dir = join(root, 'writer-drafts', b.runId)
    expect(await readFile(join(dir, 'report.md'), 'utf8')).toContain('# Eval: writer-drafts')
    expect(await readFile(join(dir, 'files/out/cold-start.md'), 'utf8')).toContain('Call to action')
    const loaded = await loadReport(root, `writer-drafts/latest`)
    expect(loaded.runId).toBe(b.runId)
    const cmp = compareReports(a, loaded)
    expect(cmp.checks.find((c) => c.id === 'required-sections')?.delta).toBeGreaterThan(0)
    expect(cmp.totalDelta).toBeGreaterThan(0)
  }, 30_000)

  test('CI refusal and argument parsing', async () => {
    expect(() => assertMayRun({ CI: 'true' }, false)).toThrow(/CI/)
    expect(() => assertMayRun({ CI: 'true' }, true)).not.toThrow()
    expect(() => assertMayRun({}, false)).not.toThrow()
    expect(parseArgs(['community-audit', '--budget', '0.5', '--allow-ci', '--repeat=2'])).toEqual({
      command: 'run',
      positional: ['community-audit'],
      flags: { budget: '0.5', 'allow-ci': true, repeat: '2' },
    })
    expect(parseArgs(['compare', 'a', 'b']).command).toBe('compare')
    await expect(main(['community-audit', '--model', 'x'], { CI: '1' })).rejects.toThrow(/refusing/)
    await expect(main(['community-audit'], {})).rejects.toThrow(/--model/)
    await expect(
      main(['../evil', '--model', 'x', '--price-in', '1', '--price-out', '1'], {}),
    ).rejects.toThrow(/invalid scenario/)
  })
})
