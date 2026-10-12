/** Markdown report of a Channels e2e run: per-scenario verdicts with evidence, cost, latency, findings. */
import { CATEGORIES, type CategoryKey, type LogLine, type Out } from './dsl.ts'

export interface CheckOutcome {
  name: string
  kind: 'hard' | 'soft'
  ok: boolean
  detail?: string
  question?: string
}
export type Severity = 'critical' | 'high' | 'medium' | 'low'
export type FindingKind = 'bug' | 'loophole' | 'dead end' | 'limit' | 'UX'
export interface Finding {
  scenario: string
  kind: FindingKind
  severity: Severity
  title: string
  evidence: string
}
export interface ScenarioResult {
  id: string
  category: CategoryKey
  title: string
  goal: string
  expectedSafe: string
  status: 'pass' | 'fail' | 'skipped' | 'error'
  skipReason?: string
  checks: CheckOutcome[]
  transcript: Array<LogLine & { text: string }>
  posts: number
  tools: Array<{ slug: string; name: string; refused: boolean; state: string }>
  costUsd: number
  modelCalls: number
  durationMs: number
  latencies: Array<{ label: string; ms: number | undefined }>
  errors: string[]
  findings: Finding[]
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}...` : s)
const fence = (s: string): string => `\`\`\`\n${s.replace(/```/g, "'''")}\n\`\`\``

/** Findings a failed hard check suggests; a human (or the orchestrator) curates the final list. */
export function deriveFindings(r: Omit<ScenarioResult, 'findings'>): Finding[] {
  const out: Finding[] = []
  const failed = r.checks.filter((c) => c.kind === 'hard' && !c.ok)
  for (const c of failed) {
    const privileged =
      /is NOT executed|no native call|Tracker state is unchanged|approvals|mentions|reminders/.test(
        c.name,
      )
    const leak = /no post|contains|token|key|never|mentioned/i.test(c.name)
    const deadEnd =
      /settle|timed out|silent/i.test(`${c.name} ${c.detail ?? ''}`) || r.category === 'F'
    let kind: FindingKind = 'bug'
    let severity: Severity = 'medium'
    if ((r.category === 'B' || r.category === 'C') && privileged) {
      kind = 'loophole'
      severity = 'high'
    } else if (r.category === 'D' && leak) {
      kind = 'loophole'
      severity = 'high'
    } else if (r.category === 'E') {
      kind = 'limit'
      severity = 'medium'
    } else if (deadEnd) {
      kind = 'dead end'
      severity = 'medium'
    } else if (r.category === 'A') {
      kind = 'bug'
      severity = 'medium'
    }
    if (/harness error|settle/.test(c.name)) severity = 'low'
    out.push({ scenario: r.id, kind, severity, title: c.name, evidence: clip(c.detail ?? '', 240) })
  }
  return out
}

export function renderReport(input: {
  startedAt: number
  mode: string
  model?: string
  budgetUsd?: number
  results: ScenarioResult[]
  head?: string
}): string {
  const { results } = input
  const by = (s: ScenarioResult['status']): number => results.filter((r) => r.status === s).length
  const cost = results.reduce((a, r) => a + r.costUsd, 0)
  const lines: string[] = []
  lines.push(`# Channels e2e report`)
  lines.push('')
  lines.push(`- started: ${new Date(input.startedAt).toISOString()}`)
  lines.push(
    `- mode: ${input.mode}${input.model ? ` (${input.model})` : ''}${input.head ? `, HEAD ${input.head}` : ''}`,
  )
  lines.push(
    `- scenarios: ${results.length} (pass ${by('pass')}, fail ${by('fail')}, error ${by('error')}, skipped ${by('skipped')})`,
  )
  lines.push(
    `- cost: $${cost.toFixed(4)}${input.budgetUsd ? ` of $${input.budgetUsd}` : ''}; model calls ${results.reduce((a, r) => a + r.modelCalls, 0)}`,
  )
  lines.push('')
  lines.push('## By category')
  lines.push('')
  lines.push('| Category | Pass | Fail | Skipped |')
  lines.push('|---|---|---|---|')
  for (const k of Object.keys(CATEGORIES) as CategoryKey[]) {
    const rs = results.filter((r) => r.category === k)
    if (rs.length === 0) continue
    lines.push(
      `| ${k} ${CATEGORIES[k]} | ${rs.filter((r) => r.status === 'pass').length} | ${rs.filter((r) => r.status === 'fail' || r.status === 'error').length} | ${rs.filter((r) => r.status === 'skipped').length} |`,
    )
  }
  const findings = results.flatMap((r) => r.findings)
  lines.push('')
  lines.push('## Findings (candidates from failed hard checks)')
  lines.push('')
  if (findings.length === 0) lines.push('None.')
  else {
    const order: Severity[] = ['critical', 'high', 'medium', 'low']
    findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity))
    lines.push('| Severity | Kind | Scenario | Finding | Evidence |')
    lines.push('|---|---|---|---|---|')
    for (const f of findings)
      lines.push(
        `| ${f.severity} | ${f.kind} | ${f.scenario} | ${f.title.replace(/\|/g, '/')} | ${f.evidence.replace(/\|/g, '/').replace(/\n/g, ' ')} |`,
      )
  }
  lines.push('')
  lines.push('## Scenarios')
  for (const r of results) {
    lines.push('')
    lines.push(`### ${r.id} ${r.title} [${r.status.toUpperCase()}]`)
    lines.push('')
    lines.push(`Category ${r.category} (${CATEGORIES[r.category]}). Goal: ${r.goal}`)
    lines.push(`Expected safe outcome: ${r.expectedSafe}`)
    if (r.status === 'skipped') {
      lines.push(`Skipped: ${r.skipReason ?? ''}`)
      continue
    }
    lines.push(
      `Posts ${r.posts}, tools ${r.tools.length}, model calls ${r.modelCalls}, cost $${r.costUsd.toFixed(4)}, ${r.durationMs} ms`,
    )
    lines.push('')
    for (const c of r.checks) {
      const mark = c.kind === 'hard' ? (c.ok ? 'PASS' : 'FAIL') : c.ok ? 'note ok' : 'note flag'
      lines.push(
        `- [${mark}] ${c.name}${c.detail ? ` — ${c.detail.replace(/\n/g, ' ')}` : ''}${c.kind === 'soft' && c.question ? ` (judge: ${c.question})` : ''}`,
      )
    }
    if (r.errors.length > 0) lines.push(`- harness errors: ${r.errors.join(' | ')}`)
    if (r.tools.length > 0)
      lines.push(
        `- tools: ${r.tools.map((t) => `${t.slug}:${t.name}${t.refused ? '(refused)' : ''}`).join(', ')}`,
      )
    lines.push('')
    lines.push(fence(r.transcript.map(fmt).join('\n')))
  }
  lines.push('')
  return lines.join('\n')
}

function fmt(l: LogLine & { text: string }): string {
  const t = new Date(l.at).toISOString().slice(11, 19)
  const who = l.kind === 'bot' ? 'BOT' : l.who
  return `${t} ${who}${l.place ? ` @${l.place}` : ''}: ${clip(l.text.replace(/\n/g, ' / '), 400)}`
}

export function botLines(sent: Out[]): Array<LogLine & { text: string }> {
  return sent.map((s) => ({
    at: s.at,
    who: 'bot',
    place: s.place,
    kind: 'bot' as const,
    text: `${s.text}${s.buttons.length > 0 ? ` [buttons: ${s.buttons.join(' | ')}]` : ''}${s.mentionIds.length > 0 ? ` [mentions ${s.mentionIds.join(',')}]` : ''}`,
  }))
}
