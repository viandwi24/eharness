/**
 * Illustrative scenario: video titles become script drafts with required sections. Replace the
 * titles, required sections and rubric with your own house format.
 */
import { outcome, sectionCoverage } from '../../src/helpers.ts'
import type { Scenario } from '../../src/types.ts'

const titles = [
  { slug: 'cold-start', title: 'Why your first 100 users are the hardest' },
  { slug: 'pricing-page', title: 'Three pricing page mistakes that cost you signups' },
]
const SECTIONS = ['Hook', 'Outline', 'Script', 'Call to action']

const scenario: Scenario = {
  name: 'writer-drafts',
  description: 'Video titles become script drafts with Hook, Outline, Script and Call to action.',
  dir: import.meta.dir,
  instructions:
    'You write short video scripts. For each title in /input/titles.json write /out/<slug>.md with the headings "Hook", "Outline", "Script" and "Call to action". Keep the Script under 400 words.',
  files: () => ({ '/input/titles.json': JSON.stringify(titles, null, 2) }),
  tasks: titles.map((t) => ({
    id: t.slug,
    prompt: `Write the draft for "${t.title}" (slug ${t.slug}).`,
  })),
  checks: [
    {
      id: 'drafts-exist',
      required: true,
      run: (ctx) => {
        const n = titles.filter((t) => ctx.outputs[`/out/${t.slug}.md`] !== undefined).length
        return outcome(n / titles.length, `${n}/${titles.length} drafts written`)
      },
    },
    {
      id: 'required-sections',
      weight: 3,
      run: (ctx) => {
        const r = titles.map((t) =>
          sectionCoverage(ctx.outputs[`/out/${t.slug}.md`] ?? '', SECTIONS),
        )
        return outcome(
          r.reduce((n, s) => n + s.score, 0) / titles.length,
          r.flatMap((s) => s.missing).join(', ') || 'all sections present',
        )
      },
    },
    {
      id: 'length',
      run: (ctx) => {
        const ok = titles.filter((t) => {
          const words = (ctx.outputs[`/out/${t.slug}.md`] ?? '').split(/\s+/).filter(Boolean).length
          return words >= 80 && words <= 700
        }).length
        return outcome(ok / titles.length, `${ok}/${titles.length} drafts within 80-700 words`)
      },
    },
  ],
  rubrics: [{ id: 'script-quality', rubric: 'rubric.json', files: '/out/*.md' }],
}
export default scenario
