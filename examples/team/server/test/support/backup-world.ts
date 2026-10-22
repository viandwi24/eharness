/**
 * A workspace for the backup tests: `instance()` composes a server on a temporary database (the
 * secret key is a parameter, so a second instance can share it for a whole-database restore), and
 * `populateBase()` fills the core features through the real app functions and routes. The other
 * `populate-*.ts` modules fill the rest; `test/backup-everything.test.ts` runs them all.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedModel } from 'eharness/testing'
import { archiveAgent, createAgent, updateAgent } from '../../src/app/agents.ts'
import { setHeartbeat } from '../../src/app/heartbeat.ts'
import { editPersona } from '../../src/app/persona.ts'
import { createProgram } from '../../src/app/programs.ts'
import { createRoutine } from '../../src/app/routines.ts'
import { patchSettings } from '../../src/app/settings.ts'
import { libraryFs } from '../../src/infra/eh/library-fs.ts'
import { scriptedModelConfig } from '../../src/infra/eh/provider.ts'
import { compose, type Server } from '../../src/main.ts'
import { fakeMcp } from './fake-mcp.ts'

const servers: Server[] = []
const dirs: string[] = []
const stops: Array<() => void> = []

/** Stop every server, fake service and temporary directory made since the last call. */
export async function cleanup(): Promise<void> {
  for (const s of servers.splice(0)) await s.close()
  for (const stop of stops.splice(0)) stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
}

/** Register something to stop at `cleanup()`. */
export const onCleanup = (stop: () => void): void => {
  stops.push(stop)
}

export const newSecretKey = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')

export interface InstanceOptions {
  /** `TEAM_SECRET_KEY` (default: a new random key). */
  secretKey?: string
  /** `TEAM_CHANNEL_KEY` (default: a new random key). */
  channelKey?: string
  /** An existing directory (a database file `team.db` in it); default: a new temporary one. */
  dir?: string
  /** Seed the example agents (lead, researcher, ...). Default true like `compose`. */
  seedAgents?: boolean
  /** `Lifecycle.restart` of the whole-database restore. */
  onRestart?: () => void
}

export interface Instance {
  server: Server
  dir: string
  dbFile: string
}

export function instance(options: InstanceOptions = {}): Instance {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'team-backup-world-'))
  if (options.dir === undefined) dirs.push(dir)
  const dbFile = join(dir, 'team.db')
  const server = compose({
    dbFile,
    instanceId: 'backup-world',
    models: scriptedModelConfig(scriptedModel([]) as never),
    env: {
      TEAM_SECRET_KEY: options.secretKey ?? newSecretKey(),
      TEAM_CHANNEL_KEY: options.channelKey ?? newSecretKey(),
      TEAM_ALLOW_PRIVATE_MCP: '1',
    },
    ...(options.seedAgents === undefined ? {} : { seedAgents: options.seedAgents }),
    ...(options.onRestart === undefined ? {} : { lifecycle: { restart: options.onRestart } }),
    tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 },
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    turnRetry: { tickMs: 0 },
  })
  servers.push(server)
  return { server, dir, dbFile }
}

/** Close one server of this module (a restart in a test) without touching its directory. */
export async function closeServer(server: Server): Promise<void> {
  const at = servers.indexOf(server)
  if (at >= 0) servers.splice(at, 1)
  await server.close()
}

export const SECRET = 'HEADERSECRET9'

export interface BaseWorld {
  server: Server
  leadId: string
  analystId: string
  archivedId: string
  connectionId: string
  programId: string
  routineId: string
  personId: string
}

export const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/**
 * The core features: a second agent (with persona versions, memory, heartbeat orders, a program in
 * file mode, a routine, a connection with a secret and its enablement), an archived agent, a person,
 * library files, workspace settings.
 */
export async function populateBase(server: Server): Promise<BaseWorld> {
  await server.connectorsReady
  const deps = server.deps
  const mcp = fakeMcp()
  onCleanup(() => mcp.server.stop(true))
  const made = await server.app.request('/connectors/custom', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Company docs',
      url: `${mcp.url}?token=${SECRET}`,
      signIn: 'none',
      headers: { 'X-Api-Key': SECRET },
      availableToAll: false,
    }),
  })
  if (made.status !== 201) throw new Error(`custom connector: ${made.status}`)
  const connectionId = ((await made.json()) as { connection: { id: string } }).connection.id

  const lead =
    deps.agents.list().find((a) => a.role === 'lead') ??
    createAgent(deps, {
      slug: 'lead',
      role: 'lead',
      name: 'Lead',
      instructions: 'Lead the team and delegate.',
    })
  const analyst = createAgent(deps, {
    name: 'Forecaster',
    instructions: 'Analyse the numbers and report plainly.',
    description: 'Looks at numbers',
    permissionMode: 'manual',
    rules: { allow: ['Read'] },
  })
  updateAgent(deps, analyst.id, {
    connectors: { ...analyst.connectors, [connectionId]: { enabled: 'on' } as never },
  })
  editPersona(deps, analyst.id, {
    identity: {
      displayName: 'Ana',
      about: 'The numbers person',
      language: 'English',
      emoji: false,
    },
    voice: 'Short and exact.\nNo filler.',
    operatingRules: 'Escalate anything above 10 000 to the owner.',
  })
  editPersona(deps, analyst.id, { voice: 'Short, exact, friendly.' })
  await setHeartbeat(deps, analyst.id, { everyMinutes: 45 })

  const archived = createAgent(deps, {
    name: 'Retired helper',
    instructions: 'Used to help with archives.',
    description: 'Archived on purpose',
  })
  editPersona(deps, archived.id, { voice: 'Quiet.' })

  const fs = libraryFs(server.conn.sqlite)
  await fs.write('/library/reports/q1.md', '# Q1\nrevenue up\nmargin flat')
  await fs.write('/library/notes/ünï.txt', 'unicode name')
  await fs.writeBytes?.('/library/data/blob.bin', new Uint8Array([0, 1, 2, 3, 255, 254, 0, 9]))
  await fs.write('/memories/workspace/profile.md', 'We make things')
  await fs.write(`/memories/agents/${analyst.id}/profile.md`, 'I am the forecaster')
  await fs.write(
    `/memories/agents/${analyst.id}/HEARTBEAT.md`,
    '# Heartbeat\n- watch the weekly report\n',
  )
  await fs.write(`/memories/agents/${analyst.id}/notes/observations.md`, 'Seen: margin is flat')
  await fs.write(`/memories/agents/${archived.id}/profile.md`, 'I was archived')

  const program = createProgram(deps, {
    agentId: analyst.id,
    name: 'Weekly report',
    brief: 'Collect the weekly numbers.\nWrite them to /library/reports.',
    authority: { tools: ['Read'], read: ['/library/'], write: ['/library/reports/'] },
    budget: { perRunUsd: 1.5, perDayUsd: 4 },
    notes: ['Agreed: report on Mondays'],
    trigger: { kind: 'schedule', spec: { kind: 'cron', expr: '0 9 * * 1', tz: 'UTC' } },
  })
  const routine = createRoutine(deps, {
    agentId: analyst.id,
    name: 'Morning check',
    prompt: 'Check the dashboard.',
    schedule: { kind: 'cron', expr: '30 8 * * *', tz: 'UTC' },
  })
  const person = await deps.people.create({
    displayName: 'Dewi Example',
    role: 'admin',
    fields: { branch: 'North' },
    notes: 'Prefers short messages',
  })
  patchSettings(deps, { teamName: 'Acme Team' })
  // the archived agent last: everything above needed it active
  archiveAgent(deps, archived.id)
  return {
    server,
    leadId: lead.id,
    analystId: analyst.id,
    archivedId: archived.id,
    connectionId,
    programId: program.id,
    routineId: routine.id,
    personId: person.id,
  }
}
