/**
 * Reorganize memory (docs/plans/P57-library-structure.md): a one-time, owner-approved cleanup of
 * one agent's memory. The library is the source of truth; memory keeps short rules (`rules.md`)
 * and an index (`index.md`) that points into it.
 *
 *  1. `proposeReorg`: the agent's own model reads the memory files in small batches (one cheap call
 *     per batch) and proposes one action per file: keep-as-rule, move, merge-into, archive.
 *  2. `previewReorg`: deterministic checks (`buildReorgPlan`) turn any rows, the model's or the
 *     owner's edits, into a plan: no target outside /library, no overwrite, dated reports to
 *     /library/reports, the new rules.md and index.md as a diff.
 *  3. `applyReorg`: a verified backup first (nothing is touched when it fails), then new library
 *     files (created, read back), the new rules.md and index.md, and last the original memory files
 *     are moved (not deleted) to /library/archive/memory/<agent>/original/. A restore point that the
 *     backup undo flow understands is recorded.
 */

import { type RestorePoint, restorePointId } from '../domain/backups.ts'
import { conflict, invalid } from '../domain/errors.ts'
import {
  buildReorgPlan,
  HEARTBEAT_FILE,
  INDEX_FILE,
  LIBRARY_FOLDERS,
  parseProposal,
  REORG_ACTIONS,
  type ReorgPlan,
  type ReorgRow,
  type ReorgSourceFile,
  RULES_FILE,
} from '../domain/library-structure.ts'
import { agentMemory } from '../domain/memory.ts'
import { getAgent } from './agents.ts'
import { backupPort } from './backup-port.ts'
import { backupBefore } from './backups.ts'
import type { Deps } from './ports.ts'

const warn = (message: string): void => console.warn(`team: memory reorganization: ${message}`)

/** Files per model call, and the text shown of each (a proposal needs the gist, not every line). */
export const BATCH_FILES = 12
export const BATCH_CHARS = 24_000
export const PREVIEW_CHARS = 1_800

async function loadSources(deps: Deps, agentId: string): Promise<ReorgSourceFile[]> {
  const prefix = `${agentMemory(agentId)}/`
  const out: ReorgSourceFile[] = []
  for (const meta of deps.library.list({ prefix, limit: 1000 })) {
    const file = await deps.library.read(meta.path)
    out.push({
      path: meta.path.slice(prefix.length),
      text: file?.text ?? null,
      version: meta.version,
      size: meta.size,
    })
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1))
}

const libraryPaths = (deps: Deps): Set<string> =>
  new Set(deps.library.list({ prefix: '/library/', limit: 100_000 }).map((m) => m.path))

async function planOf(
  deps: Deps,
  agentId: string,
  slug: string,
  rows: readonly ReorgRow[],
): Promise<{ plan: ReorgPlan; files: ReorgSourceFile[] }> {
  const files = await loadSources(deps, agentId)
  const plan = buildReorgPlan({
    agentSlug: slug,
    agentId,
    files,
    rows,
    libraryPaths: libraryPaths(deps),
  })
  return { plan, files }
}

const SYSTEM = [
  'You help reorganize the memory of an AI agent in a small company. The library is the source of',
  'truth for facts; memory keeps only short rules and an index that points into the library.',
  '',
  'Library folders:',
  ...LIBRARY_FOLDERS.map((f) => `- ${f.path}: ${f.holds}`),
  '- /library/data/: trackers, ledgers, sheets',
  '',
  'For every memory file choose exactly one action:',
  '- "keep-as-rule": a short standing rule or preference the agent must always follow (merged into rules.md).',
  '- "move": facts, procedures, people, knowledge, data. Give "target": an absolute path under /library/ in the folders above (English folder and file names).',
  '- "merge-into": the file repeats another file of the list. Give "target": that other file path exactly as listed.',
  '- "archive": stale, finished or obsolete. Nothing is deleted: it is kept in an archive folder.',
  'Dated reports go to /library/reports/. Never choose a path outside /library/.',
  '',
  'Answer with ONLY a JSON array, one object per file:',
  '[{"file":"<path as listed>","action":"keep-as-rule|move|merge-into|archive","target":"<path or null>","reason":"<one short line>"}]',
].join('\n')

function batches(files: readonly ReorgSourceFile[]): ReorgSourceFile[][] {
  const out: ReorgSourceFile[][] = []
  let cur: ReorgSourceFile[] = []
  let chars = 0
  for (const f of files) {
    const n = Math.min(f.text?.length ?? 0, PREVIEW_CHARS) + f.path.length + 40
    if (cur.length > 0 && (cur.length >= BATCH_FILES || chars + n > BATCH_CHARS)) {
      out.push(cur)
      cur = []
      chars = 0
    }
    cur.push(f)
    chars += n
  }
  if (cur.length > 0) out.push(cur)
  return out
}

const promptOf = (batch: readonly ReorgSourceFile[]): string =>
  batch
    .map((f) => {
      const text = f.text ?? '(binary file)'
      const body =
        text.length > PREVIEW_CHARS
          ? `${text.slice(0, PREVIEW_CHARS)}\n[... ${text.length - PREVIEW_CHARS} more characters]`
          : text
      return `=== ${f.path} (${f.size} bytes)\n${body}`
    })
    .join('\n\n')

export interface ReorgProposal {
  plan: ReorgPlan
  /** Batches that could not be proposed (their files default to a safe move into knowledge/). */
  warnings: string[]
  modelCalls: number
}

/** The rows only, for a plan. Memory that has nothing to move gives an empty proposal. */
export async function proposeReorg(deps: Deps, agentRef: string): Promise<ReorgProposal> {
  const agent = getAgent(deps, agentRef)
  if (deps.completion === undefined) {
    throw conflict(
      'No model is available for this server (scripted or keyless setup).',
      'COMPLETION_UNAVAILABLE',
    )
  }
  const files = await loadSources(deps, agent.id)
  const movable = files.filter((f) => ![HEARTBEAT_FILE, RULES_FILE, INDEX_FILE].includes(f.path))
  const rows: ReorgRow[] = []
  const warnings: string[] = []
  let modelCalls = 0
  for (const batch of batches(movable)) {
    modelCalls++
    try {
      const answer = await deps.completion(agent.id, {
        system: SYSTEM,
        prompt: `Memory files of the agent "${agent.name}":\n\n${promptOf(batch)}`,
        maxOutputTokens: 4_000,
      })
      rows.push(
        ...parseProposal(
          answer,
          batch.map((f) => f.path),
        ),
      )
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      warnings.push(
        `The model could not propose for ${batch.map((f) => f.path).join(', ')} (${why}): they default to knowledge/. Change them below.`,
      )
      rows.push(
        ...parseProposal(
          '',
          batch.map((f) => f.path),
        ),
      )
    }
  }
  const { plan } = await planOf(deps, agent.id, agent.slug, rows)
  return { plan, warnings, modelCalls }
}

/** Validate the rows an owner edited (shape only; the plan does the real checks). */
export function cleanRows(raw: ReadonlyArray<Partial<ReorgRow>>): ReorgRow[] {
  return raw.map((r) => {
    if (typeof r.source !== 'string' || r.source === '')
      throw invalid('every row needs a source', 'INVALID_REORG')
    if (!(REORG_ACTIONS as readonly string[]).includes(String(r.action))) {
      throw invalid(`unknown action for ${r.source}`, 'INVALID_REORG')
    }
    return {
      source: r.source,
      action: r.action as ReorgRow['action'],
      target: typeof r.target === 'string' && r.target.trim() !== '' ? r.target.trim() : null,
      reason: typeof r.reason === 'string' ? r.reason.slice(0, 200) : '',
    }
  })
}

export async function previewReorg(
  deps: Deps,
  agentRef: string,
  rows: ReadonlyArray<Partial<ReorgRow>>,
): Promise<ReorgPlan> {
  const agent = getAgent(deps, agentRef)
  return (await planOf(deps, agent.id, agent.slug, cleanRows(rows))).plan
}

export interface ReorgResult {
  restorePointId: string | null
  safetyBackupId: string | null
  counts: RestorePoint['counts']
  items: RestorePoint['items']
}

/**
 * Apply a plan. `backupBefore` runs first and aborts everything when it fails. A step that fails
 * leaves its original file in memory (nothing is moved before its content is safely written and
 * read back), so a partial run never loses data; the failure is in `counts.failed` and `items`.
 */
export async function applyReorg(
  deps: Deps,
  agentRef: string,
  rawRows: ReadonlyArray<Partial<ReorgRow>>,
  options: { by?: string } = {},
): Promise<ReorgResult> {
  const agent = getAgent(deps, agentRef)
  const port = backupPort(deps)
  const { plan, files } = await planOf(deps, agent.id, agent.slug, cleanRows(rawRows))
  if (!plan.ok) {
    throw invalid(
      `The plan has errors: ${plan.issues
        .filter((i) => i.level === 'error')
        .map((i) => `${i.source}: ${i.message}`)
        .join('; ')}`,
      'REORG_PLAN_INVALID',
    )
  }
  const rulesChanged = plan.rules.after !== plan.rules.before
  const indexChanged = plan.index.after !== plan.index.before
  if (plan.rows.length === 0 && !rulesChanged) {
    return {
      restorePointId: null,
      safetyBackupId: null,
      counts: { added: 0, changed: 0, removed: 0, failed: 0 },
      items: [],
    }
  }
  const safety = await backupBefore(deps, 'memory reorganization')
  if (!safety.ok) {
    throw conflict(
      `Nothing was changed: the safety backup failed (${safety.error})`,
      'BACKUP_FAILED',
    )
  }
  const root = `${agentMemory(agent.id)}/`
  const counts = { added: 0, changed: 0, removed: 0, failed: 0 }
  const items: RestorePoint['items'] = []
  const fail = (key: string, note: string): void => {
    counts.failed++
    items.push({ key, action: 'failed', note })
  }
  const byPath = new Map(files.map((f) => [f.path, f]))

  // 1. the new library files, each read back
  const ok = new Set<string>()
  for (const w of plan.writes) {
    try {
      const out = await deps.library.writeText(w.path, w.text, null)
      if (!out.ok) throw new Error('the file appeared meanwhile')
      const back = await deps.library.read(w.path)
      if (back?.text !== w.text) throw new Error('it did not read back as written')
      ok.add(w.path)
      counts.added++
      items.push({ key: w.path, action: 'added' })
    } catch (error) {
      fail(w.path, error instanceof Error ? error.message : String(error))
    }
  }

  // 2. rules.md and index.md: the old text is copied to the originals folder first
  let rulesOk = !rulesChanged
  const rewrite = async (name: string, after: string, before: string): Promise<boolean> => {
    const src = byPath.get(name)
    try {
      if (src !== undefined && before !== '') {
        const copy = await deps.library.writeText(
          name === RULES_FILE ? plan.originals.rules : plan.originals.index,
          before,
          null,
        )
        if (!copy.ok) throw new Error('the original copy already exists')
      }
      const out = await deps.library.writeText(
        `${root}${name}`,
        after,
        src === undefined ? null : src.version,
      )
      if (!out.ok) throw new Error('it changed meanwhile')
      counts[src === undefined ? 'added' : 'changed']++
      items.push({ key: `${root}${name}`, action: src === undefined ? 'added' : 'changed' })
      return true
    } catch (error) {
      fail(`${root}${name}`, error instanceof Error ? error.message : String(error))
      return false
    }
  }
  if (rulesChanged) rulesOk = await rewrite(RULES_FILE, plan.rules.after, plan.rules.before)
  if (indexChanged) await rewrite(INDEX_FILE, plan.index.after, plan.index.before)

  // 3. the originals move (never deleted) once their content is safe elsewhere
  for (const row of plan.rows) {
    const src = byPath.get(row.source)
    if (src === undefined) continue
    const safe =
      row.action === 'keep-as-rule'
        ? rulesOk
        : row.action === 'archive'
          ? true
          : ok.has(row.finalTarget)
    if (!safe) {
      fail(`${root}${row.source}`, 'its new place was not written: the file stays in memory')
      continue
    }
    const out = await deps.library.move(`${root}${row.source}`, row.originalPath, src.version)
    if (out.ok) {
      counts.removed++
      items.push({
        key: `${root}${row.source}`,
        action: 'removed',
        note: `kept at ${row.originalPath}`,
      })
    } else {
      fail(`${root}${row.source}`, `could not be moved (${out.reason}): it stays in memory`)
    }
  }

  const at = deps.clock.now()
  const point: RestorePoint = {
    id: restorePointId(at),
    at,
    by: options.by ?? 'web',
    kind: 'memory-reorganization',
    source: {
      kind: 'backup',
      backupId: safety.backup.id,
      label: `memory reorganization of ${agent.name}`,
    },
    safetyBackupId: safety.backup.id,
    sections: ['library', 'memory'],
    removedSections: [],
    counts,
    items: [
      ...items.filter((i) => i.action === 'failed'),
      ...items.filter((i) => i.action !== 'failed'),
    ].slice(0, 500),
    undoOf: null,
    undoneBy: null,
  }
  try {
    port.restorePoints.add(point)
  } catch (error) {
    warn(`restore point not stored: ${String(error)}`)
  }
  return { restorePointId: point.id, safetyBackupId: safety.backup.id, counts, items: point.items }
}
