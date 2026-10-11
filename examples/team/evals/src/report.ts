/** Writing run reports (JSON + Markdown + produced files) and comparing two runs. */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { RunReport } from './types.ts'

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`
const usd = (n: number): string => `$${n.toFixed(4)}`

export function reportMarkdown(r: RunReport): string {
  const lines = [
    `# Eval: ${r.scenario}`,
    '',
    `- Result: **${r.passed ? 'PASS' : 'FAIL'}**, total ${pct(r.totalScore)} (pass at ${pct(r.passThreshold)})`,
    `- Model: ${r.model} (judge: ${r.judgeModel})`,
    `- Cost: ${usd(r.costUsd)} (agent ${usd(r.agentCostUsd)}, judge ${usd(r.judgeCostUsd)}) of a ${usd(r.budgetUsd)} cap${r.budgetExceeded ? ' (CAP REACHED, run cut short)' : ''}`,
    `- Duration: ${(r.durationMs / 1000).toFixed(1)}s, started ${r.startedAt}`,
    '',
    '## Checks',
    '',
    '| Check | Kind | Score | Weight | Result |',
    '|---|---|---|---|---|',
    ...r.checks.map(
      (c) =>
        `| ${c.id} | ${c.kind} | ${pct(c.score)} | ${c.weight} | ${c.skipped ? 'skipped' : c.passed ? 'pass' : 'fail'} |`,
    ),
  ]
  for (const c of r.checks) {
    if (c.detail === undefined && c.criteria === undefined && c.metrics === undefined) continue
    lines.push('', `### ${c.id}`, '')
    if (c.detail !== undefined) lines.push(c.detail)
    for (const [k, v] of Object.entries(c.metrics ?? {}))
      lines.push(`- ${k}: ${Number(v.toFixed(4))}`)
    for (const k of c.criteria ?? []) lines.push(`- ${k.id}: ${k.score}/5, ${k.reason}`)
  }
  lines.push('', '## Tasks', '', '| Task | Stop | Steps | Cost |', '|---|---|---|---|')
  for (const t of r.tasks) lines.push(`| ${t.id} | ${t.stop} | ${t.steps} | ${usd(t.costUsd)} |`)
  if (r.warnings.length > 0) lines.push('', '## Warnings', '', ...r.warnings.map((w) => `- ${w}`))
  lines.push('', '## Produced files', '')
  if (r.outputs.length === 0) lines.push('(none)')
  for (const f of r.outputs) lines.push(`- [${f}](./files${f})`)
  return `${lines.join('\n')}\n`
}

/** Writes `<root>/<scenario>/<runId>/{report.json,report.md,files/...}`; returns the folder. */
export async function writeReport(
  root: string,
  report: RunReport,
  outputs: Record<string, string>,
): Promise<string> {
  const dir = resolve(root, report.scenario, report.runId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(join(dir, 'report.md'), reportMarkdown(report))
  for (const [path, text] of Object.entries(outputs)) {
    const target = resolve(dir, 'files', `.${path}`)
    if (!target.startsWith(`${join(dir, 'files')}/`)) continue // never write outside the run folder
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, text)
  }
  return dir
}

/** A run folder, or `<scenario>/<runId>`, or `<scenario>/latest` resolved under `root`. */
export async function loadReport(root: string, ref: string): Promise<RunReport> {
  let dir = resolve(ref)
  try {
    return JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as RunReport
  } catch {
    dir = resolve(root, ref)
  }
  const [scenario, id] = ref.split('/')
  if (id === 'latest' && scenario !== undefined) {
    const runs = (await readdir(resolve(root, scenario))).sort()
    const last = runs.at(-1)
    if (last === undefined) throw new Error(`no runs for ${scenario}`)
    dir = resolve(root, scenario, last)
  }
  return JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as RunReport
}

export interface Comparison {
  a: string
  b: string
  totalDelta: number
  costDelta: number
  checks: Array<{ id: string; a: number | null; b: number | null; delta: number | null }>
}

export function compareReports(a: RunReport, b: RunReport): Comparison {
  const ids = [...new Set([...a.checks.map((c) => c.id), ...b.checks.map((c) => c.id)])]
  const score = (r: RunReport, id: string): number | null =>
    r.checks.find((c) => c.id === id)?.score ?? null
  return {
    a: `${a.scenario}/${a.runId}`,
    b: `${b.scenario}/${b.runId}`,
    totalDelta: b.totalScore - a.totalScore,
    costDelta: b.costUsd - a.costUsd,
    checks: ids.map((id) => {
      const x = score(a, id)
      const y = score(b, id)
      return { id, a: x, b: y, delta: x === null || y === null ? null : y - x }
    }),
  }
}

export function comparisonMarkdown(c: Comparison, a: RunReport, b: RunReport): string {
  const sign = (n: number): string => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)} pts`
  const cell = (n: number | null): string => (n === null ? 'n/a' : pct(n))
  return `${[
    `# Compare ${c.a} -> ${c.b}`,
    '',
    `- Models: ${a.model} -> ${b.model}`,
    `- Total: ${pct(a.totalScore)} -> ${pct(b.totalScore)} (${sign(c.totalDelta)})`,
    `- Cost: ${usd(a.costUsd)} -> ${usd(b.costUsd)} (${c.costDelta >= 0 ? '+' : '-'}${usd(Math.abs(c.costDelta))})`,
    '',
    '| Check | A | B | Delta |',
    '|---|---|---|---|',
    ...c.checks.map(
      (x) =>
        `| ${x.id} | ${cell(x.a)} | ${cell(x.b)} | ${x.delta === null ? 'n/a' : sign(x.delta)} |`,
    ),
  ].join('\n')}\n`
}
