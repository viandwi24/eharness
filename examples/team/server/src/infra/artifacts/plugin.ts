/**
 * The `artifacts` plugin (docs/plans/P45-team-artifacts.md): what the agent generates for a person to
 * look at (a page, a document, an image, a diagram, a table, a code file) becomes an artifact with
 * versions, a viewer in the web app and a share setting.
 *
 *  - `artifact_create`      builds an artifact from text, base64 or copies of library files
 *                           (`files[].from`), or adopts a whole library folder (`dir`). Editing goes
 *                           through the ordinary file tools on the artifact folder.
 *  - `artifact_list`        finds artifacts.
 *  - `artifact_visibility`  private / public, decided in code on who asked: the web owner and a channel
 *                           owner or admin may publish; a member or guest may not; an autonomous run
 *                           opens a decision for the owner instead.
 *
 * Every result is text and an expected failure is a string (`ERROR: ...`), never a throw. At the end
 * of a turn the artifacts the agent touched get one new version; structure problems go back to the
 * agent once as a reminder (`turn.beforeEnd`).
 */
import { tool } from 'ai'
import {
  defineDataPart,
  definePlugin,
  errorText,
  type HarnessContext,
  type HarnessPlugin,
} from 'eharness'
import { z } from 'zod'
import { ARTIFACT_KIND_IDS } from '../../../../shared/artifacts/kinds.ts'
import { DomainError } from '../../domain/errors.ts'
import { originOfSession } from '../../domain/run-profiles.ts'
import type { PathAccess } from '../bigdata/plugin.ts'
import type { ChannelGateway } from '../channels/index.ts'
import type { ArtifactService } from './service.ts'

export const ARTIFACT_CREATE_TOOL = 'artifact_create'
export const ARTIFACT_LIST_TOOL = 'artifact_list'
export const ARTIFACT_VISIBILITY_TOOL = 'artifact_visibility'
export const ARTIFACT_TOOLS = {
  create: [ARTIFACT_CREATE_TOOL],
  read: [ARTIFACT_LIST_TOOL],
  share: [ARTIFACT_VISIBILITY_TOOL],
} as const

/** The data part the web renders as an artifact card (`data-artifacts.artifact`). */
const artifactPart = defineDataPart({
  schema: z.object({
    id: z.string(),
    kind: z.string(),
    title: z.string(),
    version: z.number().int(),
  }),
  model: 'omit',
})

/** What the plugin needs from the decision center to hold a public request of an autonomous run. */
export interface ArtifactDecisions {
  /** Open (or reuse) the decision "make this public?" for the owner. */
  request(input: { agentId: string; sessionId: string; artifactId: string; title: string }): {
    id: string
  }
  /** Did the owner approve making this artifact public for this run? */
  approved(sessionId: string, artifactId: string): boolean
}

export const PUBLISH_OPTION = 'Make public'
export const KEEP_PRIVATE_OPTION = 'Keep private'

export interface ArtifactsPluginOptions {
  service: ArtifactService
  /** The agent of a hook context (`ctx.agent.id` is the slug of the definition). */
  agentOf: (slug: string) => { id: string; name: string } | undefined
  /** Late-bound channel gateway: who asked (their directory role). */
  channels: () => ChannelGateway | undefined
  /** Path authority of a program run (undefined for any other session). */
  access: (sessionId: string) => PathAccess | undefined
  decisions: () => ArtifactDecisions | undefined
  /** The tools the connection offers (capabilities that are not off). */
  tools: readonly string[]
}

const fileSchema = z.object({
  path: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Path inside the artifact folder (index.html, assets/logo.png). Defaults to the name of `from`.',
    ),
  content: z.string().optional().describe('Text content of the file.'),
  base64: z
    .string()
    .optional()
    .describe('Binary content as base64 (small files only; prefer `from`).'),
  from: z
    .string()
    .optional()
    .describe(
      'A library file to copy in (for example /library/work/chart.png written by run_python).',
    ),
})

const createSchema = z.object({
  kind: z
    .enum(ARTIFACT_KIND_IDS as [string, ...string[]])
    .describe(
      'html (page, 3D, slides, charts with Chart.js/Plotly/D3), document (markdown), image (png/jpg/webp/svg), mermaid (diagram), code, data (csv/json) or file.',
    ),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional().describe('One line about what it is.'),
  files: z
    .array(fileSchema)
    .max(60)
    .optional()
    .describe('The files to create. Give exactly one of content, base64 or from per file.'),
  dir: z
    .string()
    .optional()
    .describe(
      'Adopt this existing library folder (for example /library/work/report) as the artifact folder, in place, instead of listing files.',
    ),
  entry: z
    .string()
    .optional()
    .describe('The main file (default by kind: index.html, document.md, ...).'),
})

const listSchema = z.object({
  query: z.string().max(200).optional().describe('Words from the title or description.'),
  kind: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
})

const visibilitySchema = z.object({
  id: z.string().min(1),
  visibility: z.enum(['private', 'public']),
  pinVersion: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Public only: pin the link to this version; leave out to follow the latest.'),
})

export const ARTIFACT_INSTRUCTIONS = [
  'Artifacts: when a person asks for something to look at (a page, design, document, report, proposal, table, chart, diagram or image), build it as an artifact with artifact_create instead of pasting long content into the chat. The app shows it next to the chat with versions, export and sharing.',
  'Pick the kind: html for pages, prototypes, 3D (three.js from cdnjs/jsdelivr/unpkg), slide decks and interactive charts (Chart.js, Plotly, ECharts, D3); document for markdown reports and proposals; image for png/jpg/svg; mermaid for diagrams; data for csv/json tables; code for source files. An html page has no network: it may load scripts, styles, fonts and images only from cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com and Google Fonts, or from files in the artifact.',
  'To change an artifact later, read its file and then edit or write it with the ordinary file tools in the artifact folder (the path is in the result of artifact_create); a new version is saved when your turn ends. Do not create a second artifact for an edit.',
  'Charts and computed results: compute with run_python and save the output (chart.png, chart.svg, a .csv, an .html) into the library, then create the artifact from those files with `from` (or adopt the whole folder with `dir`). Never paste data or base64 images into a tool input or the chat. For a quick diagram write a ```mermaid fence in your reply; for a simple chart a ```svg fence or an html artifact.',
  'Visibility: an artifact is private (only people signed in to the app) until artifact_visibility says otherwise. Make it public only when the person asked for a public link, and never claim a link is public unless artifact_visibility said so. In a chat channel reply with a one-line summary and the link.',
].join('\n')

const text = (error: unknown): string =>
  error instanceof DomainError ? error.message : errorText(error)

function problemsText(problems: readonly string[]): string {
  return problems.map((p) => `- ${p}`).join('\n')
}

export function artifacts(options: ArtifactsPluginOptions): HarnessPlugin<'artifacts'> {
  const { service } = options
  return definePlugin({
    name: 'artifacts',
    dataParts: { artifact: artifactPart },
    session: (rawCtx) => {
      const ctx = rawCtx as HarnessContext & {
        stream: { data: (name: string, data: unknown, opts?: { id?: string }) => void }
      }
      const sessionId = ctx.session.id
      const origin = originOfSession(sessionId, ctx.session.parent !== undefined)
      const self = (): { id: string; name: string } => {
        const agent = options.agentOf(ctx.agent.id)
        if (agent === undefined) throw new Error(`unknown agent ${ctx.agent.id}`)
        return agent
      }
      let reminded = false

      /**
       * Who is asking, from the session and never from a message: the person of a chat turn with
       * their directory role, the web user of a web chat, nobody (autonomous) otherwise.
       */
      async function actorOf(): Promise<
        | { kind: 'web' }
        | { kind: 'chat'; role: string; name: string }
        | { kind: 'unknown' }
        | undefined
      > {
        const gw = options.channels()
        if (gw !== undefined) {
          const r = await gw.requesterOf(sessionId).catch(() => undefined)
          if (r !== undefined)
            return { kind: 'chat', role: r.role, name: r.name ?? r.username ?? r.nativeId }
          if (gw.conversationOf(sessionId) !== undefined || gw.unresolvedChatTurn(sessionId)) {
            return { kind: 'unknown' }
          }
        }
        return origin === 'dm' ? { kind: 'web' } : undefined
      }

      const tools: Record<string, unknown> = {}

      if (options.tools.includes(ARTIFACT_CREATE_TOOL)) {
        tools[ARTIFACT_CREATE_TOOL] = tool({
          description:
            'Create an artifact: a page, document, image, diagram, table or code file the person can open next to the chat, version, export and share. Give files (content, or `from` a library file such as a run_python output) or adopt a folder with `dir`. Validates the structure and returns the id and the link. Edit it later with the file tools in its folder.',
          inputSchema: createSchema,
          metadata: { risk: 'write', idempotent: false },
          execute: async (input): Promise<string> => {
            if (origin === 'rehearsal') return 'ERROR: artifacts are not created in a rehearsal.'
            try {
              const agent = self()
              const { artifact, problems } = await service.createWith(
                {
                  kind: input.kind,
                  title: input.title,
                  description: input.description,
                  files: input.files,
                  dir: input.dir,
                  entry: input.entry,
                },
                {
                  actor: { by: `agent:${agent.id}`, agentId: agent.id, sessionId },
                  access: options.access(sessionId),
                },
              )
              ctx.stream.data(
                'artifact',
                {
                  id: artifact.id,
                  kind: artifact.kind,
                  title: artifact.title,
                  version: artifact.version,
                },
                { id: artifact.id },
              )
              return [
                `Created artifact ${artifact.id}: "${artifact.title}" (${artifact.kind}, version ${artifact.version}, ${artifact.files.length} file${artifact.files.length === 1 ? '' : 's'}, entry ${artifact.entry}).`,
                `Open it in the app: ${service.appUrl(artifact.id)}`,
                'It is private: only people signed in to the app can see it. Do not tell anyone it is public.',
                `Its files are in ${artifact.dir}/ : change them with the file tools and a new version is saved when your turn ends.`,
                ...(problems.length > 0
                  ? [`Problems to fix (it was created anyway):\n${problemsText(problems)}`]
                  : []),
              ].join('\n')
            } catch (error) {
              return `ERROR: ${text(error)}`
            }
          },
        })
      }

      if (options.tools.includes(ARTIFACT_LIST_TOOL)) {
        tools[ARTIFACT_LIST_TOOL] = tool({
          description:
            'List artifacts (newest first), optionally by words from the title or by kind.',
          inputSchema: listSchema,
          metadata: { risk: 'read', idempotent: true },
          execute: (input): string => {
            try {
              const found = service.search({
                query: input.query,
                kind: input.kind,
                limit: input.limit ?? 20,
              })
              if (found.length === 0) return 'No artifacts found.'
              return found
                .map(
                  (a) =>
                    `${a.id}  ${a.kind}  v${a.version}  ${a.visibility}  "${a.title}"  ${a.dir}/${a.entry}`,
                )
                .join('\n')
            } catch (error) {
              return `ERROR: ${text(error)}`
            }
          },
        })
      }

      if (options.tools.includes(ARTIFACT_VISIBILITY_TOOL)) {
        tools[ARTIFACT_VISIBILITY_TOOL] = tool({
          description:
            'Make an artifact public (a link anyone can open) or private again. Only the web user and an owner or admin in a chat can make it public; anybody may make it private. Returns the link.',
          inputSchema: visibilitySchema,
          metadata: { risk: 'write', idempotent: true },
          execute: async (input): Promise<string> => {
            try {
              const row = service.row(input.id)
              if (row === undefined)
                return `ERROR: no artifact with id ${input.id}. Use artifact_list to find it.`
              const agent = self()
              const by = `agent:${agent.id}`
              if (input.visibility === 'private') {
                if (row.visibility === 'private') return `"${row.title}" is already private.`
                service.setVisibility(row.id, 'private', by, { sessionId })
                return `"${row.title}" is private again. The old public link no longer works; making it public again gives a new link.`
              }
              const actor = await actorOf()
              const allowed =
                actor !== undefined &&
                (actor.kind === 'web' ||
                  (actor.kind === 'chat' && (actor.role === 'owner' || actor.role === 'admin')))
              const label =
                actor?.kind === 'web'
                  ? 'the web user'
                  : actor?.kind === 'chat'
                    ? `${actor.name} (${actor.role})`
                    : undefined
              if (!allowed) {
                if (actor === undefined) {
                  // an autonomous run: the owner decides, nothing is public until approved
                  const decisions = options.decisions()
                  if (decisions === undefined) {
                    return 'Not allowed: this run has nobody to approve a public link. The artifact stays private.'
                  }
                  if (decisions.approved(sessionId, row.id)) {
                    const view = service.setVisibility(row.id, 'public', by, {
                      sessionId,
                      ...(input.pinVersion === undefined ? {} : { shareVersion: input.pinVersion }),
                    })
                    return `"${row.title}" is public after the owner approved it: ${view.shareUrl}`
                  }
                  const { id } = decisions.request({
                    agentId: agent.id,
                    sessionId,
                    artifactId: row.id,
                    title: row.title,
                  })
                  return `A decision (${id}) is waiting for the owner in the Decision Center: make "${row.title}" public? Nothing is public yet and the artifact stays private. Say so and carry on; once the owner approves, call artifact_visibility again.`
                }
                const who =
                  actor.kind === 'chat' ? `${actor.name} (role ${actor.role})` : 'this person'
                return `Not allowed: only an owner or an admin can make an artifact public, and ${who} is not one. The artifact stays private; tell them plainly and offer to ask an admin. Making it private is always allowed.`
              }
              const view = service.setVisibility(row.id, 'public', `${by} for ${label}`, {
                sessionId,
                ...(input.pinVersion === undefined ? {} : { shareVersion: input.pinVersion }),
              })
              return [
                `"${row.title}" is now public. Anyone with this link can open it, no sign-in: ${view.shareUrl}`,
                view.shareVersion === null
                  ? 'The link follows the latest version.'
                  : `The link is pinned to version ${view.shareVersion}.`,
              ].join('\n')
            } catch (error) {
              return `ERROR: ${text(error)}`
            }
          },
        })
      }

      const snapshotTurn = async (): Promise<Array<{ title: string; problems: string[] }>> => {
        try {
          const agent = options.agentOf(ctx.agent.id)
          const done = await service.snapshotDirty(agent?.id ?? null)
          return done.filter((d) => d.problems.length > 0)
        } catch (error) {
          ctx.log.warn(`artifact snapshot failed: ${errorText(error)}`)
          return []
        }
      }

      return {
        instructions: [ARTIFACT_INSTRUCTIONS] as never,
        tools: tools as never,
        hooks: {
          'turn.start': (): void => {
            reminded = false
          },
          // the artifacts the agent changed get a version before the turn ends; problems go back once
          'turn.beforeEnd': async (): Promise<{ continue: { reason: string } } | undefined> => {
            const bad = await snapshotTurn()
            if (bad.length === 0 || reminded) return undefined
            reminded = true
            return {
              continue: {
                reason: `The artifact${bad.length === 1 ? '' : 's'} you changed ${bad.length === 1 ? 'has' : 'have'} problems. Fix them with the file tools (a new version is saved when you finish), or explain why they are fine:\n${bad
                  .map((b) => `"${b.title}":\n${problemsText(b.problems)}`)
                  .join('\n')}`,
              },
            }
          },
          'turn.end': async (): Promise<void> => {
            await snapshotTurn()
          },
        } as never,
      }
    },
  })
}
