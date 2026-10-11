/**
 * Illustrative scenario: queued research items become reports with a sources section. Sources are
 * fixture files (no web), so a run is repeatable. Replace the items and sources with your own.
 */
import { outcome, sectionCoverage } from '../../src/helpers.ts'
import type { Scenario } from '../../src/types.ts'

const items = [
  { id: 'r1', topic: 'Why do sourdough starters fail in cold kitchens?' },
  { id: 'r2', topic: 'What limits battery life in small wearables?' },
]
const sources: Record<string, string> = {
  '/sources/fermentation.md':
    '# Fermentation basics\nYeast and bacteria activity slows below 20C; feeding every 24h at 18C leaves starters sluggish. Warm spots (25-27C) speed it up.\n',
  '/sources/starter-care.md':
    '# Starter care notes\nUse whole-grain flour to boost activity. A weak starter is often just under-fed or too cold.\n',
  '/sources/wearables-power.md':
    '# Wearable power budgets\nDisplay and radio dominate drain. Sleep states and batching sensor reads extend life from days to weeks.\n',
  '/sources/battery-chem.md':
    '# Battery chemistry\nSmall lithium cells have limited capacity; cold reduces usable capacity by 20-30%.\n',
}

const scenario: Scenario = {
  name: 'research-queue',
  description: 'Queued research items produce reports with Summary, Findings and Sources sections.',
  dir: import.meta.dir,
  instructions:
    'You are a research assistant. Work only from the files under /sources (read them). Write each report to /out/<item id>.md with the headings "Summary", "Findings" and "Sources". Under Sources list the source file paths you used, one per line.',
  files: () => ({
    ...sources,
    ...Object.fromEntries(items.map((i) => [`/queue/${i.id}.md`, `# ${i.id}\n${i.topic}\n`])),
  }),
  tasks: items.map((i) => ({
    id: i.id,
    prompt: `Research queue item /queue/${i.id}.md and write /out/${i.id}.md.`,
  })),
  checks: [
    {
      id: 'reports-exist',
      required: true,
      run: (ctx) => {
        const n = items.filter((i) => ctx.outputs[`/out/${i.id}.md`] !== undefined).length
        return outcome(n / items.length, `${n}/${items.length} reports written`)
      },
    },
    {
      id: 'sections',
      weight: 2,
      run: (ctx) => {
        const scores = items.map((i) =>
          sectionCoverage(ctx.outputs[`/out/${i.id}.md`] ?? '', ['Summary', 'Findings', 'Sources']),
        )
        const score = scores.reduce((n, s) => n + s.score, 0) / items.length
        return outcome(score, scores.flatMap((s) => s.missing).join(', ') || 'all sections present')
      },
    },
    {
      id: 'sources-real',
      weight: 2,
      run: (ctx) => {
        // every cited path must be one of the fixture sources (no invented citations)
        let cited = 0
        let valid = 0
        for (const i of items) {
          const text = ctx.outputs[`/out/${i.id}.md`] ?? ''
          for (const m of text.matchAll(/\/sources\/[A-Za-z0-9._-]+/g)) {
            cited++
            if (ctx.files[m[0]] !== undefined) valid++
          }
        }
        return outcome(cited === 0 ? 0 : valid / cited, `${valid}/${cited} cited sources exist`)
      },
    },
  ],
  rubrics: [{ id: 'report-quality', rubric: 'rubric.json', files: '/out/*.md' }],
}
export default scenario
