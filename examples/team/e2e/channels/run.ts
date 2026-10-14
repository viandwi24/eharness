/**
 * Channels e2e runner: scenarios of Channels and agent collaboration against the real team server
 * (in-process), the real Telegram adapter on a fake Bot API, and the Tracker (demo) MCP.
 *
 *   bun examples/team/e2e/channels/run.ts [--scripted | --real] [--filter A,C,B-03,tag:social]
 *        [--model deepseek/deepseek-v4.1-flash] [--budget 3] [--out report.md] [--list] [--keep]
 *
 * --scripted (default): a scripted model drives scenarios that carry a `script` (deterministic;
 *   tests that code, not the model, enforces roles, approvals, scoping). Scenarios without a
 *   script are skipped. No model calls are made.
 * --real: the model of --model (default deepseek/deepseek-v4.1-flash, OpenRouter key from
 *   examples/team/.env) answers; every scenario runs. Stops when --budget (USD) is spent.
 * --filter: categories (A-F), scenario ids (B-03) or `tag:<name>`, comma separated.
 * The report is written to examples/team/e2e/channels/reports/<timestamp>.md (gitignored).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { globalChecks } from './checks.ts'
import {
  type Check,
  type Ctx,
  newRun,
  observe,
  playStep,
  type Scenario,
  settleWorld,
} from './dsl.ts'
import { botLines, deriveFindings, renderReport, type ScenarioResult } from './report.ts'
import { allScenarios } from './scenarios/index.ts'
import { buildWorld, startTracker, type World } from './world.ts'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const has = (name: string): boolean => args.includes(name)

const mode: 'scripted' | 'real' = has('--real') ? 'real' : 'scripted'
const model = flag('--model') ?? 'deepseek/deepseek-v4.1-flash'
const budget = flag('--budget') === undefined ? undefined : Number(flag('--budget'))
const filters = (flag('--filter') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

function selected(s: Scenario): boolean {
  if (filters.length === 0) return true
  return filters.some((f) =>
    f.startsWith('tag:')
      ? (s.tags ?? []).includes(f.slice(4))
      : f.length === 1
        ? s.category === f.toUpperCase()
        : s.id.toLowerCase() === f.toLowerCase(),
  )
}

export async function runScenario(s: Scenario): Promise<ScenarioResult> {
  const base = {
    id: s.id,
    category: s.category,
    title: s.title,
    goal: s.goal,
    expectedSafe: s.expectedSafe,
  }
  const empty = {
    checks: [],
    transcript: [],
    posts: 0,
    tools: [],
    costUsd: 0,
    modelCalls: 0,
    durationMs: 0,
    latencies: [],
    errors: [],
    findings: [],
  }
  if (mode === 'scripted' && s.script === undefined)
    return { ...base, ...empty, status: 'skipped', skipReason: 'needs the real model (no script)' }
  const started = Date.now()
  let w: World | undefined
  try {
    w = await buildWorld({
      mode,
      model,
      ...(s.script === undefined ? {} : { script: s.script }),
      ...(s.world ?? {}),
    })
    if (s.setup) await s.setup(w)
    const run = newRun(w)
    if (s.settleMaxMs !== undefined) run.settleMaxMs = s.settleMaxMs
    const deadline = Date.now() + (s.timeoutMs ?? (mode === 'real' ? 240_000 : 60_000))
    for (let i = 0; i < s.steps.length; i++) {
      if (Date.now() > deadline) {
        run.errors.push(`scenario timed out after ${s.timeoutMs ?? 120_000} ms at step ${i}`)
        break
      }
      await playStep(run, s.steps[i] as never, i)
    }
    await settleWorld(w, run)
    const obs = observe(w, run)
    const ctx: Ctx = { w, run, obs }
    const checks: Check[] = [
      ...s.hard,
      ...globalChecks().filter(
        (c) => !(s.allowFailedOutbox === true && c.name === 'no outbox row failed'),
      ),
      ...(s.soft ?? []),
    ]
    const outcomes = []
    for (const c of checks) {
      if (c.modes !== undefined && !c.modes.includes(mode)) continue
      if (c.kind === 'soft' && mode === 'scripted') continue
      try {
        const r = await c.run(ctx)
        outcomes.push({
          name: c.name,
          kind: c.kind,
          ok: r.ok,
          ...(r.detail === undefined ? {} : { detail: r.detail }),
          ...(c.question === undefined ? {} : { question: c.question }),
        })
      } catch (error) {
        outcomes.push({
          name: c.name,
          kind: c.kind,
          ok: false,
          detail: `check threw: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
    const transcript = [...run.stepLog, ...botLines(obs.sent)].sort((a, b) => a.at - b.at)
    const failed = outcomes.some((o) => o.kind === 'hard' && !o.ok)
    const partial = {
      ...base,
      status: (failed ? 'fail' : 'pass') as 'pass' | 'fail',
      checks: outcomes,
      transcript,
      posts: obs.sent.length,
      tools: obs.tools.map((t) => ({
        slug: t.slug,
        name: t.name,
        refused: t.refused,
        state: t.state,
      })),
      costUsd: obs.costUsd,
      modelCalls: obs.modelCalls,
      durationMs: Date.now() - started,
      latencies: run.latencies,
      errors: run.errors,
    }
    return { ...partial, findings: deriveFindings(partial) }
  } catch (error) {
    const msg = error instanceof Error ? (error.stack ?? error.message) : String(error)
    return {
      ...base,
      ...empty,
      status: 'error',
      errors: [msg.slice(0, 1200)],
      durationMs: Date.now() - started,
    }
  } finally {
    if (w !== undefined) await w.close().catch(() => undefined)
  }
}

async function main(): Promise<void> {
  const list = allScenarios().filter(selected)
  if (has('--list')) {
    const counts: Record<string, number> = {}
    for (const s of list) {
      counts[s.category] = (counts[s.category] ?? 0) + 1
      console.log(`${s.id}\t${s.script ? 'scripted+real' : 'real'}\t${s.title}`)
    }
    console.log(JSON.stringify(counts))
    process.exit(0)
  }
  startTracker()
  const startedAt = Date.now()
  const results: ScenarioResult[] = []
  let spent = 0
  for (const s of list) {
    if (budget !== undefined && spent >= budget) {
      console.error(`budget $${budget} reached after ${results.length} scenarios; stopping`)
      break
    }
    const r = await runScenario(s)
    spent += r.costUsd
    results.push(r)
    console.log(
      `${r.status.toUpperCase().padEnd(7)} ${r.id.padEnd(6)} ${r.title}${
        r.status === 'fail'
          ? `  <- ${r.checks
              .filter((c) => c.kind === 'hard' && !c.ok)
              .map((c) => c.name)
              .join('; ')}`
          : ''
      }${r.status === 'error' ? `  <- ${r.errors[0]?.split('\n')[0]}` : ''}`,
    )
  }
  const head = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: here })
    .stdout.toString()
    .trim()
  const report = renderReport({
    startedAt,
    mode,
    ...(mode === 'real' ? { model } : {}),
    ...(budget === undefined ? {} : { budgetUsd: budget }),
    results,
    head,
  })
  const out =
    flag('--out') ??
    join(here, 'reports', `${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}-${mode}.md`)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, report)
  const fail = results.filter((r) => r.status === 'fail' || r.status === 'error').length
  console.log(
    `\n${results.length} scenarios, ${fail} failed, cost $${spent.toFixed(4)}; report: ${out}`,
  )
  process.exit(0)
}

if (import.meta.main) void main()
