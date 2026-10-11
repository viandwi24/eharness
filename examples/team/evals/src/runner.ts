/**
 * Runs one scenario end to end: load fixtures into an in-memory workspace, run every task as one
 * turn of an eharness agent (hard USD cap through the budget ledger), run the checks, grade the
 * rubrics, and return the report. Pure with respect to the disk: `report.ts` writes the files.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineHarnessAgent, lookupModel } from 'eharness'
import { filesystem } from 'eharness/filesystem'
import { inMemoryFs } from 'eharness/filesystem/memory'
import { inMemoryBudgetLedger } from 'eharness/storage/memory'
import { gradeRubric } from './judge.ts'
import type { CheckReport, Rubric, RunOptions, RunReport, Scenario, TaskResult } from './types.ts'

export interface RunResult {
  report: RunReport
  /** Produced files by workspace path, for the report folder. */
  outputs: Record<string, string>
}

/** `*` matches inside a segment, `**` across segments. */
export function globToRegExp(glob: string): RegExp {
  const src = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\uE000')
    .replace(/\*/g, '[^/]*')
    .replace(/\uE000/g, '.*')
  return new RegExp(`^${src}$`)
}

export function priceUsd(
  options: Pick<RunOptions, 'catalog'>,
  model: RunOptions['model'],
  usage: { inputTokens: number; outputTokens: number },
): number {
  const pricing = lookupModel(options.catalog, model)?.pricing
  if (pricing === undefined) return 0
  return (usage.inputTokens * pricing.input + usage.outputTokens * pricing.output) / 1_000_000
}

async function readAll(fs: ReturnType<typeof inMemoryFs>): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const meta of await fs.list('/')) {
    const entry = await fs.read(meta.path)
    if (entry !== null) out[meta.path] = entry.content
  }
  return out
}

function lastText(
  messages: ReadonlyArray<{ role: string; parts: ReadonlyArray<unknown> }>,
): string {
  const last = [...messages].reverse().find((m) => m.role === 'assistant')
  return (last?.parts ?? [])
    .map((p) => p as { type?: string; text?: string })
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
}

export async function runScenario(scenario: Scenario, options: RunOptions): Promise<RunResult> {
  const now = options.now ?? Date.now
  const started = now()
  const outputDir = (scenario.outputDir ?? '/out').replace(/\/+$/, '')
  const fs = inMemoryFs({ seed: await scenario.files() })

  // One ledger scope for the whole run: every model call reserves against the cap first, so the
  // run stops before a call that cannot fit. `estimate` is a flat share of the cap per call.
  const ledger = inMemoryBudgetLedger({ limits: { eval: options.budgetUsd } })
  const perCall = Math.max(options.budgetUsd / 40, 0.000001)
  const warnings: string[] = []
  const agent = defineHarnessAgent({
    onWarning: (w) => warnings.push(`${w.code}: ${w.message}`),
    model: options.model,
    models: options.catalog,
    instructions: scenario.instructions,
    plugins: [filesystem({ fs })],
    budget: {
      maxSessionUsd: options.budgetUsd,
      ledger: { adapter: ledger, scopes: () => ['eval'], estimate: () => perCall },
    },
    ...(scenario.maxSteps === undefined ? {} : { loop: { maxSteps: scenario.maxSteps } }),
  })

  const tasks: TaskResult[] = []
  let agentCostUsd = 0
  let budgetExceeded = false
  for (const task of scenario.tasks) {
    if (agentCostUsd >= options.budgetUsd) {
      budgetExceeded = true
      tasks.push({ id: task.id, stop: 'skipped-budget', steps: 0, costUsd: 0, text: '' })
      continue
    }
    const session = agent.session(`eval-${task.id}`)
    const result = await session.send(task.prompt).result
    const cost = result.usage.costUsd ?? 0
    agentCostUsd += cost
    if (result.stop === 'cost-cap') budgetExceeded = true
    tasks.push({
      id: task.id,
      stop: result.stop,
      steps: result.steps,
      costUsd: cost,
      text: lastText(result.messages),
    })
  }
  await agent.close()

  const files = await readAll(fs)
  const outputs = Object.fromEntries(
    Object.entries(files).filter(([p]) => p === outputDir || p.startsWith(`${outputDir}/`)),
  )

  const checks: CheckReport[] = []
  for (const check of scenario.checks) {
    const weight = check.weight ?? 1
    try {
      const out = await check.run({ outputs, files, tasks })
      const score = Math.min(1, Math.max(0, out.score))
      checks.push({
        id: check.id,
        kind: 'deterministic',
        score,
        weight,
        passed: score >= (check.passAt ?? 1),
        required: check.required ?? false,
        ...(out.detail === undefined ? {} : { detail: out.detail }),
        ...(out.metrics === undefined ? {} : { metrics: out.metrics }),
      })
    } catch (error) {
      checks.push({
        id: check.id,
        kind: 'deterministic',
        score: 0,
        weight,
        passed: false,
        required: check.required ?? false,
        detail: `check threw: ${String(error)}`,
      })
    }
  }

  let judgeCostUsd = 0
  const judgeModel = options.judgeModel ?? options.model
  for (const rc of scenario.rubrics ?? []) {
    const base = {
      id: rc.id,
      kind: 'rubric' as const,
      weight: rc.weight ?? 1,
      required: rc.required ?? false,
    }
    if (agentCostUsd + judgeCostUsd >= options.budgetUsd) {
      budgetExceeded = true
      checks.push({
        ...base,
        score: 0,
        passed: false,
        skipped: true,
        detail: 'skipped: budget used up',
      })
      continue
    }
    const rubric = JSON.parse(await readFile(join(scenario.dir, rc.rubric), 'utf8')) as Rubric
    const re = globToRegExp(rc.files ?? `${outputDir}/**`)
    const seen = Object.fromEntries(Object.entries(outputs).filter(([p]) => re.test(p)))
    if (Object.keys(seen).length === 0) {
      checks.push({
        ...base,
        score: 0,
        passed: false,
        detail: 'no produced file matches the rubric',
      })
      continue
    }
    try {
      const graded = await gradeRubric({
        model: judgeModel,
        rubric,
        check: rc,
        taskPrompts: scenario.tasks.map((t) => t.prompt),
        files: seen,
      })
      judgeCostUsd += priceUsd(options, judgeModel, graded.usage)
      checks.push({ ...base, ...graded.report })
    } catch (error) {
      checks.push({ ...base, score: 0, passed: false, detail: `judge failed: ${String(error)}` })
    }
  }

  const totalWeight = checks.reduce((n, c) => n + c.weight, 0)
  const totalScore =
    totalWeight === 0 ? 0 : checks.reduce((n, c) => n + c.score * c.weight, 0) / totalWeight
  const passThreshold = scenario.passThreshold ?? 0.7
  const costUsd = agentCostUsd + judgeCostUsd
  const startedAt = new Date(started).toISOString()
  const report: RunReport = {
    scenario: scenario.name,
    runId: startedAt.replace(/[:.]/g, '-'),
    startedAt,
    durationMs: now() - started,
    model: options.modelId,
    judgeModel: options.judgeModelId ?? options.modelId,
    budgetUsd: options.budgetUsd,
    costUsd,
    agentCostUsd,
    judgeCostUsd,
    budgetExceeded: budgetExceeded || costUsd > options.budgetUsd,
    tasks,
    checks,
    totalScore,
    passThreshold,
    passed:
      totalScore >= passThreshold &&
      !checks.some((c) => c.required && !c.passed) &&
      !budgetExceeded,
    warnings,
    outputs: Object.keys(outputs),
  }
  return { report, outputs }
}
