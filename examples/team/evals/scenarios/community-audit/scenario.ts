/**
 * Illustrative scenario: audit one day of a community chat for planted incidents (the phase D
 * fixture). Deterministic checks: recall and precision of the reported item ids against the
 * fixture's `truth()`. Replace the fixture and the truth to use your own answer key.
 */
import { communityFixture } from '../../../server/src/infra/bigdata/fixture-collector.ts'
import { parseJson, recallPrecision } from '../../src/helpers.ts'
import type { Scenario } from '../../src/types.ts'

const fixture = communityFixture({ day: '2026-10-11' })
const t = fixture.truth()

export const truthIds = (): string[] => [
  ...t.spamBursts.flatMap((b) => b.ids),
  ...t.raid.joinIds,
  ...t.raid.postIds,
  ...t.modAbuse.bullyIds,
  ...t.modAbuse.deleteIds,
  t.suspiciousRoleChangeId,
  ...t.shadyLinkIds,
]

/** Ids named in an `audit.json` (`{ incidents: [{ ids: [...] }] }`), or undefined when malformed. */
export function reportedIds(text: string | undefined): string[] | undefined {
  const json = parseJson(text) as { incidents?: Array<{ ids?: unknown }> } | undefined
  if (!json || !Array.isArray(json.incidents)) return undefined
  return json.incidents.flatMap((i) =>
    Array.isArray(i.ids) ? i.ids.filter((x): x is string => typeof x === 'string') : [],
  )
}

const scenario: Scenario = {
  name: 'community-audit',
  description:
    'Find planted spam, raid, moderator abuse, role change and shady links in a day of chat.',
  dir: import.meta.dir,
  instructions:
    'You audit a community chat for the client. The data is JSONL under /data/community (one item per line, with id, channel, at, author, kind, text). Use grep and read to inspect it; never read everything at once. Write results to /out.',
  files: () => {
    const byChannel: Record<string, string[]> = {}
    for (const item of fixture.items()) {
      const lines = byChannel[item.channel] ?? []
      byChannel[item.channel] = lines
      lines.push(JSON.stringify(item))
    }
    return Object.fromEntries(
      Object.entries(byChannel).map(([c, lines]) => [
        `/data/community/${c.replace(/[^a-z0-9-]/gi, '-')}.jsonl`,
        `${lines.join('\n')}\n`,
      ]),
    )
  },
  tasks: [
    {
      id: 'audit',
      prompt:
        'Audit the day. Find spam bursts, a join raid, a moderator abusing a member, suspicious admin role changes and links to shady domains. Write /out/audit.json as {"incidents":[{"type":"spam|raid|mod-abuse|role-change|shady-link","summary":"...","ids":["item ids as evidence"]}]} and a short /out/audit.md for the client.',
    },
  ],
  checks: [
    {
      id: 'audit-json-shape',
      required: true,
      run: (ctx) => {
        const ids = reportedIds(ctx.outputs['/out/audit.json'])
        return ids === undefined
          ? { score: 0, detail: '/out/audit.json is missing or not {"incidents":[{"ids":[...]}]}' }
          : { score: 1, detail: `${ids.length} evidence ids` }
      },
    },
    {
      id: 'recall',
      weight: 3,
      passAt: 0.8,
      run: (ctx) => {
        const { recall, precision } = recallPrecision(
          truthIds(),
          reportedIds(ctx.outputs['/out/audit.json']) ?? [],
        )
        return {
          score: recall,
          detail: `recall ${(recall * 100).toFixed(1)}%`,
          metrics: { recall, precision },
        }
      },
    },
    {
      id: 'precision',
      weight: 2,
      passAt: 0.8,
      run: (ctx) => {
        const { recall, precision } = recallPrecision(
          truthIds(),
          reportedIds(ctx.outputs['/out/audit.json']) ?? [],
        )
        return {
          score: precision,
          detail: `precision ${(precision * 100).toFixed(1)}%`,
          metrics: { recall, precision },
        }
      },
    },
    {
      id: 'summary-written',
      run: (ctx) => ({ score: (ctx.outputs['/out/audit.md']?.trim().length ?? 0) > 100 ? 1 : 0 }),
    },
  ],
  rubrics: [{ id: 'report-quality', rubric: 'rubric.json', files: '/out/audit.md', weight: 1 }],
  passThreshold: 0.7,
}
export default scenario
