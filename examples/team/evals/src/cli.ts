/**
 * `bun run eval <scenario> [--model id] [--budget usd] [--repeat n]`
 * `bun run eval compare <runA> <runB>`
 * `bun run eval list`
 *
 * Real model calls only happen here, with a key in the environment, under a hard USD cap.
 */
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { LanguageModel } from 'ai'
import { assertMayRun, flatCatalog, realModel, resolveRates } from './models.ts'
import { compareReports, comparisonMarkdown, loadReport, writeReport } from './report.ts'
import { runScenario } from './runner.ts'
import type { Scenario } from './types.ts'

export const EVALS_DIR = resolve(import.meta.dir, '..')
export const RESULTS_DIR = join(EVALS_DIR, 'results')
const SCENARIOS_DIR = join(EVALS_DIR, 'scenarios')

export interface Args {
  command: 'run' | 'compare' | 'list' | 'help'
  positional: string[]
  flags: Record<string, string | true>
}

export function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2) as [string, string | undefined]
      if (inline !== undefined) flags[k] = inline
      else if (['allow-ci', 'help'].includes(k)) flags[k] = true
      else flags[k] = argv[++i] ?? ''
    } else positional.push(a)
  }
  const first = positional[0]
  if (flags.help || first === undefined || first === 'help')
    return { command: 'help', positional, flags }
  if (first === 'compare' || first === 'list') {
    return { command: first, positional: positional.slice(1), flags }
  }
  return { command: 'run', positional, flags }
}

const USAGE = `usage:
  bun run eval <scenario> [--model <id>] [--budget <usd>] [--repeat <n>] [--judge-model <id>]
                          [--price-in <usd/1M>] [--price-out <usd/1M>] [--allow-ci]
  bun run eval compare <runA> <runB>     (run folder, or <scenario>/<runId>, or <scenario>/latest)
  bun run eval list

Calls a real model: needs OPENROUTER_API_KEY or AI_GATEWAY_API_KEY. Default budget $1 (hard cap).`

export async function loadScenario(name: string, dir = SCENARIOS_DIR): Promise<Scenario> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`invalid scenario name: ${name}`)
  const mod = (await import(join(dir, name, 'scenario.ts'))) as { default: Scenario }
  return mod.default
}

function num(v: string | true | undefined, label: string): number | undefined {
  if (v === undefined) return undefined
  const n = Number(v)
  if (v === true || !Number.isFinite(n) || n < 0)
    throw new Error(`${label} must be a non-negative number`)
  return n
}

export async function main(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const args = parseArgs(argv)
  if (args.command === 'help') {
    console.log(USAGE)
    return 0
  }
  if (args.command === 'list') {
    for (const d of await readdir(SCENARIOS_DIR)) console.log(d)
    return 0
  }
  if (args.command === 'compare') {
    const [pa, pb] = args.positional
    if (pa === undefined || pb === undefined) throw new Error('compare needs two runs')
    const [a, b] = [await loadReport(RESULTS_DIR, pa), await loadReport(RESULTS_DIR, pb)]
    console.log(comparisonMarkdown(compareReports(a, b), a, b))
    return 0
  }

  assertMayRun(env, args.flags['allow-ci'] === true)
  const name = args.positional[0] as string
  const scenario = await loadScenario(name)
  const modelId = typeof args.flags.model === 'string' ? args.flags.model : (env.EVAL_MODEL ?? '')
  if (modelId === '') throw new Error('pass --model <id> (or set EVAL_MODEL)')
  const judgeId =
    typeof args.flags['judge-model'] === 'string' ? args.flags['judge-model'] : modelId
  const budget = num(args.flags.budget, '--budget') ?? 1
  const repeat = Math.max(1, Math.floor(num(args.flags.repeat, '--repeat') ?? 1))
  const priceIn = num(args.flags['price-in'], '--price-in')
  const priceOut = num(args.flags['price-out'], '--price-out')
  const rates = await resolveRates(modelId, {
    ...(priceIn === undefined ? {} : { priceIn }),
    ...(priceOut === undefined ? {} : { priceOut }),
  })
  const model: LanguageModel = realModel(modelId, env)
  const judgeModel: LanguageModel = judgeId === modelId ? model : realModel(judgeId, env)

  let remaining = budget
  let failed = false
  for (let i = 1; i <= repeat; i++) {
    if (remaining <= 0) {
      console.log(`budget used up after ${i - 1} run(s)`)
      break
    }
    const { report, outputs } = await runScenario(scenario, {
      model,
      modelId,
      judgeModel,
      judgeModelId: judgeId,
      budgetUsd: remaining,
      catalog: flatCatalog(rates),
    })
    remaining -= report.costUsd
    const dir = await writeReport(RESULTS_DIR, report, outputs)
    console.log(
      `${report.passed ? 'PASS' : 'FAIL'} ${scenario.name} ${(report.totalScore * 100).toFixed(1)}% $${report.costUsd.toFixed(4)} -> ${dir}`,
    )
    if (!report.passed) failed = true
  }
  return failed ? 1 : 0
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(String(error instanceof Error ? error.message : error))
      process.exit(2)
    },
  )
}
