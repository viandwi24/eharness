/**
 * The big-data toolkit as one plugin (docs/plans/P40-team-autonomous-operations.md, D7 and D8):
 *
 * - `run_code`: sandboxed JavaScript over library files, so the model computes over thousands of
 *   items instead of reading them (`code-sandbox.ts`);
 * - `ingest_source`: pull the new items of a collector into `/library/data/...` (`ingest.ts`);
 * - `manifest_create`, `manifest_next`, `manifest_mark`, `manifest_status`: the checkpoint of a
 *   chunked job (`domain/manifest.ts`), so a run that stops resumes where it was.
 *
 * Authority: every path these tools touch is checked against the program of the session, with the
 * same rules the permission engine applies to `read_file` and `write_file` (see `PathAccess`). A
 * session that is not a program run has no authority and the tools say so. Errors are returned as
 * text starting with `ERROR:`, never thrown (the model reads them and corrects itself).
 */
import { type Tool, tool } from 'ai'
import { definePlugin, type HarnessPlugin } from 'eharness'
import type { FileSystem } from 'eharness/filesystem'
import { compileGlob } from 'eharness/filesystem'
import { z } from 'zod'
import { type Collector, cursorPath, sourcePrefix } from '../../domain/collectors.ts'
import { DomainError } from '../../domain/errors.ts'
import { normalizeFilePath } from '../../domain/library.ts'
import {
  checkRunId,
  createManifest,
  findingsPath,
  MAX_CHUNK_ATTEMPTS,
  type Manifest,
  type ManifestChunk,
  manifestPath,
  markChunk,
  nextChunks,
  parseManifest,
  progressOf,
  WORK_ROOT,
} from '../../domain/manifest.ts'
import type { CodeRunner } from './code-sandbox.ts'
import { IngestRefused, ingestSource, ingestSummary } from './ingest.ts'

/** What the program of a session lets its run read and write (library paths). */
export interface PathAccess {
  canRead(path: string): boolean
  canWrite(path: string): boolean
}

export interface BigDataOptions {
  /** The library, as the agent of the session sees it (writes are attributed to it). */
  fs: FileSystem
  /** The authority of a session: undefined when it is not a program run. */
  access: (sessionId: string) => PathAccess | undefined
  collectors: () => readonly Collector[]
  runner: CodeRunner
  /** Tool names to offer (the connector's capabilities that are not off). Default: all. */
  tools?: readonly string[]
  now?: () => number
}

export const BIGDATA_TOOLS = {
  code: ['run_code'],
  ingest: ['ingest_source'],
  manifest: ['manifest_create', 'manifest_next', 'manifest_mark', 'manifest_status'],
} as const

const NO_AUTHORITY = (tool: string): string =>
  `ERROR: ${tool} works inside a program run only: the program's authority decides which library ` +
  'paths it may read and write, and this session has no program.'

const kb = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`

const GLOB_CHARS = /[*?[{]/

const RUN_CODE_DESCRIPTION = `Run JavaScript (Bun, an ES module, top-level await works) over library files WITHOUT reading them into this conversation. Use it for anything that touches many items: counting, filtering, grouping, finding candidates, merging results. Never read thousands of lines yourself; compute, then print a short summary.

Input: "code", and "reads": the library files the code needs, as paths, directories (end with "/") or globs, for example ["/library/data/community/**/2026-10-11/*.jsonl"]. They are copied into a private sandbox first; only paths your program may read are copied (the result says how many were skipped). At most 600 files and 32 MB.

Inside the code the library paths work as-is, through these globals:
  readText(path)  readJson(path)  readJsonl(path)  readJsonlDir(prefix)  list(prefix)  exists(path)
  writeText(path, text)  writeJson(path, value)  writeJsonl(path, rows)
  chunkBySize(rows, maxBytes)  print(valueOrString)
Plain node:fs and Bun APIs also work on the sandbox directory, but use the globals for library paths.

Output: whatever the code prints (stdout, about 12 KB; more is cut and the run stops). Print summaries and counts, not raw data. Files the code writes under a library path are saved to the library after a SUCCESSFUL run (exit code 0), only where your program may write; the others are listed as not saved. If the code fails or times out nothing is saved. Deleting files is not possible.

Limits: 30 seconds by default (timeoutSeconds, at most 120), no network, no access outside the sandbox directory for writing, no installing packages. Only built-in modules (node:*) and Bun.

Example (find link shares and burst posters in one day, write candidates for review):
  const rows = readJsonlDir('/library/data/community/', '.jsonl')
  const links = rows.filter(r => /https?:\\/\\//.test(r.text ?? ''))
  const byAuthor = {}
  for (const r of rows) byAuthor[r.author] = (byAuthor[r.author] ?? 0) + 1
  const top = Object.entries(byAuthor).sort((a, b) => b[1] - a[1]).slice(0, 5)
  writeJsonl('/library/work/audit-2026-10-11/candidates/links.jsonl', links)
  print({ total: rows.length, links: links.length, top })`

const INGEST_DESCRIPTION =
  'Pull the new items of a data source into the library, deterministically (no model reads them): ' +
  'they land as hourly JSONL files /library/data/<source>/<channel>/<YYYY-MM-DD>/<HH>.jsonl, one JSON ' +
  'item per line, and a cursor remembers where the source stopped, so calling it again fetches only ' +
  'what is new. The result is a short summary; read the data with run_code, not by opening files.'

const MANIFEST_NOTE =
  'A manifest is the checkpoint of a chunked job: /library/work/<run>/manifest.json lists the chunks ' +
  'and their status (pending, done, failed). A run that stops resumes from it. Use one run id per ' +
  'job and day, for example community-audit-2026-10-11, so a later run finds the same manifest.'

async function statOf(fs: FileSystem, path: string): Promise<{ version: string } | null> {
  if (fs.stat !== undefined) return fs.stat(path)
  return fs.read(path)
}

/** Read the manifest file with its version; retried writes need the version. */
async function loadManifest(
  fs: FileSystem,
  run: string,
): Promise<{ manifest: Manifest; version: string } | undefined> {
  const entry = await fs.read(manifestPath(run))
  if (entry === null) return undefined
  const manifest = parseManifest(entry.content)
  return manifest === undefined ? undefined : { manifest, version: entry.version }
}

export function bigData(options: BigDataOptions): HarnessPlugin<'bigdata'> {
  const { fs, runner } = options
  const now = options.now ?? Date.now
  const enabled = (name: string): boolean =>
    options.tools === undefined || options.tools.includes(name)

  /** Library paths a `reads` entry names, filtered by authority. */
  async function expandReads(
    entries: readonly string[],
    access: PathAccess,
  ): Promise<{ paths: string[]; denied: string[]; unreadable: number; error?: string }> {
    const paths = new Set<string>()
    const denied: string[] = []
    let unreadable = 0
    for (const raw of entries) {
      let entry: string
      try {
        entry = raw.endsWith('/')
          ? `${normalizeFilePath(raw.slice(0, -1))}/`
          : normalizeFilePath(raw)
      } catch (error) {
        const globbed = GLOB_CHARS.test(raw) && raw.startsWith('/') && !raw.includes('..')
        if (!globbed) {
          return {
            paths: [],
            denied,
            unreadable,
            error: `bad path in reads: ${raw} (${String(error instanceof DomainError ? error.message : error)})`,
          }
        }
        entry = raw
      }
      let found: string[]
      if (GLOB_CHARS.test(entry)) {
        const cut = entry.search(GLOB_CHARS)
        const prefix = entry.slice(0, entry.lastIndexOf('/', cut) + 1)
        const rest = entry.slice(prefix.length)
        const compiled = compileGlob(rest)
        if (!compiled.ok)
          return { paths: [], denied, unreadable, error: `bad glob ${raw}: ${compiled.error}` }
        const metas = await fs.list(prefix)
        found = metas.filter((m) => compiled.test(m.path.slice(prefix.length))).map((m) => m.path)
      } else if (entry.endsWith('/')) {
        found = (await fs.list(entry)).map((m) => m.path)
      } else {
        const meta = await statOf(fs, entry)
        if (meta !== null) found = [entry]
        else found = (await fs.list(`${entry}/`)).map((m) => m.path)
        if (found.length === 0)
          return {
            paths: [],
            denied,
            unreadable,
            error: `no such library file or directory: ${entry}`,
          }
        if (meta !== null && !access.canRead(entry)) {
          denied.push(entry)
          continue
        }
      }
      for (const p of found) {
        if (access.canRead(p)) paths.add(p)
        else unreadable++
      }
    }
    return { paths: [...paths].sort(), denied, unreadable }
  }

  async function runCode(
    sessionId: string,
    input: { code: string; reads?: string[] | undefined; timeoutSeconds?: number | undefined },
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const access = options.access(sessionId)
    if (access === undefined) return NO_AUTHORITY('run_code')
    const limits = runner.limits
    const expanded = await expandReads(input.reads ?? [], access)
    if (expanded.error !== undefined) return `ERROR: ${expanded.error}`
    if (expanded.denied.length > 0) {
      return `ERROR: not granted to read: ${expanded.denied.join(', ')}. Your program may read only the paths of its authority; report it as needing a decision if you need more.`
    }
    if (expanded.paths.length > limits.maxInputFiles) {
      return `ERROR: reads matches ${expanded.paths.length} files, over the limit of ${limits.maxInputFiles}. Narrow the paths (one day, one channel) and run again, or run the code once per part.`
    }
    const inputs = new Map<string, Uint8Array>()
    let bytes = 0
    for (const path of expanded.paths) {
      const file = await fs.readBytes?.(path)
      if (file === null || file === undefined) continue
      bytes += file.bytes.byteLength
      if (bytes > limits.maxInputBytes) {
        return `ERROR: reads is over ${kb(limits.maxInputBytes)} in total. Narrow the paths and run again.`
      }
      inputs.set(path, file.bytes)
    }

    const result = await runner.run({
      code: input.code,
      inputs,
      ...(input.timeoutSeconds === undefined ? {} : { timeoutMs: input.timeoutSeconds * 1000 }),
      ...(signal === undefined ? {} : { signal }),
    })
    const sandbox = result.sandbox.os
      ? `OS sandbox ${result.sandbox.kind}, no network`
      : 'no OS sandbox on this host: environment stripped, soft network guard'
    const head = `${(result.durationMs / 1000).toFixed(1)}s, ${sandbox}`
    if (result.error !== undefined) return `ERROR: ${result.error}`
    if (result.aborted) return 'ERROR: run_code was cancelled; nothing was saved.'
    const out = [
      result.stdout.trim() === '' ? '' : `stdout:\n${result.stdout.trimEnd()}`,
      result.stderr.trim() === '' ? '' : `stderr:\n${result.stderr.trimEnd()}`,
    ].filter((s) => s !== '')
    if (result.timedOut) {
      return [
        `ERROR: the code ran over its time limit and was stopped (${head}). Nothing was saved. Do less per run (a smaller read, one pass), or raise timeoutSeconds (at most ${limits.maxTimeoutMs / 1000}).`,
        ...out,
      ].join('\n')
    }
    if (result.outputTruncated) {
      return [
        `ERROR: the code printed more than ${kb(limits.maxOutputBytes)} and was stopped (${head}). Nothing was saved. Print a summary or counts, write the details to a file.`,
        ...out,
      ].join('\n')
    }
    if (result.exitCode !== 0) {
      return [
        `ERROR: the code exited with code ${String(result.exitCode)} (${head}). Nothing was saved. Fix the code and run again.`,
        ...out,
      ].join('\n')
    }

    // write back what the code produced, where the program may write
    const saved: string[] = []
    const refused: string[] = []
    for (const [path, content] of result.files) {
      let normalized: string
      try {
        normalized = normalizeFilePath(path)
      } catch {
        refused.push(`${path} (not a valid library path)`)
        continue
      }
      if (!access.canWrite(normalized)) {
        refused.push(`${normalized} (outside your write authority)`)
        continue
      }
      const written = await fs.writeBytes?.(normalized, content)
      if (written?.ok === true) saved.push(`${normalized} (${kb(content.byteLength)})`)
      else refused.push(`${normalized} (the library refused the write)`)
    }
    const list = (items: string[]): string =>
      items.slice(0, 25).join(', ') + (items.length > 25 ? `, and ${items.length - 25} more` : '')
    return [
      `Ran ok (${head}). Read in: ${inputs.size} files, ${kb(bytes)}${expanded.unreadable > 0 ? `; ${expanded.unreadable} more matched files were skipped (outside your read authority)` : ''}.`,
      ...out,
      saved.length > 0 ? `Saved ${saved.length} files: ${list(saved)}.` : 'Saved no files.',
      refused.length > 0 ? `NOT saved: ${list(refused)}.` : '',
      result.skipped.length > 0
        ? `Not collected: ${list(result.skipped.map((s) => `${s.path} (${s.reason})`))}.`
        : '',
    ]
      .filter((s) => s !== '')
      .join('\n')
  }

  async function ingest(
    sessionId: string,
    input: { source: string; maxItems?: number | undefined },
  ): Promise<string> {
    const access = options.access(sessionId)
    if (access === undefined) return NO_AUTHORITY('ingest_source')
    const collector = options.collectors().find((c) => c.id === input.source)
    if (collector === undefined) {
      const ids = options.collectors().map((c) => c.id)
      return `ERROR: unknown source "${input.source}". Available: ${ids.length === 0 ? 'none configured' : ids.join(', ')}.`
    }
    if (!access.canWrite(cursorPath(collector.id))) {
      return `ERROR: not granted to write ${sourcePrefix(collector.id)}**: ingest needs write authority on the source's directory. Report it as needing a decision.`
    }
    try {
      const result = await ingestSource(fs, collector, {
        ...(input.maxItems === undefined ? {} : { maxItems: input.maxItems }),
        canWrite: access.canWrite,
        now,
      })
      return ingestSummary(result)
    } catch (error) {
      if (error instanceof IngestRefused) return `ERROR: ${error.message}`
      return `ERROR: ingest of ${collector.id} failed: ${error instanceof Error ? error.message : String(error)}. Nothing is lost: call it again to retry from the cursor.`
    }
  }

  /** Read-modify-write of a manifest with compare-and-set (several workers may mark at once). */
  async function updateManifest(
    run: string,
    change: (m: Manifest) => { manifest: Manifest; reply: string } | { error: string },
  ): Promise<string> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const loaded = await loadManifest(fs, run)
      if (loaded === undefined) {
        return `ERROR: no manifest for run ${run}. Create it with manifest_create first. ${MANIFEST_NOTE}`
      }
      const changed = change(loaded.manifest)
      if ('error' in changed) return `ERROR: ${changed.error}`
      const written = await fs.write(
        manifestPath(run),
        `${JSON.stringify(changed.manifest, null, 2)}\n`,
        { ifVersion: loaded.version },
      )
      if (written.ok) return changed.reply
    }
    return `ERROR: the manifest of ${run} keeps changing; try again.`
  }

  const describeChunk = (c: ManifestChunk): string =>
    `- ${c.id}${c.status === 'failed' ? ` (failed ${c.attempts}x: ${c.error ?? 'no reason'})` : ''}${c.note === undefined ? '' : `: ${c.note}`}${c.paths.length > 0 ? ` | files: ${c.paths.slice(0, 5).join(', ')}${c.paths.length > 5 ? ', ...' : ''}` : ''}`

  const progressLine = (m: Manifest): string => {
    const p = progressOf(m)
    return `Manifest ${m.run}: ${p.done}/${p.total} chunks done, ${p.pending} pending, ${p.retryable} failed with attempts left, ${p.exhausted} failed for good${p.lastDone === null ? '' : `; last done: ${p.lastDone}`}.`
  }

  const manifestGuard = (
    sessionId: string,
    name: string,
    run: string,
    need: 'read' | 'write',
  ): string | undefined => {
    const access = options.access(sessionId)
    if (access === undefined) return NO_AUTHORITY(name)
    try {
      checkRunId(run)
    } catch (error) {
      return `ERROR: ${error instanceof Error ? error.message : String(error)}`
    }
    const path = manifestPath(run)
    const granted = need === 'read' ? access.canRead(path) : access.canWrite(path)
    return granted
      ? undefined
      : `ERROR: not granted to ${need} ${path}: your program needs ${need} authority on ${WORK_ROOT}/** (or this run's folder). Report it as needing a decision.`
  }

  return definePlugin({
    name: 'bigdata',
    session(ctx) {
      const sessionId = ctx.session.id
      // biome-ignore lint/suspicious/noExplicitAny: tools of different input types in one record
      const tools: Record<string, Tool<any, any>> = {}

      if (enabled('run_code')) {
        tools.run_code = tool({
          description: RUN_CODE_DESCRIPTION,
          inputSchema: z.object({
            code: z
              .string()
              .min(1)
              .max(40_000)
              .describe(
                'JavaScript (ES module). Print a short summary with print() or console.log.',
              ),
            reads: z
              .array(z.string())
              .max(30)
              .optional()
              .describe(
                'Library paths, directories ending with "/" or globs to copy into the sandbox.',
              ),
            timeoutSeconds: z.number().int().min(1).max(120).optional().describe('Default 30.'),
          }),
          execute: (input, opts) => runCode(sessionId, input, opts?.abortSignal),
        })
      }
      if (enabled('ingest_source')) {
        tools.ingest_source = tool({
          description: INGEST_DESCRIPTION,
          inputSchema: z.object({
            source: z.string().min(1).describe('The source id, for example "community".'),
            maxItems: z
              .number()
              .int()
              .min(1)
              .max(100_000)
              .optional()
              .describe('Stop after about this many new items (default: everything new).'),
          }),
          execute: (input) => ingest(sessionId, input),
        })
      }
      if (enabled('manifest_create')) {
        tools.manifest_create = tool({
          description: `Create the manifest of a chunked job. ${MANIFEST_NOTE} Give the chunks, or "fromFiles" (a directory whose files become one chunk each, named after the file). If the manifest already exists nothing changes and you get its progress: carry on with manifest_next (that is how a stopped run resumes).`,
          inputSchema: z.object({
            run: z.string().describe('Run id, for example community-audit-2026-10-11.'),
            purpose: z.string().max(500).optional(),
            chunks: z
              .array(
                z.object({
                  id: z.string(),
                  paths: z.array(z.string()).max(50).optional(),
                  note: z.string().max(300).optional(),
                }),
              )
              .max(500)
              .optional(),
            fromFiles: z
              .string()
              .optional()
              .describe(
                'A library directory, for example /library/work/<run>/chunks/ : each file is a chunk.',
              ),
          }),
          execute: async (input) => {
            const bad = manifestGuard(sessionId, 'manifest_create', input.run, 'write')
            if (bad !== undefined) return bad
            const access = options.access(sessionId) as PathAccess
            const existing = await loadManifest(fs, input.run)
            if (existing !== undefined) {
              return `${progressLine(existing.manifest)} The manifest already exists, so it was not changed: resume with manifest_next.`
            }
            let specs = input.chunks
            if (specs === undefined && input.fromFiles !== undefined) {
              const dir = input.fromFiles.endsWith('/') ? input.fromFiles : `${input.fromFiles}/`
              const files = (await fs.list(dir)).filter((m) => access.canRead(m.path))
              specs = files.map((m) => ({
                id: (m.path.split('/').at(-1) as string).replace(/\.[^.]+$/, ''),
                paths: [m.path],
              }))
              if (specs.length === 0) return `ERROR: no readable files under ${dir}.`
            }
            if (specs === undefined) return 'ERROR: give "chunks" or "fromFiles".'
            let manifest: Manifest
            try {
              manifest = createManifest(input.run, specs, now(), input.purpose)
            } catch (error) {
              return `ERROR: ${error instanceof Error ? error.message : String(error)}`
            }
            const written = await fs.write(
              manifestPath(input.run),
              `${JSON.stringify(manifest, null, 2)}\n`,
              { ifVersion: null },
            )
            if (!written.ok) {
              const again = await loadManifest(fs, input.run)
              return again === undefined
                ? 'ERROR: the manifest could not be written.'
                : `${progressLine(again.manifest)} It was created just now by another worker: resume with manifest_next.`
            }
            return `${progressLine(manifest)} Created ${manifestPath(input.run)}. Next: manifest_next, process a chunk, write its findings to ${WORK_ROOT}/${input.run}/findings/<chunk>.json, then manifest_mark.`
          },
        })
      }
      if (enabled('manifest_next')) {
        tools.manifest_next = tool({
          description:
            'The next chunks of a manifest to work on: pending ones in order, then failed ones that still have attempts left (each chunk gets 3 attempts). Does not change anything: a chunk stays pending until manifest_mark. When nothing is left you are done: reduce the findings.',
          inputSchema: z.object({
            run: z.string(),
            limit: z
              .number()
              .int()
              .min(1)
              .max(10)
              .optional()
              .describe('How many chunks to return (default 1).'),
          }),
          execute: async (input) => {
            const bad = manifestGuard(sessionId, 'manifest_next', input.run, 'read')
            if (bad !== undefined) return bad
            const loaded = await loadManifest(fs, input.run)
            if (loaded === undefined)
              return `ERROR: no manifest for run ${input.run}. ${MANIFEST_NOTE}`
            const next = nextChunks(loaded.manifest, input.limit ?? 1)
            if (next.length === 0) {
              return `${progressLine(loaded.manifest)} Nothing left to process: reduce the findings (${WORK_ROOT}/${input.run}/findings/*.json) into the final report.`
            }
            return [
              progressLine(loaded.manifest),
              'Next:',
              ...next.map(describeChunk),
              `Write the findings of a chunk to ${WORK_ROOT}/${input.run}/findings/<chunk>.json, then call manifest_mark.`,
            ].join('\n')
          },
        })
      }
      if (enabled('manifest_mark')) {
        tools.manifest_mark = tool({
          description: `Mark a chunk done or failed. "done" needs its findings file to exist and to be valid JSON (default ${WORK_ROOT}/<run>/findings/<chunk>.json, or pass "findings"): a chunk is done only when its result is saved. "failed" counts an attempt (3 at most) and records why. Safe to call from parallel workers.`,
          inputSchema: z.object({
            run: z.string(),
            chunk: z.string(),
            status: z.enum(['done', 'failed']),
            findings: z
              .string()
              .optional()
              .describe('Library path of the findings file (default: the standard path).'),
            error: z.string().max(500).optional().describe('Why it failed.'),
          }),
          execute: async (input) => {
            const bad = manifestGuard(sessionId, 'manifest_mark', input.run, 'write')
            if (bad !== undefined) return bad
            let findings: string | undefined
            if (input.status === 'done') {
              findings = input.findings ?? findingsPath(input.run, input.chunk)
              const file = await fs.read(findings)
              if (file === null) {
                return `ERROR: ${findings} does not exist. Write the findings of chunk ${input.chunk} first, then mark it done.`
              }
              try {
                JSON.parse(file.content)
              } catch {
                return `ERROR: ${findings} is not valid JSON. Fix the file, then mark the chunk done.`
              }
            }
            return updateManifest(input.run, (m) => {
              const marked = markChunk(
                m,
                input.chunk,
                { status: input.status, findings, error: input.error },
                now(),
              )
              return marked.ok
                ? {
                    manifest: marked.manifest,
                    reply: `Chunk ${input.chunk} marked ${input.status}. ${progressLine(marked.manifest)}`,
                  }
                : { error: marked.error }
            })
          },
        })
      }
      if (enabled('manifest_status')) {
        tools.manifest_status = tool({
          description:
            'Progress of a manifest: counts, the last chunk done, the failed chunks. Cheap; use it first when you resume a job to see what is left.',
          inputSchema: z.object({ run: z.string() }),
          execute: async (input) => {
            const bad = manifestGuard(sessionId, 'manifest_status', input.run, 'read')
            if (bad !== undefined) return bad
            const loaded = await loadManifest(fs, input.run)
            if (loaded === undefined)
              return `ERROR: no manifest for run ${input.run}. ${MANIFEST_NOTE}`
            const failed = loaded.manifest.chunks.filter((c) => c.status === 'failed')
            return [
              progressLine(loaded.manifest),
              loaded.manifest.purpose === undefined ? '' : `Purpose: ${loaded.manifest.purpose}`,
              progressOf(loaded.manifest).complete ? 'Nothing is left to process.' : '',
              ...failed
                .slice(0, 10)
                .map(
                  (c) =>
                    `Failed: ${describeChunk(c)} (${c.attempts}/${MAX_CHUNK_ATTEMPTS} attempts)`,
                ),
            ]
              .filter((s) => s !== '')
              .join('\n')
          },
        })
      }
      return { tools }
    },
  })
}
