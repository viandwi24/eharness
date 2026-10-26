/**
 * `scripts` plugin (P59 W6, ADR-0065): the agent tools over scripts.
 *
 *  - `scripts_read` (read): list, view (code and manifest of a version), versions, types (the
 *    `ctx` API), runs (traces), run (one trace in full).
 *  - `scripts_write` (write): create, update (a new version), dry_run, request_activation,
 *    run_now, disable, delete (needs `confirm: true`).
 *
 * The agent writes and tests scripts. A script runs on its own once a person approved it: either
 * the owner or an admin asked for it in this chat (`request_activation` then activates at once;
 * Settings `scriptsChatApproval`), or on the Scripts page. A new version of an approved script
 * that widens nothing (same triggers, no wider grants or caps) the agent may switch to itself. Who may use the tools: like `tables` — the web
 * owner, an owner or admin in a chat, and unattended runs. Answers are lines; errors `ERROR:` lines.
 */
import { tool } from 'ai'
import { definePlugin, errorText, type HarnessContext, type HarnessPlugin } from 'eharness'
import { z } from 'zod'
import type { Deps } from '../../app/ports.ts'
import {
  activateScript,
  checkScriptCode,
  createScript,
  deleteScript,
  disableScript,
  dryRunScript,
  getRun,
  getScript,
  getVersion,
  listRuns,
  listScripts,
  listVersions,
  runScriptNow,
  type ScriptActor,
  scriptTypesText,
  updateScript,
  versionManifest,
} from '../../app/scripts.ts'
import { DomainError } from '../../domain/errors.ts'
import { originOfSession } from '../../domain/run-profiles.ts'
import type { HostCallRecord, Script, ScriptRun } from '../../domain/scripts.ts'
import type { ChannelGateway } from '../channels/gateway.ts'

export const SCRIPTS_READ_TOOL = 'scripts_read'
export const SCRIPTS_WRITE_TOOL = 'scripts_write'

export interface ScriptsPluginOptions {
  app: () => Deps | undefined
  gateway: () => ChannelGateway | undefined
  agentOf: (slug: string) => { id: string; name: string } | undefined
}

const OUTPUT_CHARS = 14_000
const NOT_ALLOWED =
  'Not allowed: scripts are for the owner and the admins of the team. Say so plainly and tell the person to ask one of them.'

const manifestField = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    'The manifest: { triggers: [...], grants: {...}, cooldownSec?, maxRunsPerHour?, limits? }. Triggers: { kind: "channel", events: ["message.created"], connections?: [id], chats?: [title|id], actorRoles?: ["member"], actors?: [id|@user], textContains?: ["halo"], textRegex? } | { kind: "schedule", spec: { kind: "cron", expr: "0 9 * * *", timezone? } | { kind: "every", everyMs } } | { kind: "table", table, events: ["row.created"] } | { kind: "app", events: ["task-changed", "program-changed", "alarm-raised", ...], agents?: [slug], match?: { field: value } } | { kind: "webhook" } (a secret URL; POST runs it). Grants (default: nothing): send: [{ connection, chat, topic? }], reply: true, libraryRead/libraryWrite: ["/library/reports/**"], tablesRead/tablesWrite: [name|"*"], http: ["api.example.com"], wake: [agent slug], programs: [name], api: ["GET /tasks/**", "POST /programs/*/run"] (the team API; scripts, secrets and sign-in are never callable). Read scripts_read action "types" for the ctx API.',
  )

const readSchema = z.object({
  action: z.enum(['list', 'view', 'versions', 'types', 'check', 'runs', 'run']),
  script: z.string().optional().describe('Script name or id (view, versions, runs, run).'),
  version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('view, check: a version (default the latest).'),
  runId: z.string().optional().describe('run: the run id from runs.'),
  limit: z.number().int().min(1).max(50).optional().describe('runs: how many (default 10).'),
  dryRun: z.boolean().optional().describe('runs: only dry runs (true) or only real runs (false).'),
})

const writeSchema = z.object({
  action: z.enum([
    'create',
    'update',
    'dry_run',
    'request_activation',
    'run_now',
    'disable',
    'delete',
  ]),
  script: z.string().describe('Script name (create: lowercase letters, digits and -) or id.'),
  description: z.string().max(500).optional().describe('create, update.'),
  source: z
    .string()
    .max(200_000)
    .optional()
    .describe(
      'create, update: TypeScript. `export default async function (event, ctx) { ... }`; no imports; return JSON. ctx methods per scripts_read "types".',
    ),
  manifest: manifestField,
  note: z
    .string()
    .max(500)
    .optional()
    .describe('create, update: what changed; request_activation: why.'),
  version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('dry_run, request_activation: a version (default the latest).'),
  eventId: z
    .string()
    .optional()
    .describe('dry_run: a channel event id from the Events page (ch:...).'),
  text: z
    .string()
    .max(10_000)
    .optional()
    .describe('dry_run: the message text for that event, or for a synthetic message.'),
  event: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'dry_run, run_now: a synthetic event, e.g. { type: "message.created", connectionId, chat: { title: "Ops", nativeId: "-100…" }, actor: { id: "1", name: "Ana", role: "member" }, text: "halo" }.',
    ),
  confirm: z.boolean().optional().describe('delete: true, after the person agreed.'),
})

const cut = (text: string): string =>
  text.length <= OUTPUT_CHARS ? text : `${text.slice(0, OUTPUT_CHARS)}\n… (cut)`

const json = (v: unknown, max = 400): string => {
  let s: string
  try {
    s = JSON.stringify(v) ?? 'undefined'
  } catch {
    s = String(v)
  }
  return s.length > max ? `${s.slice(0, max)}…` : s
}

const when = (ms: number | null): string =>
  ms === null ? 'never' : new Date(ms).toISOString().replace('.000Z', 'Z')

function scriptLine(s: Script): string {
  const run =
    s.status === 'active'
      ? `active v${s.activeVersion}`
      : s.status === 'disabled'
        ? `off${s.disabledReason ? ` (${s.disabledReason})` : ''}`
        : 'draft'
  const pending =
    s.approval.state === 'pending'
      ? `, v${s.approval.version} waits for approval`
      : s.approval.state === 'rejected'
        ? ', rejected'
        : ''
  return `- ${s.name}: ${run}${pending}, latest v${s.latestVersion}, ${s.runCount} run(s), ${s.errorCount} failed, last ${when(s.lastRunAt)}${s.description ? ` — ${s.description}` : ''}`
}

const callLine = (c: HostCallRecord): string =>
  c.dryRun
    ? `- would ${c.method} ${json(c.args)}`
    : `- ${c.method} ${json(c.args, 200)} → ${c.ok ? json(c.result, 200) : `error: ${c.error ?? '?'}`}`

/** A check as lines the model reads. */
export function checkText(r: {
  ok: boolean
  errors: number
  warnings: number
  problems: Array<{ line: number; column: number; message: string; severity: string; code: string }>
  version?: number
}): string {
  const head = `Check${r.version === undefined ? '' : ` of v${r.version}`}: ${r.ok ? 'no errors' : `${r.errors} error(s)`}, ${r.warnings} warning(s).`
  if (r.problems.length === 0) return head
  return [
    head,
    ...r.problems
      .slice(0, 40)
      .map((p) => `- line ${p.line}:${p.column} ${p.severity} (${p.code}): ${p.message}`),
  ].join('\n')
}

export function runText(r: ScriptRun, full = false): string {
  const head = `Run ${r.id} (${r.dryRun ? 'dry run' : 'real'}, v${r.version}, ${r.trigger}, ${when(r.startedAt)}): ${r.outcome}${r.reason ? ` (${r.reason})` : ''}${r.error ? ` — ${r.error}` : ''}, ${Math.round(r.durationMs)} ms`
  if (!full) return `- ${head.slice(4)}`
  const calls = r.calls.length === 0 ? ['(no ctx calls)'] : r.calls.map(callLine)
  const logs = r.logs.length === 0 ? ['(no logs)'] : r.logs.slice(-40).map((l) => `  ${l}`)
  return [
    head,
    ...(r.outcome === 'ok' ? [`Result: ${json(r.result, 2000)}`] : []),
    'Calls:',
    ...calls,
    'Logs:',
    ...logs,
  ].join('\n')
}

export function scriptsTools(options: ScriptsPluginOptions): HarnessPlugin<'scripts'> {
  return definePlugin({
    name: 'scripts',
    session: (rawCtx) => {
      const ctx = rawCtx as HarnessContext
      const sessionId = ctx.session.id
      const agent = options.agentOf(ctx.agent.id)
      const actor: ScriptActor = {
        kind: 'agent',
        agentId: agent?.id ?? ctx.agent.id,
        name: agent?.name ?? ctx.agent.id,
      }
      const origin = originOfSession(sessionId, ctx.session.parent !== undefined)
      const unattended = origin !== 'dm' && origin !== 'lead'

      const allowed = async (): Promise<boolean> => {
        if (unattended) return true
        const gw = options.gateway()
        if (gw === undefined || gw.conversationOf(sessionId) === undefined || gw.webTurn(sessionId))
          return true
        const r = await gw.requesterOf(sessionId)
        return r !== undefined && (r.role === 'owner' || r.role === 'admin')
      }
      /**
       * The person whose request in this chat counts as the approval of a script: the web owner in
       * the app, or an owner or admin in a chat channel. Unattended runs have none.
       */
      const chatApprover = async (): Promise<string | undefined> => {
        if (unattended) return undefined
        const gw = options.gateway()
        if (gw === undefined || gw.conversationOf(sessionId) === undefined || gw.webTurn(sessionId))
          return 'the owner'
        const r = await gw.requesterOf(sessionId)
        if (r === undefined || (r.role !== 'owner' && r.role !== 'admin')) return undefined
        return r.name ?? (r.username ? `@${r.username}` : r.nativeId)
      }
      const app = (): Deps => {
        const d = options.app()
        if (d === undefined) throw new Error('the app is not ready')
        return d
      }
      const guard = async (fn: () => Promise<string> | string): Promise<string> => {
        try {
          if (!(await allowed())) return NOT_ALLOWED
          return cut(await fn())
        } catch (error) {
          if (error instanceof DomainError) return `ERROR: ${error.message}`
          return `ERROR: ${errorText(error)}`
        }
      }
      const need = (v: string | undefined, what: string): string => {
        if (v === undefined || v.trim() === '')
          throw new DomainError('invalid', 'INVALID', `${what} is needed`)
        return v
      }

      const read = async (a: z.infer<typeof readSchema>): Promise<string> => {
        const d = app()
        switch (a.action) {
          case 'list': {
            const all = listScripts(d)
            return all.length === 0
              ? 'No scripts yet. Write one with scripts_write action "create" (read action "types" first).'
              : [`${all.length} script(s):`, ...all.map(scriptLine)].join('\n')
          }
          case 'view': {
            const s = getScript(d, need(a.script, 'script'))
            const v = getVersion(d, s.id, a.version)
            return [
              scriptLine(s).slice(2),
              `Version ${v.version} by ${v.createdBy}${v.note ? ` — ${v.note}` : ''}:`,
              'Manifest:',
              JSON.stringify(versionManifest(v), null, 2),
              'Source:',
              v.source,
            ].join('\n')
          }
          case 'versions': {
            const vs = listVersions(d, need(a.script, 'script'))
            return vs
              .map(
                (v) =>
                  `- v${v.version} ${when(v.createdAt)} by ${v.createdBy}${v.note ? ` — ${v.note}` : ''}`,
              )
              .join('\n')
          }
          case 'types':
            return [
              'Scripts run sandboxed TypeScript: `export default async function (event, ctx) { ... }`. No imports, no timers, no network except ctx.http. Every ctx call is checked against the manifest grants (default: nothing). Return JSON; ctx.log(...) lines show in the trace.',
              scriptTypesText(d).types,
            ].join('\n\n')
          case 'check':
            return checkText(
              await checkScriptCode(d, need(a.script, 'script'), { version: a.version }),
            )
          case 'runs': {
            const runs = listRuns(d, need(a.script, 'script'), {
              limit: a.limit ?? 10,
              dryRun: a.dryRun,
            })
            return runs.length === 0
              ? 'No runs yet.'
              : [`${runs.length} run(s), newest first:`, ...runs.map((r) => runText(r))].join('\n')
          }
          case 'run':
            return runText(getRun(d, need(a.script, 'script'), need(a.runId, 'runId')), true)
        }
      }

      const write = async (a: z.infer<typeof writeSchema>): Promise<string> => {
        const d = app()
        switch (a.action) {
          case 'create': {
            const s = await createScript(d, actor, {
              name: a.script,
              description: a.description,
              source: need(a.source, 'source'),
              manifest: a.manifest ?? {},
              note: a.note,
            })
            const checked = checkText(await checkScriptCode(d, s.id, {}))
            return `Created ${s.name} v1 (draft).\n${checked}\nNext: fix any errors, dry_run it with an event, then request_activation (it runs at once when the owner or an admin asked for it in this chat; otherwise it waits for approval on the Scripts page).`
          }
          case 'update': {
            const r = await updateScript(d, actor, a.script, {
              source: a.source,
              manifest: a.manifest,
              note: a.note,
              description: a.description,
            })
            const checked =
              r.version === undefined
                ? ''
                : `\n${checkText(await checkScriptCode(d, r.script.id, { version: r.version }))}`
            return r.version === undefined
              ? `Updated ${r.script.name} (no code or manifest change, no new version).`
              : `Saved ${r.script.name} v${r.version}. ${r.script.status === 'active' ? `v${r.script.activeVersion} keeps running until v${r.version} is activated (request_activation).` : 'Dry-run it, then request_activation.'}${checked}`
          }
          case 'dry_run': {
            const r = await dryRunScript(d, actor, a.script, {
              version: a.version,
              eventId: a.eventId,
              text: a.text,
              event:
                a.event === undefined
                  ? undefined
                  : {
                      ...a.event,
                      ...(a.text === undefined || a.eventId !== undefined ? {} : { text: a.text }),
                    },
            })
            const t =
              r.triggers.length === 0
                ? []
                : [`Channel triggers: ${r.triggers.map((x, i) => `#${i + 1} ${x}`).join('; ')}`]
            return [runText(r.run, true), ...t, 'Nothing was sent or changed (dry run).'].join('\n')
          }
          case 'request_activation': {
            // an owner or admin asking for it in this chat is the approval (Settings can turn it off)
            const approver = d.settings.get().scriptsChatApproval ? await chatApprover() : undefined
            if (approver !== undefined) {
              const r = activateScript(d, { kind: 'person', name: approver }, a.script, {
                version: a.version,
                note: a.note ?? `asked in chat by ${approver}`,
              })
              return `Active: ${r.script.name} runs v${r.script.activeVersion} now (approved by ${approver}, who asked for it in this chat).`
            }
            const r = activateScript(d, actor, a.script, { version: a.version, note: a.note })
            return r.state === 'active'
              ? `Active: ${r.script.name} runs v${r.script.activeVersion} now (it widens nothing that was approved).`
              : `Asked for approval of ${r.script.name} v${r.script.approval.version} (${r.reasons.join('; ')}). It runs after a person approves it on the Scripts page; tell them.`
          }
          case 'run_now':
            return runText(await runScriptNow(d, actor, a.script, a.event), true)
          case 'disable': {
            const s = disableScript(d, actor, a.script)
            return `Switched off ${s.name}. A person turns it on again on the Scripts page.`
          }
          case 'delete': {
            if (a.confirm !== true)
              return 'ERROR: deleting removes the script, its versions, runs and state for good. Ask the person first, then call again with confirm: true.'
            const s = getScript(d, a.script)
            deleteScript(d, actor, s.id)
            return `Deleted ${s.name}.`
          }
        }
      }

      return {
        tools: {
          [SCRIPTS_READ_TOOL]: tool({
            description:
              "Read the team's scripts: small sandboxed TypeScript programs that run without a model when a chat event, a schedule or a table change happens (forwarding, counting, logging to tables or the library). Actions: list, view (code + manifest), versions, types (the ctx API and manifest format — read before writing), check (type errors, lint, missing grants, without running), runs, run (one trace).",
            inputSchema: readSchema,
            metadata: { risk: 'read', idempotent: true },
            execute: (input): Promise<string> => guard(() => read(input)),
          }),
          [SCRIPTS_WRITE_TOOL]: tool({
            description:
              'Write and test scripts. Use a script instead of waking an agent for repeatable, rule-based work (e.g. "when a message with halo arrives in chat A, post it to group B"). Actions: create (name, source, manifest), update (new version), dry_run (runs the code on a recorded event id or a synthetic event; sends nothing, shows "would …" lines), request_activation (runs at once when the owner or an admin asked for it in this chat; otherwise a person approves on the Scripts page), run_now (real run of the active version), disable, delete (confirm: true). Always dry_run before request_activation.',
            inputSchema: writeSchema,
            metadata: { risk: 'write', idempotent: false },
            execute: (input): Promise<string> => guard(() => write(input)),
          }),
        } as never,
      }
    },
  })
}
