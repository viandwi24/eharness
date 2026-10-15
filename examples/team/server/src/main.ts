/**
 * Composition root: the only place that wires domain, app, infra and http together.
 *
 *   TEAM_DB     database file (default ./data/team.db; `:memory:` works)
 *   TEAM_TOKEN  bearer token; unset = open, and the server then listens on loopback only
 *   BASIC_AUTH_PASSWORD   password login (a `team_session` cookie) for the web; the bearer token keeps working for scripts. With it and no TEAM_TOKEN a non-loopback bind needs a password of 12+ characters
 *   TEAM_TRUST_PROXY   `1` = believe X-Forwarded-For / -Proto (login throttle per client, Secure cookie behind a TLS proxy)
 *   TEAM_HOST   bind address (default 127.0.0.1); a non-loopback host requires TEAM_TOKEN
 *   TEAM_ALLOWED_HOSTS   extra Host header names to accept (comma separated; loopback, TEAM_HOST and the TEAM_PUBLIC_URL host always are)
 *   PORT        default 4000
 *   OPENROUTER_API_KEY | AI_GATEWAY_API_KEY   read-only env provider profiles (more profiles are
 *                     added in Settings > Providers and stored encrypted); TEAM_SCRIPTED_MODEL wins over all
 *   TEAM_PROVIDER / TEAM_MODEL   default profile (openrouter | gateway) and its default model
 *   TEAM_CHANNEL_KEY  32 bytes base64: encrypts the channel log at rest (its own key; dev: `channel.key` next to the DB)
 *   TEAM_SECRET_KEY   32 bytes base64: encrypts provider secrets, connection secrets and tokens at rest (dev: a key file next to the DB)
 *   TEAM_ALLOWED_ORIGINS extra browser origins allowed to send state-changing requests (the origins of TEAM_WEB_URL and TEAM_PUBLIC_URL always are; other `Origin`s get 403 FORBIDDEN_ORIGIN, the CSRF guard)
 *   TEAM_PUBLIC_URL   where this server is reached by the browser (OAuth callback `<url>/oauth/callback`; default http://localhost:PORT)
 *   TEAM_ARTIFACT_URL  public base URL of the artifact content origin (docs/plans/P45-team-artifacts.md; default: root-relative /art/* URLs on the host that shows the page)
 *   TEAM_ARTIFACT_PORT also serve ONLY the content routes on this port (a separate origin behind a proxy, or in dev; TEAM_ARTIFACT_URL then points at it)
 *   TEAM_WEB_URL      where the web app lives (the OAuth callback redirects to `<url>/connectors`, channel messages link to it; default http://localhost:5173, or TEAM_PUBLIC_URL with TEAM_WEB_DIR)
 *   TEAM_TELEGRAM_API_ROOT Bot API root of the Telegram bot (default https://api.telegram.org; a local Bot API server or a test fake)
 *   TEAM_WEB_DIR      serve the built web (web/build) from this server on one port; the API then lives under /api (Dockerfile)
 *   TEAM_<CONNECTOR>_CLIENT_ID / _CLIENT_SECRET   OAuth app of a curated connector (e.g. TEAM_GITHUB_CLIENT_ID); or save it in the web app
 *   TEAM_CLASSIFIER_MODEL   model of Auto permission mode, `profile:model` or a plain id (default: the default model; none with a scripted model)
 *   TEAM_SEARCH_MODEL   model of web_search, same format
 *   TEAM_INSTANCE_ID  stable id of this instance (default team-<PORT>): a restarted instance recovers its own interrupted turns at boot
 *   TEAM_SEED_AGENTS  1 = add the example agents (Lead, Researcher, Writer, Analyst, Ops) to an empty workspace; default: start empty
 *   TEAM_DEMO_COLLECTOR   1 = register the fixture community source (`ingest_source` of the Data work connector; 5 000 deterministic messages)
 *   TEAM_DEBUG_INVARIANTS   1 = debug.invariants on every agent (tests set it; a broken session invariant fails the turn)
 *   TEAM_BUDGET_USD   monthly USD limit of the workspace ledger (unset = tracked, not limited)
 *   TEAM_CODE_DRIVER   where agents run Python (`run_python`, the Files & Sandbox connector): `off` | `local` (a scratch directory under an OS sandbox, no network, the data directory unreadable). Default `local` when the interpreter is found, else `off`
 *   TEAM_CODE_PYTHON   the interpreter of `local` (default `python3`; the team image sets /opt/eh-python/bin/python)
 *   TEAM_CODE_INSTALL  `off` (default) | `allowlist` | `any`: lets agents add Python packages (`install_packages`, asks first); built by the server with network, wheels only
 *   TEAM_CODE_ALLOW    comma list of package names (optional `==version`) for `allowlist`
 *   TEAM_CODE_ENV_ROOT where package environments are kept (default `<data dir>/python-envs`; rebuilt when missing)
 *   TEAM_CODE_REQUIREMENTS   a requirements file: `local` builds the base environment from it (default: use the interpreter as it is)
 *   TEAM_BROWSER_DRIVER   where agents get a browser (the Browser connector, `/browser`): `off` (profiles connect to an existing browser only) | `local` (this server downloads and starts Chrome or Lightpanda for a managed profile). Default `local` when the root is writable, else `off`
 *   TEAM_BROWSER_ROOT   where downloaded engines and the logins of managed profiles live (default `<data dir>/browser`; safe to delete: profiles stay, logins are lost)
 *                       (with a connected Remote sandbox that runs `SANDBOX_BROWSER=1`, a managed Chrome profile can also be created to run there; needs `local`)
 *   TEAM_BROWSER_XVFB   `1` = headed Chrome on a Linux server without a display (needs `xvfb-run`)
 *   TEAM_BROWSER_MAX    managed or manual browsers open at once (default 4); the Browser page shows each one's memory and CPU and the server's free memory
 *   TZ                default of the team timezone (Settings): the clock of agents, routines, reminders, chats, digest
 *   TEAM_SPAWN_CAP    children the lead runs at once (default 4; the settings row overrides it)
 *   TEAM_LONG_RUN_MAX_COST_USD  stop a background worker job whose estimated cost reaches this (default 10; 0 = no limit)
 *   TEAM_LONG_RUN_MAX_HOURS     stop a background worker job this many hours after it started (default 24; 0 = no limit)
 *   TEAM_LONG_RUN_CHUNK_STEPS   steps per chunk of a worker job (default 80, at least 10)
 *   (TEAM_MAX_WORKER_STEPS was removed: workers have no fixed step cap, they run as long-run jobs)
 *   TEAM_CONTEXT_CAP  working context window in tokens (default 128000): history is summarized at 80 % of it
 *   TEAM_OFFLINE      1 = never fetch the model catalogs (cached in the database, refreshed every 24 h)
 *   TEAM_ROUTINE_TICK_MS   routine ticker interval (default 15000; 0 = off)
 *   TEAM_LOG_MAX_ROWS / TEAM_LOG_RETENTION_DAYS   model call log retention (default 5000 rows, 7 days)
 *   TEAM_MEDIA_RETENTION_DAYS   tool media and browser screenshots kept this long (default 3; 0 = keep); TEAM_DB_COMPACT=1 converts the DB to auto_vacuum=INCREMENTAL once
 *   TEAM_EVENTS_RETENTION_HOURS / TEAM_EVENTS_MAX_ROWS   events feed retention (default 72 h, 100000 rows; 0 hours = by count only)
 *   TEAM_ROUTINE_RUNS_RETENTION_DAYS / TEAM_TASKS_RETENTION_DAYS / TEAM_LIBRARY_HISTORY_RETENTION_DAYS   finished routine runs, finished tasks, library history (default 30 / 90 / 180 days; 0 = keep)
 *
 * New to this file? docs/guides/walkthrough-server.md follows a request through it: the boot
 * order (providers, connectors, then the reconcile pass of section 6-7), the activity feed and its
 * retention (13), `createTeamHttp` (14) and `Bun.serve` with `idleTimeout: 0` (16).
 */
import { dirname } from 'node:path'
import type { OpenAPIHono } from '@hono/zod-openapi'
import { errorText, type ModelCatalog, uuidv7 } from 'eharness'
import { type SecretVault, sealedProfileStore } from 'eharness/providers'
import { websocket } from 'hono/bun'
import { updateAgent } from './app/agents.ts'
import {
  hostAllowed,
  isLoopbackHost,
  type ListenConfig,
  listenConfig,
  originOf,
} from './app/auth.ts'
import { suggestAuthority } from './app/authority-suggestions.ts'
import { briefingsText } from './app/briefings.ts'
import { settleTakeovers } from './app/browser.ts'
import { checkChatBody, uploadFile } from './app/chat.ts'
import {
  approveDecision,
  createAmendment,
  createEscalation,
  createReportEscalation,
  proposeFromAgent,
  rejectDecision,
} from './app/decisions.ts'
import { recheckTask } from './app/deliverables.ts'
import { type HealthJobReport, runHealthJob } from './app/health.ts'
import {
  abandonBeat,
  allowedDestinations,
  appendNote,
  destinationLabel,
  effectiveConfig,
  ensureHeartbeats,
  finishBeat,
  reportToWeb,
  reservePost,
  teamStatus,
} from './app/heartbeat.ts'
import {
  applyProposal,
  ensureAllPersonas,
  getPersonaState,
  personaHistory,
  proposePersona,
  revertPersona,
} from './app/persona.ts'
import type { ChannelInboxPort, ChannelsPort, Deps, PeoplePort } from './app/ports.ts'
import { programNoteAction, repairProgramAuthorities } from './app/programs.ts'
import { seedAgents } from './app/seed.ts'
import { addOrder, chatDestinations, listOrders, removeOrder } from './app/standing-orders.ts'
import { createThread, ensureAllFirstThreads } from './app/threads.ts'
import {
  CLIENT,
  cancelQueuedTask,
  completeTask,
  createTask,
  dispatchQueue,
  listBoard,
  stopRunningTask,
  updateQueuedTask,
} from './app/work-queue.ts'
import type { Collector } from './domain/collectors.ts'
import type { Decision } from './domain/decisions.ts'
import { areaOf } from './domain/library.ts'
import { nameOf } from './domain/persona.ts'
import { parseProgramSession } from './domain/programs.ts'
import { parseRehearsalSession } from './domain/rehearsal.ts'
import { hostTimezone } from './domain/settings.ts'
import { legacyThreadSessionId, sortThreads } from './domain/threads.ts'
import { parseAssignedSession } from './domain/work-queue.ts'
import { createApp } from './http/app.ts'
import { MAX_REQUEST_BYTES } from './http/body-limit.ts'
import { BOOT_ID } from './http/boot.ts'
import { artifactContentRoutes } from './infra/artifacts/content.ts'
import {
  type ArtifactDecisions,
  type ArtifactService,
  createArtifactService,
} from './infra/artifacts/index.ts'
import { KEEP_PRIVATE_OPTION, PUBLISH_OPTION } from './infra/artifacts/plugin.ts'
import { type BigDataConfig, communityFixture } from './infra/bigdata/index.ts'
import { seedBuiltinSkills } from './infra/bigdata/skills.ts'
import { createBrowserHook } from './infra/browser/hook.ts'
import {
  type BrowserServiceOptions,
  browserConfigFromEnv,
  createBrowserService,
} from './infra/browser/index.ts'
import { createBrowserPort } from './infra/browser/port.ts'
import { createChannelInboxPort, lazyInboxPort } from './infra/channels/admin.ts'
import { channelApprovalAnswerer, watchPendingChanges } from './infra/channels/attention.ts'
import {
  type ChannelGateway,
  channelVaultFromEnv,
  createChannelGateway,
} from './infra/channels/index.ts'
import { createPeoplePort, lazyPeoplePort } from './infra/channels/people-admin.ts'
import { webReminderSession } from './infra/channels/reminders.ts'
import { webReminderPost } from './infra/channels/web-reminders.ts'
import { type CodeConfig, codeConfigFromEnv, createCodeRuntime } from './infra/code/index.ts'
import { sqliteActivityStore } from './infra/db/activity-store.ts'
import { drizzleAgentRepo } from './infra/db/agents-repo.ts'
import { sqliteChatTools } from './infra/db/chat-tools-repo.ts'
import { type Connection, openDatabase } from './infra/db/client.ts'
import { drizzleDecisionStore } from './infra/db/decisions-repo.ts'
import { sqliteHealthStore } from './infra/db/health-repo.ts'
import { sqliteHeartbeatStore } from './infra/db/heartbeat-repo.ts'
import { sqliteModelCallStore } from './infra/db/model-calls-repo.ts'
import { sqliteSessionModes } from './infra/db/modes-repo.ts'
import { sqliteBriefingStore, sqliteNotificationStore } from './infra/db/notifications-repo.ts'
import { sqlitePersonaStore } from './infra/db/persona-repo.ts'
import { sqliteProgramMemory } from './infra/db/program-memory-repo.ts'
import { drizzleProgramStore } from './infra/db/programs-repo.ts'
import { sqliteProgramTestStore, sqliteRehearsalStore } from './infra/db/rehearsal-repo.ts'
import {
  compactDatabase,
  pruneTables,
  reclaimSpace,
  type TableRetention,
} from './infra/db/retention.ts'
import { sqliteRoutineStore } from './infra/db/routines-repo.ts'
import { sqliteSettingsStore } from './infra/db/settings-repo.ts'
import { sqliteTaskStore } from './infra/db/tasks-repo.ts'
import { sqliteThreadStore } from './infra/db/threads-repo.ts'
import { type ActivityLog, createActivityLog } from './infra/eh/activity-log.ts'
import {
  type AgentFactory,
  type AgentFactoryDeps,
  createAgentFactory,
  type TeamLimits,
} from './infra/eh/agent-factory.ts'
import { createChangeFeed } from './infra/eh/change-feed.ts'
import { createChatService } from './infra/eh/chat-service.ts'
import { createChatToolsService } from './infra/eh/chat-tools-service.ts'
import type { CatalogOptions } from './infra/eh/connector-catalog.ts'
import { type ConnectorsRuntime, createConnectors, SEALED_KINDS } from './infra/eh/connectors.ts'
import { backfillCustomSlugs, migrateLegacyAgents } from './infra/eh/connectors-migration.ts'
import { createDecisionHandoff } from './infra/eh/decision-handoff.ts'
import { createDecisionService, type DecisionService } from './infra/eh/decision-service.ts'
import type { DecisionIntake } from './infra/eh/decisions-plugin.ts'
import { createEventAppender } from './infra/eh/event-appender.ts'
import { createTeamHttp } from './infra/eh/harness-http.ts'
import { heartbeatChannels } from './infra/eh/heartbeat-channels.ts'
import type { HeartbeatIntake } from './infra/eh/heartbeat-plugin.ts'
import { createHeartbeatService, type HeartbeatService } from './infra/eh/heartbeat-service.ts'
import { type LibraryChange, libraryFs } from './infra/eh/library-fs.ts'
import { sqliteLibraryStore } from './infra/eh/library-store.ts'
import { createModeService } from './infra/eh/mode-service.ts'
import { createObserver } from './infra/eh/observe.ts'
import type { PersonaIntake } from './infra/eh/persona-plugin.ts'
import { sqliteProfileStore } from './infra/eh/profile-store.ts'
import { createProgramService, type ProgramService } from './infra/eh/program-service.ts'
import {
  type ModelConfig,
  providerModelConfig,
  scriptedModelConfigFromEnv,
} from './infra/eh/provider.ts'
import { createProviderService, PROVIDER_KIND, type ProviderService } from './infra/eh/providers.ts'
import { createRehearsalService, type RehearsalService } from './infra/eh/rehearsal-service.ts'
import {
  createRoutineService,
  type RoutineEngineConfig,
  type RoutineService,
} from './infra/eh/routine-service.ts'
import { teamVaultFromEnv } from './infra/eh/secret-vault.ts'
import { sqliteSessionQueue } from './infra/eh/session-queue.ts'
import { setBudgetLimit, sqliteBudgetLedger, sqliteLock } from './infra/eh/storage.ts'
import {
  createTeamService,
  type ReconcileReport,
  type TeamService,
} from './infra/eh/team-service.ts'
import { withThreadActivity } from './infra/eh/thread-activity.ts'
import { sqliteUploadStore } from './infra/eh/upload-store.ts'
import { createDedupedWarningLog } from './infra/eh/warning-log.ts'
import type { WorkQueueIntake } from './infra/eh/work-queue-plugin.ts'
import { installJsonSchemaValidator } from './infra/json-schema.ts'
import { croneSchedule } from './infra/schedule.ts'
import {
  createTelegramChannels,
  lazyChannelsPort,
  type TelegramChannels,
} from './infra/telegram/service.ts'
import type { TgClientFactory } from './infra/telegram-user/client.ts'
import { createMtcuteClient } from './infra/telegram-user/mtcute-client.ts'
import {
  compositeChannelsPort,
  createTelegramUserChannels,
  lazyAccountsPort,
  type TelegramUserChannels,
} from './infra/telegram-user/service.ts'
import { resolveWebUrl, upgradeEnv, webStatic } from './infra/web-static.ts'

export interface ServerConfig {
  dbFile: string
  token?: string | undefined
  /** Skip seeding (tests that start empty). */
  seed?: boolean
  /** `BASIC_AUTH_PASSWORD`: password login for every route (a session cookie, or the bearer token). Empty = no login. */
  loginPassword?: string | undefined
  /** Seed the example agents into an empty workspace (compose default true for tests; the server entry seeds only with `TEAM_SEED_AGENTS=1`). */
  seedAgents?: boolean
  /** Model config override (tests); default from the environment. */
  models?: ModelConfig
  /** Context windows and prices of models; default: the catalog of the provider manager. */
  catalog?: ModelCatalog
  /** Environment of the provider profiles (default `process.env`); tests pass `{}`. */
  env?: Record<string, string | undefined>
  /** The secret vault (default: `TEAM_SECRET_KEY`, else a dev key file next to the DB). */
  vault?: SecretVault
  /**
   * Stable id of this instance (default `TEAM_INSTANCE_ID`, else `team-<port>` when started as a
   * server): a restarted instance recovers its own orphaned turns at once.
   */
  instanceId?: string
  /** Never fetch the public model catalogs (default: `TEAM_OFFLINE=1`). */
  offline?: boolean
  /** The fetch of model lists, connection tests and catalogs (default: global). */
  fetch?: typeof fetch
  /** Poll interval of the change feed shared by providers and connectors (ms, default 1000; 0 = off). */
  changePollMs?: number
  /** Builds the browser runtime of a connected Remote sandbox (default: the sandbox-server client; tests inject a fake). */
  browserRemoteRuntime?: BrowserServiceOptions['remoteRuntime']
  /** Lists the tools of a remote MCP server when a connection is tested (tests inject a fake). */
  mcpListTools?: CatalogOptions['listTools']
  /** Public URL of this server (OAuth redirect URI base). Default `TEAM_PUBLIC_URL`, else `http://localhost:4000`. */
  publicUrl?: string
  /** URL of the web app (the OAuth callback redirects there). Default `TEAM_WEB_URL`, else `http://localhost:5173`. */
  webUrl?: string
  /** Auto mode classifier override (tests); default: the model of `models.classifierModel`. */
  classifier?: AgentFactoryDeps['classifier']
  /** `debug.invariants` of every agent (default `TEAM_DEBUG_INVARIANTS=1`; the tests turn it on). */
  debug?: { invariants?: boolean }
  /** Timers of the stream log and inbox (tests shorten them). */
  tuning?: AgentFactoryDeps['tuning']
  /** Delegation limits (spawn cap, child steps, park timeout). */
  limits?: TeamLimits
  /** The big-data toolkit: data sources of `ingest_source`, limits of `run_code` (`infra/bigdata`). */
  bigData?: BigDataConfig
  /** The code sandbox (`run_python`): overrides of what `TEAM_CODE_*` say (tests). */
  code?: Partial<CodeConfig>
  /** Monthly USD limit of the workspace ledger scope. */
  budgetUsd?: number
  /** Model call log retention: rows kept (default 5000) and days kept (default 7). */
  logs?: { maxRows?: number; retentionDays?: number; jsonCap?: number }
  /** Poll interval of the SSE events feed (ms, default 500). */
  eventsPollMs?: number
  /**
   * Events table retention: hours kept (default 72) and rows kept (default 100 000), pruned at
   * boot and every `pruneEveryMs` (default 10 min; 0 = never again). `retentionHours: 0` keeps by count only.
   */
  events?: { retentionHours?: number; maxRows?: number; pruneEveryMs?: number }
  /**
   * One-time `VACUUM` into `auto_vacuum=INCREMENTAL` at boot (env `TEAM_DB_COMPACT=1`), so deleted
   * media give their disk space back. Needs free disk of about the database size; see the README.
   */
  dbCompact?: boolean
  /** Retention of finished routine runs, finished tasks, library history and media (days; 0 = keep). */
  retention?: TableRetention
  /** Agent health scan (anomaly findings, bell notice for new high ones): every `everyMs` (default 10 min; 0 = never; off when `reconcile.everyMs` is 0). */
  health?: { everyMs?: number }
  /** Routine ticker (interval, lookahead, grace, recovery). `tickMs: 0` = no timer. */
  routines?: RoutineEngineConfig
  /** Heartbeat tuning (tests): how long new chat messages settle before an early beat starts. */
  heartbeat?: { activitySettleMs?: number }
  /**
   * Repair pass (`reconcileSubagentWaits` + task drift): at boot (default on) and every
   * `everyMs` (default 60 000; 0 = never).
   */
  reconcile?: { onBoot?: boolean; everyMs?: number }
  /**
   * Channels gateway (`infra/channels`). `vault` seals the channel log (default `TEAM_CHANNEL_KEY`,
   * else a dev key file next to the DB); the rest are timers tests shorten.
   */
  channels?: {
    vault?: SecretVault
    collect?: { quietMs: number; maxWaitMs: number; maxItems: number }
    typingEveryMs?: number
    /** Outbound queue clock (tests). */
    outbound?: { now?: () => number; sleep?: (ms: number) => Promise<void> }
    /** Purge of the channel log past its retention: every `purgeEveryMs` (default 1 h; 0 = boot only). */
    purgeEveryMs?: number
    /** Most active repeating reminders one person may have (default 10; env TEAM_MAX_REPEATING_REMINDERS; 0 = no limit). */
    maxRepeatingReminders?: number
    /** Retry timing of the outbox (tests shorten it). */
    delivery?: { retryBaseMs?: number; retryMaxMs?: number; maxAttempts?: number }
    /** Period of the pass that expires approvals and sends held proactive posts (default 60 s; 0 = off). */
    maintenanceMs?: number
  }
  /** Telegram bot transport timers (tests shorten them). */
  telegram?: { pollTimeoutSec?: number; syncPollMs?: number; retryMs?: number }
  /**
   * Telegram user accounts (`infra/telegram-user`, MTProto). `client` replaces mtcute (tests pass
   * a fake: nothing here ever reaches Telegram then); the rest are timers tests shorten.
   */
  telegramUser?: {
    client?: TgClientFactory
    syncPollMs?: number
    retryMs?: number
    leaseTtlMs?: number
    qrPollMs?: number
    settleMs?: number
    jobs?: {
      sleep?: (ms: number) => Promise<void>
      random?: () => number
      pageDelayMs?: { min: number; max: number }
      backfillEveryMs?: number
      adminLogTickMs?: number
      gapWindowMs?: number
    }
  }
}

export interface Server {
  app: OpenAPIHono
  /** The artifact content routes (`/art/*`): served on `TEAM_ARTIFACT_PORT` too. */
  artifactContent: { fetch: (request: Request) => Response | Promise<Response> }
  /** Artifacts: records, versions, signed content URLs (`infra/artifacts`). */
  artifacts: ArtifactService
  deps: Deps
  conn: Connection
  factory: AgentFactory
  team: TeamService
  routines: RoutineService
  /** Program runs (`infra/eh/program-service.ts`). */
  programs: ProgramService
  /** Rehearsals (test runs) and program test cases (`infra/eh/rehearsal-service.ts`). */
  rehearsals: RehearsalService
  /** Resumes the sessions parked on a decision (`infra/eh/decision-service.ts`). */
  decisions: DecisionService
  /** Heartbeat beats and the daily digest (`infra/eh/heartbeat-service.ts`). */
  heartbeats: HeartbeatService
  /** The channels gateway: connections, adapters, pairing, the channel log (`infra/channels`). */
  channels: ChannelGateway
  /** The Telegram bot transport and the admin service behind the Channels page (`infra/telegram`). */
  telegram: TelegramChannels
  /** Telegram user accounts over MTProto: runtime, admin service and the chat picker (`infra/telegram-user`). */
  telegramUser: TelegramUserChannels
  /** Operational counters of the runtime (`config.observe`): failed spans, hook timeouts, ... */
  metrics: () => Record<string, number>
  /** The model call log writer (the `model.call` plugin and the classifier observer). */
  activityLog: ActivityLog
  /** One agent health pass now (what the timer runs): findings, bell notices and authority suggestions. */
  healthScan(): Promise<HealthJobReport>
  /** Connectors: connections, flows, enablement, activation. */
  connectors: ConnectorsRuntime
  /** Resolves when the legacy migration ran and the connectors of every agent are activated. */
  connectorsReady: Promise<void>
  /** The provider manager behind `GET /providers` and the model port. */
  providers: ProviderService
  /** Resolves when the provider profiles and catalogs are loaded (await before serving chats). */
  providersReady: Promise<void>
  /** Resolves when the boot repair pass finished. */
  ready: Promise<void>
  /** Run the repair pass now (idempotent; every instance may run it). */
  reconcile(): Promise<ReconcileReport>
  close(): Promise<void>
}

export const WORKSPACE_ID = 'default'

/** True when a web URL points at this machine (`http://localhost:5173`): not reachable from a chat. */
function isLoopbackWebUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname)
  } catch {
    return true
  }
}

export function compose(config: ServerConfig): Server {
  installJsonSchemaValidator()
  const conn = openDatabase(config.dbFile)
  const agents = drizzleAgentRepo(conn.db)

  const tasks = sqliteTaskStore(conn.sqlite)
  // the shared feed on eharness/activity: session events come from its `activity()` plugin, the
  // app appends its own types (providers-changed, settings-changed, ...) through `events`; the
  // routes that read it are the `activity` option of eharness/http (below)
  // the channels gateway is built later; it hears about pending items of channel sessions through the feed
  let channelGateway: ChannelGateway | undefined
  const activityStore = watchPendingChanges(sqliteActivityStore(conn.sqlite), (e) =>
    channelGateway?.pendingChanged(e),
  )
  const threadStore = sqliteThreadStore(conn.sqlite)
  const events = withThreadActivity(createEventAppender(activityStore), threadStore)
  // ONE vault, ONE profile table and ONE sealing path: provider profiles, connections, their
  // credentials and OAuth app credentials all go through `sealedProfileStore`. Rows written by
  // earlier versions (legacy `v1:` blobs) open through the vault's legacy reader and are
  // re-sealed in the background below.
  const instance = crypto.randomUUID()
  const vault =
    config.vault ??
    teamVaultFromEnv({
      ...(config.env === undefined ? {} : { env: config.env }),
      dataDir: config.dbFile === ':memory:' ? undefined : dirname(config.dbFile),
    })
  let connectorsRef: ConnectorsRuntime | undefined
  const profileStore = sealedProfileStore({
    inner: sqliteProfileStore(conn.sqlite, {
      onChange: ({ kind, id, action }) => {
        if (kind === PROVIDER_KIND) {
          events.append({ type: 'providers-changed', payload: { profileId: id, action, instance } })
        } else if (kind === 'connection') {
          // appends `connectors-changed` and bumps the local revision
          connectorsRef?.profileChanged(kind)
        }
      },
    }),
    vault,
    kinds: [PROVIDER_KIND, ...SEALED_KINDS],
    onUnreadable: ({ kind, id, error }) =>
      console.warn(`team: ${kind} "${id}" is unreadable and was skipped: ${errorText(error)}`),
  })
  // one poller of the event feed for every kind of configuration change
  const changes = createChangeFeed({
    feed: activityStore,
    instance,
    ...(config.changePollMs === undefined ? {} : { pollMs: config.changePollMs }),
  })
  // model providers: env profiles + encrypted profiles from the web; TEAM_SCRIPTED_MODEL wins
  const providers = createProviderService({
    sqlite: conn.sqlite,
    store: profileStore,
    ...(config.env === undefined ? {} : { env: config.env }),
    ...(config.offline === undefined ? {} : { offline: config.offline }),
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    changes,
  })
  const models: ModelConfig =
    config.models ?? scriptedModelConfigFromEnv(config.env) ?? providerModelConfig(providers)
  // profiles and catalogs load in the background; `resolve` needs them (main awaits this)
  const providersReady = providers.ready()
  providersReady.catch(() => undefined)

  // artifacts (docs/plans/P45-team-artifacts.md): built once the URLs are known (below)
  let artifactService: ArtifactService | undefined
  // every change of a library file (agents, uploads, people) reaches the event feed
  const onFileChange = (c: LibraryChange): void => {
    artifactService?.onLibraryChange(c)
    events.append({
      type: 'file-changed',
      agentId: c.agentId,
      payload: {
        action: c.action,
        path: c.path,
        ...(c.to === undefined ? {} : { to: c.to }),
        version: c.version,
        area: areaOf(c.path),
      },
    })
  }
  const modelCalls = sqliteModelCallStore(conn.sqlite, {
    ...(config.logs?.jsonCap === undefined ? {} : { jsonCap: config.logs.jsonCap }),
  })
  const activityLog = createActivityLog({
    store: modelCalls,
    tasks,
    events,
    agentOf: (slug) => agents.getBySlug(slug),
    ...(config.logs?.maxRows === undefined ? {} : { maxRows: config.logs.maxRows }),
    ...(config.logs?.retentionDays === undefined
      ? {}
      : { retentionDays: config.logs.retentionDays }),
    log: { warn: (message) => console.warn(`team: ${message}`) },
  })
  activityLog.prune()
  const eventsRetentionMs = (config.events?.retentionHours ?? 72) * 3_600_000
  const eventsMaxRows = config.events?.maxRows ?? 100_000
  const pruneEvents = (): void => {
    activityStore
      .prune({
        ...(eventsRetentionMs > 0 ? { olderThan: Date.now() - eventsRetentionMs } : {}),
        keepLast: eventsMaxRows,
        // the last message of every agent survives retention: the sidebar preview
        keepLatestOf: [{ type: 'message-added', by: 'agentId' }],
      })
      .catch((error) => console.warn(`team: pruning events failed: ${String(error)}`))
  }
  const pruneOld = (): void => {
    try {
      const pruned = pruneTables(conn.sqlite, config.retention)
      // deleted media (library files) are the bulk of the database: hand the pages back
      if (pruned.media > 0) reclaimSpace(conn.sqlite)
    } catch (error) {
      console.warn(`team: pruning tables failed: ${String(error)}`)
    }
  }
  if (config.dbCompact === true) {
    try {
      if (compactDatabase(conn.sqlite))
        console.info('team: database converted to auto_vacuum=INCREMENTAL')
    } catch (error) {
      console.warn(`team: compacting the database failed: ${String(error)}`)
    }
  }
  pruneEvents()
  pruneOld()
  const pruneEveryMs = config.events?.pruneEveryMs ?? 600_000
  const pruneTimer =
    pruneEveryMs > 0
      ? setInterval(() => {
          pruneEvents()
          pruneOld()
        }, pruneEveryMs)
      : undefined
  pruneTimer?.unref()
  const settings = sqliteSettingsStore(conn.sqlite, {
    defaults: {
      toolAccess: 'auto',
      defaultPermissionMode: 'default',
      budgetUsd: config.budgetUsd ?? null,
      spawnCap: config.limits?.spawnCap ?? 4,
      defaultModel: null,
      defaultProfile: null,
      timezone: hostTimezone(process.env),
    },
    // the limit is a row of the shared ledger: apply it now; other instances read the row
    onChange: (s) => setBudgetLimit(conn.sqlite, `workspace:${WORKSPACE_ID}`, s.budgetUsd),
  })
  const publicUrl = (
    config.publicUrl ??
    process.env.TEAM_PUBLIC_URL ??
    `http://localhost:${process.env.PORT ?? 4000}`
  ).replace(/\/$/, '')
  const webUrl = resolveWebUrl({
    ...(config.webUrl === undefined ? {} : { configured: config.webUrl }),
    env: config.env ?? process.env,
    publicUrl,
  })
  const envOf = config.env ?? process.env
  // content is served by this server under /art/* unless TEAM_ARTIFACT_URL / TEAM_ARTIFACT_PORT say
  // otherwise. Default: root-relative URLs (`/art/...`), resolved against the page that shows them:
  // the one-port image serves /art next to the web, and the dev web proxies /art like /api.
  const artifactPort = envOf.TEAM_ARTIFACT_PORT?.trim()
  const contentUrl = (
    envOf.TEAM_ARTIFACT_URL?.trim() ||
    (artifactPort
      ? (() => {
          const u = new URL(publicUrl)
          u.port = artifactPort
          return u.origin
        })()
      : '')
  ).replace(/\/$/, '')
  const signingSecret =
    envOf.TEAM_SECRET_KEY || vault.keyId
      ? `artifacts|${envOf.TEAM_SECRET_KEY ?? ''}|${vault.keyId ?? ''}`
      : // no stable secret: signed links die with the process (the web asks for a new one)
        `artifacts|${crypto.randomUUID()}`
  const artifacts = createArtifactService({
    sqlite: conn.sqlite,
    now: () => Date.now(),
    nextId: () => uuidv7(),
    webUrl,
    contentUrl,
    secret: signingSecret,
    onFileChange,
  })
  artifactService = artifacts
  const artifactContent = artifactContentRoutes(artifacts)
  const codeRuntime = createCodeRuntime(
    {
      ...codeConfigFromEnv(config.env ?? process.env, config.dbFile),
      ...config.code,
    },
    { programs: () => programStore },
  )
  void codeRuntime.start()
  // the browser (plan P48): one manager over profiles sealed with the same vault; engines it starts
  // are killed by `close()`
  const browserService = createBrowserService({
    config: browserConfigFromEnv(config.env ?? process.env, config.dbFile),
    sqlite: conn.sqlite,
    vault,
    // the Remote sandbox connection can host managed Chrome profiles (`connectors` comes below)
    remote: async () => connectors.remoteSandboxSettings(),
    ...(config.browserRemoteRuntime === undefined
      ? {}
      : { remoteRuntime: config.browserRemoteRuntime }),
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    log: { warn: (message) => console.warn(`team: ${message}`) },
  })
  const connectors = createConnectors({
    code: codeRuntime,
    sqlite: conn.sqlite,
    profiles: profileStore,
    vault,
    lock: sqliteLock(conn.sqlite),
    agentById: (id) => agents.get(id),
    agents: () => agents.list(),
    ...(models.search === undefined ? {} : { search: models.search }),
    ...(config.mcpListTools === undefined ? {} : { listTools: config.mcpListTools }),
    onFileChange,
    ...(config.env === undefined ? {} : { env: config.env }),
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    redirectUri: `${publicUrl}/oauth/callback`,
    events,
    changes,
    toolAccess: () => settings.get().toolAccess,
    instance,
    ...(config.telegramUser?.client === undefined
      ? {}
      : { telegramUserClient: config.telegramUser.client }),
    telegramUserFlow: {
      ...(config.telegramUser?.qrPollMs === undefined
        ? {}
        : { qrPollMs: config.telegramUser.qrPollMs }),
      ...(config.telegramUser?.settleMs === undefined
        ? {}
        : { settleMs: config.telegramUser.settleMs }),
    },
  })
  connectorsRef = connectors
  const routineStore = sqliteRoutineStore(conn.sqlite)
  const programStore = drizzleProgramStore(conn.db)
  const decisionStore = drizzleDecisionStore(conn.db)
  // the decision tools of the agents need the app deps, which are built after the factory
  let decisionIntake: DecisionIntake | undefined
  // "make this artifact public?" of a run nobody is talking to (late-bound with the decision intake)
  let artifactDecisions: ArtifactDecisions | undefined
  // the same for the heartbeat tools (`team_status`) and the hook that records a beat
  let heartbeatIntake: HeartbeatIntake | undefined
  let workQueueIntake: WorkQueueIntake | undefined
  // the persona tool (docs/plans/P42-team-persona.md) needs the app deps too
  const personaStore = sqlitePersonaStore(conn.sqlite)
  let personaIntake: PersonaIntake | undefined
  // the channels gateway needs the app deps too (declared with the activity store above)
  // the fixture community source is a demo: it is only there when asked for
  // a live list: Telegram user accounts add and remove their observe-only chats as sources (`ingest_source`)
  const collectorList: Collector[] = [
    ...(config.bigData?.collectors ??
      ((config.env ?? process.env).TEAM_DEMO_COLLECTOR === '1' ? [communityFixture()] : [])),
  ]
  const bigDataConfig: BigDataConfig = { ...config.bigData, collectors: collectorList }
  const sessionModes = sqliteSessionModes(conn.sqlite)
  const chatToolsStore = sqliteChatTools(conn.sqlite)
  let routines: RoutineService | undefined
  const observer = createObserver({ log: (message) => console.warn(message) })
  const logWarning = createDedupedWarningLog({})
  const factory = createAgentFactory({
    sqlite: conn.sqlite,
    models,
    connectors,
    ...(config.catalog === undefined ? {} : { catalog: config.catalog }),
    workspaceId: WORKSPACE_ID,
    roster: () => agents.list().filter((a) => a.role === 'role' || a.role === 'custom'),
    lead: () => agents.list().find((a) => a.role === 'lead'),
    agentBySlug: (slug) => agents.getBySlug(slug),
    agentById: (id) => agents.get(id),
    ...(config.classifier === undefined ? {} : { classifier: config.classifier }),
    sessionModes,
    programs: programStore,
    // an assigned task may come with extra permissions (the grants of its row)
    taskGrants: (sessionId) => {
      const parsed = parseAssignedSession(sessionId)
      return parsed === undefined ? undefined : (tasks.get(parsed.taskId)?.grants ?? undefined)
    },
    // an assigned task posts like a chat when the client created it or granted channel_send
    taskMayPost: (sessionId) => {
      const parsed = parseAssignedSession(sessionId)
      const task = parsed === undefined ? undefined : tasks.get(parsed.taskId)
      return (
        task !== undefined &&
        (task.createdBy === CLIENT || (task.grants?.tools ?? []).includes('channel_send'))
      )
    },
    bigData: bigDataConfig,
    artifacts: { service: artifacts, decisions: () => artifactDecisions },
    decisions: () => decisionIntake,
    heartbeat: () => heartbeatIntake,
    workQueue: () => workQueueIntake,
    personas: personaStore,
    personaIntake: () => personaIntake,
    channels: () => channelGateway,
    chatTools: chatToolsStore,
    // Auto blocked / paused / resumed: the web shows "auto paused" from this event
    onAutoEvent: ({ sessionId, agentId, event, state, mode }) =>
      events.append({
        type: 'mode-changed',
        agentId,
        sessionId,
        payload: {
          mode,
          autoPaused: state.paused,
          auto: event.type,
          ...(event.type === 'blocked' || event.type === 'unavailable'
            ? { tool: event.toolName, reason: event.reason }
            : {}),
        },
      }),
    taskStore: tasks,
    activityLog,
    activityStore,
    events,
    settings: () => {
      const s = settings.get()
      return { ...s, rev: s.updatedAt }
    },
    routineOutcomes: () => routines?.outcomes,
    onFileChange,
    ...(config.limits === undefined ? {} : { limits: config.limits }),
    onWarning: (w) => {
      // scripted (offline) models have no prices
      if (w.code === 'W_MODEL_UNPRICED' && models.provider === 'scripted') return
      logWarning(w)
    },
    observe: observer.observe,
    debug: { invariants: config.debug?.invariants ?? process.env.TEAM_DEBUG_INVARIANTS === '1' },
    ...(config.tuning === undefined ? {} : { tuning: config.tuning }),
    ...(config.instanceId === undefined ? {} : { instanceId: config.instanceId }),
  })
  const team = createTeamService(factory, {
    agents,
    tasks,
    threads: threadStore,
    events,
    activity: activityStore,
    log: { warn: (message) => console.warn(`team: ${message}`) },
  })
  const schedule = croneSchedule()
  const programRunner = createProgramService(factory, {
    agents,
    tasks,
    events,
    app: () => deps,
    log: { warn: (message) => console.warn(`team: ${message}`) },
  })
  const rehearsalStore = sqliteRehearsalStore(conn.sqlite)
  const programTestStore = sqliteProgramTestStore(conn.sqlite)
  // a rehearsal that was running when the process stopped cannot be continued
  rehearsalStore.failRunning('the server restarted while it ran', Date.now())
  const rehearsalService = createRehearsalService(factory, {
    agents,
    rehearsals: rehearsalStore,
    tests: programTestStore,
    programs: programStore,
    // the real library, read through the overlay and never written (no `onChange`: no events)
    library: libraryFs(conn.sqlite),
    ids: () => uuidv7(),
    log: { warn: (message) => console.warn(`team: ${message}`) },
  })
  const decisionService = createDecisionService(factory, {
    agents,
    // a decided takeover gives the browser back to the agent
    handBack: (profileId) => browserService.manager.handBack(profileId, 'The client'),
    // a run the client let continue after failed deliverables is checked again when it ends
    afterRun: async (sessionId) => {
      const task = tasks.getBySession(sessionId)
      if (task?.deliverables?.status === 'fail') await recheckTask(deps, task.id)
      // a run that parked before it reported was never checked: check it now (with the fix-up turn)
      else await programRunner.verifyResumed(sessionId)
    },
    log: { warn: (message) => console.warn(`team: ${message}`) },
  })
  const heartbeatStore = sqliteHeartbeatStore(conn.sqlite)
  const budgetLedger = sqliteBudgetLedger(conn.sqlite)
  const heartbeats = createHeartbeatService(factory, {
    deps: () => deps,
    agents,
    events,
    store: heartbeatStore,
    channels: heartbeatChannels(() => channelGateway),
    ...(config.heartbeat?.activitySettleMs === undefined
      ? {}
      : { activitySettleMs: config.heartbeat.activitySettleMs }),
    budget: async () => {
      const checked = await budgetLedger.check?.([`workspace:${WORKSPACE_ID}`])
      const scope = checked?.scopes[0]
      return scope === undefined
        ? null
        : { spentUsd: scope.spentUsd, limitUsd: scope.limitUsd ?? null }
    },
    log: { warn: (message) => console.warn(`team: ${message}`) },
  })
  routines = createRoutineService(factory, {
    sqlite: conn.sqlite,
    agents,
    queue: sqliteSessionQueue(conn.sqlite),
    routines: routineStore,
    schedule,
    tasks,
    events,
    programs: { store: programStore, runner: programRunner },
    // the heartbeat and the digest, plus the reminders created from a chat (a fire posts text, no model)
    system: () => ({
      heartbeat: heartbeats.heartbeat,
      digest: heartbeats.digest,
      reminder: async (id, input) =>
        (await channelGateway?.reminders.fire(id, input)) ?? {
          posted: false,
          reason: 'channels are not ready',
        },
    }),
    app: () => deps,
    // a routine in `dm` mode fires into a live thread of the agent, never an archived one
    dmSession: (agentId) => {
      const agent = agents.get(agentId)
      const live = threadStore.list(agentId).filter((t) => t.archivedAt === null)
      const open = sortThreads(live)[0]
      if (open !== undefined) return open.sessionId
      if (
        agent === undefined ||
        agent.archivedAt !== null ||
        threadStore.list(agentId).length === 0
      ) {
        return legacyThreadSessionId(agentId)
      }
      // every thread is archived: open a new one rather than write into an archived chat
      return createThread(deps, agentId, { title: 'Routines' }).sessionId
    },
    ...(config.routines === undefined ? {} : { config: config.routines }),
    log: { warn: (message) => console.warn(message) },
  })
  // the Channels page's service needs the gateway, which needs these deps: late-bound
  let telegram: TelegramChannels | undefined
  let telegramUser: TelegramUserChannels | undefined
  let channelsPort: ChannelsPort | undefined
  let channelInboxPort: ChannelInboxPort | undefined
  let peoplePort: PeoplePort | undefined
  const deps: Deps = {
    agents,
    persona: personaStore,
    chat: createChatService(factory, { workspaceId: WORKSPACE_ID }),
    threads: threadStore,
    notifications: sqliteNotificationStore(conn.sqlite),
    briefings: sqliteBriefingStore(conn.sqlite),
    chatTools: createChatToolsService({
      store: chatToolsStore,
      agentConnectors: (agent) => connectors.agentConnectors(agent),
    }),
    uploads: sqliteUploadStore(conn.sqlite, { onChange: onFileChange }),
    tasks,
    team,
    library: sqliteLibraryStore(conn.sqlite, { onChange: onFileChange }),
    artifacts,
    settings,
    providers,
    connectors,
    channels: lazyChannelsPort(() => channelsPort),
    channelAccounts: lazyAccountsPort(() => telegramUser),
    channelInbox: lazyInboxPort(() => channelInboxPort),
    people: lazyPeoplePort(() => peoplePort),
    webUrl,
    browser: createBrowserPort(browserService),
    codeSandbox: {
      info: async () => {
        const info = await codeRuntime.info()
        const remote = await connectors.remoteSandboxStatus()
        return remote === undefined ? info : { ...info, remote }
      },
    },
    modes: createModeService(factory, {
      store: sessionModes,
      workspaceDefault: () => settings.get().defaultPermissionMode,
    }),
    routines: routineStore,
    schedule,
    routineEngine: routines,
    programs: programStore,
    programRunner,
    rehearsals: rehearsalStore,
    programTests: programTestStore,
    programMemory: sqliteProgramMemory(conn.sqlite),
    rehearsalRunner: rehearsalService,
    decisions: decisionStore,
    decisionResolver: decisionService,
    decisionHandoff: createDecisionHandoff(decisionStore, decisionService),
    heartbeat: {
      ...heartbeats.ports,
      // a report of a standing order that was given in a web chat: the text lands in that thread as
      // a notice (stored at once, no model call) and rings the bell
      web: {
        deliver: async ({ agentId, sessionId, text, key }) => {
          const def = agents.get(agentId)
          if (def === undefined || def.archivedAt !== null)
            return { posted: false, reason: 'the agent is gone' }
          try {
            await factory.prepare(def)
            await factory
              .openSession(def, sessionId)
              .inject(
                'eh.notice',
                { level: 'info', code: 'EH_STANDING_ORDER', message: text },
                { key },
              )
          } catch (error) {
            return { posted: false, reason: `the chat is gone (${errorText(error)})` }
          }
          events.append({
            type: 'message-added',
            agentId: def.id,
            sessionId,
            payload: { role: 'assistant', preview: text.slice(0, 120) },
          })
          channelNotify({
            key: `standing-order:${key}`,
            title: `${def.name} reports`,
            body: text,
            agentId: def.id,
            link: `/a/${def.id}?t=${encodeURIComponent(sessionId)}`,
          })
          return { posted: true }
        },
      },
    },
    events,
    modelCalls,
    health: sqliteHealthStore(conn.sqlite),
    clock: { now: () => Date.now() },
    ids: { next: () => uuidv7() },
    workspaceId: WORKSPACE_ID,
  }
  /**
   * A question of a program run is asked where the program was proposed when that was a chat (the
   * owner lives there), next to the Decision Center. Never throws.
   */
  const announceInChat = (d: Decision): void => {
    if (d.kind !== 'escalation' || d.programId === null) return
    const proposal = deps.decisions
      .list({ kind: 'proposal', limit: 500 })
      .find((p) => p.programId === d.programId && p.sessionId !== null)
    if (proposal?.sessionId == null) return
    void channelGateway
      ?.announceDecision({
        sessionId: proposal.sessionId,
        decisionId: d.id,
        title: d.title,
        question: d.payload.question,
        options: d.payload.options,
      })
      .catch(() => undefined)
  }
  decisionIntake = {
    propose: (input) => {
      const { decision, duplicate } = proposeFromAgent(deps, input)
      return { id: decision.id, duplicate }
    },
    escalate: (input) => {
      const d = createEscalation(deps, input)
      announceInChat(d)
      return d
    },
    amend: (input) => createAmendment(deps, input),
    programNote: (input) => programNoteAction(deps, input),
    reportNeedsDecision: (input) => {
      const d = createReportEscalation(deps, input)
      if (d !== undefined) announceInChat(d)
    },
  }
  const publishTitle = (artifactId: string): string =>
    `Make artifact ${artifactId.slice(-6)} public?`
  artifactDecisions = {
    request: ({ agentId, sessionId, artifactId, title }) => {
      const d = createEscalation(deps, {
        agentId,
        sessionId,
        waitId: null,
        title: `Make "${title}" public?`.slice(0, 200),
        question: `${publishTitle(artifactId)} An agent wants a public link (anyone with it can open it, no sign-in) for "${title}" [artifact ${artifactId}].`,
        options: [PUBLISH_OPTION, KEEP_PRIVATE_OPTION],
        standDown: [KEEP_PRIVATE_OPTION],
      })
      announceInChat(d)
      return { id: d.id }
    },
    approved: (sessionId, artifactId) =>
      deps.decisions
        .list({ sessionId, kind: 'escalation', limit: 100 })
        .some(
          (d) =>
            d.kind === 'escalation' &&
            d.status === 'approved' &&
            d.outcome?.decision === PUBLISH_OPTION &&
            d.payload.question.includes(`[artifact ${artifactId}]`),
        ),
  }
  // the Browser connector (plan P48): a takeover is a Decision Center card with an "Open browser"
  // link; the live page's "Give back" (a manager event) or a card answer settles it
  connectors.hooks.browser = createBrowserHook({
    service: browserService,
    takeover: ({ agentId, sessionId, waitId, profileId, profileName, reason }) => {
      const who = agents.get(agentId)?.name ?? 'An agent'
      const d = createEscalation(deps, {
        agentId,
        sessionId,
        waitId,
        title: `${who} needs you in the browser`.slice(0, 200),
        question: reason,
        details: `Open the browser "${profileName}", do what is needed (a login, a CAPTCHA, a code), then give it back. Approving here also gives it back; rejecting tells the agent you could not.`,
        takeover: { profileId },
      })
      announceInChat(d)
      return { id: d.id }
    },
    images: (agentId) => {
      const def = agents.get(agentId)
      if (def === undefined) return true
      const modalities = factory.modelInfo(def).inputModalities
      return modalities === undefined || modalities.includes('image')
    },
  })
  const offBrowserEvents = browserService.manager.on((e) => {
    if (e.type !== 'handback') return
    void settleTakeovers(deps, e.profileId, e.info).catch((error) =>
      console.warn(`team: browser hand-back of ${e.profileId} failed: ${errorText(error)}`),
    )
  })
  personaIntake = {
    state: (agentId) => getPersonaState(deps, agentId),
    history: (agentId) => personaHistory(deps, agentId),
    propose: (agentId, input, actor, sessionId) =>
      proposePersona(deps, agentId, input, actor, sessionId),
    getProposal: (id) => personaStore.getProposal(id),
    apply: (id, actor) => applyProposal(deps, id, actor),
    revert: (agentId, version, actor) => revertPersona(deps, agentId, version, actor),
  }
  workQueueIntake = {
    create: (input) => createTask(deps, input),
    list: (query) => listBoard(deps, query),
    update: (id, patch) => updateQueuedTask(deps, id, patch),
    cancel: (id) => cancelQueuedTask(deps, id),
    stop: (id) =>
      stopRunningTask(deps, id, async (task, reason) => {
        const def = agents.get(task.agentId)
        if (def === undefined) return 'idle'
        await factory.prepare(def)
        const out = await factory.openSession(def, task.sessionId).abort(reason)
        return out.target === 'idle' ? 'idle' : 'aborted'
      }),
    authorizes: (sessionId, toolName) => {
      const parsed = parseProgramSession(sessionId) ?? parseRehearsalSession(sessionId)
      const program = parsed === undefined ? undefined : programStore.get(parsed.programId)
      // a worker program is given its work: reporting a task done is part of it
      if (toolName === 'complete_task' && program?.worker != null) return true
      return program?.authority.tools.includes(toolName) ?? false
    },
    complete: (sessionId, input) => completeTask(deps, sessionId, input),
  }
  heartbeatIntake = {
    status: async (agentId) => (await teamStatus(deps, agentId)).text,
    ended: async (end) => {
      await finishBeat(deps, { ...end, at: Date.now() })
    },
    canReadBriefings: (slug) => agents.getBySlug(slug)?.role === 'lead',
    briefings: (query) => briefingsText(deps, query),
    heartbeatOn: (slug) => {
      const def = agents.getBySlug(slug)
      return def !== undefined && effectiveConfig(deps, def).enabled
    },
    note: (agentId, entry) => appendNote(deps, agentId, entry),
    allowed: (agentId) => allowedDestinations(deps, agentId),
    reservePost: (agentId, to, text) => reservePost(deps, agentId, to, text),
    reportWeb: (agentId, orderId, text) => reportToWeb(deps, agentId, orderId, text),
    orders: {
      list: (agentId) => listOrders(deps, agentId),
      add: (agentId, input) => addOrder(deps, agentId, input),
      remove: (agentId, id) => removeOrder(deps, agentId, id),
      chats: (agentId) =>
        chatDestinations(deps, agentId).map((d) => ({
          connectionId: d.connectionId,
          nodeId: d.nodeId,
          label: d.label,
          proactive: d.proactive,
        })),
      label: (agentId, d) => destinationLabel(deps, agentId, d),
    },
  }
  // bell alerts of the channels (breaker opened, outbox failure, a bot token rejected)
  const channelNotify = (n: {
    key: string
    title: string
    body: string
    agentId: string | null
    link?: string
  }): void => {
    const added = deps.notifications.insert({
      id: deps.ids.next(),
      kind: 'alert',
      key: n.key,
      title: n.title,
      body: n.body,
      link: n.link ?? null,
      agentId: n.agentId,
      createdAt: Date.now(),
    })
    if (added !== undefined)
      events.append({ type: 'notification-changed', payload: { kind: 'alert' } })
  }
  // channels: chat platforms as sessions of an agent (docs/plans/P41-team-channels.md)
  const channelFiles = libraryFs(conn.sqlite)
  channelGateway = createChannelGateway({
    sqlite: conn.sqlite,
    // new messages in watched chats may start an early heartbeat (debounced in the service)
    onObserved: (event) => void heartbeats.activity(event),
    // a Decision Center question answered in a chat, by a named owner or admin
    answerDecision: async ({ decisionId, choice, by }) => {
      const answerer = { via: 'chat' as const, name: by.name }
      if (choice === 'rejected') await rejectDecision(deps, decisionId, { by: answerer })
      else
        await approveDecision(deps, decisionId, {
          ...(choice === 'approved' ? {} : { choice }),
          by: answerer,
        })
    },
    vault:
      config.channels?.vault ??
      channelVaultFromEnv({
        ...(config.env === undefined ? {} : { env: config.env }),
        dataDir: config.dbFile === ':memory:' ? undefined : dirname(config.dbFile),
      }),
    agents,
    threads: threadStore,
    events,
    sessions: {
      async enqueue(agentId, sessionId, input, options) {
        const def = agents.get(agentId)
        if (def === undefined) throw new Error(`no such agent: ${agentId}`)
        await factory.prepare(def)
        await factory.openSession(def, sessionId).enqueue(input as never, options)
      },
    },
    delegation: {
      // a requester's new message stops the foreground agent their turn waits for
      abort: async (childSessionId, reason) => {
        const task = tasks.getBySession(childSessionId)
        const def = task === undefined ? undefined : agents.get(task.agentId)
        if (def === undefined) return false
        await factory.prepare(def)
        const out = await factory.openSession(def, childSessionId).abort(reason)
        return out.target !== 'idle'
      },
    },
    attachments: {
      store: async (file) => {
        const stored = await uploadFile(deps, file)
        return {
          url: stored.url,
          mediaType: stored.mediaType,
          name: stored.name,
          path: stored.path,
        }
      },
    },
    files: {
      read: async (path) => {
        const file = await channelFiles.readBytes?.(path)
        if (file === null || file === undefined) return undefined
        return {
          bytes: file.bytes,
          mediaType: file.mediaType ?? file.meta.mediaType ?? 'application/octet-stream',
        }
      },
    },
    notify: (n) => channelNotify(n),
    // the team timezone decides what "today" and "09:00" mean in a chat
    timezone: () => settings.get().timezone,
    // who the agent is in a chat: its name and the team's, from configuration (never invented)
    identity: (agentId) => ({
      // the name the agent goes by: its persona's display name, else the definition's
      agentName: ((def) =>
        def === undefined ? undefined : nameOf(personaStore.latest(agentId)?.identity, def.name))(
        agents.get(agentId),
      ),
      teamName: (config.env ?? process.env).TEAM_NAME?.trim() || undefined,
    }),
    // reminders created from a chat are `sys:reminder:<id>` routines
    reminders: {
      routines: routineStore,
      schedule,
      ids: () => uuidv7(),
      // a reminder made in a web chat thread: the fixed text lands in that thread as a notice (no
      // model call) and rings the bell
      web: {
        deliver: async (rem, slot) => {
          const sessionId = webReminderSession(rem)
          const def = agents.get(rem.agentId)
          if (sessionId === undefined || def === undefined || def.archivedAt !== null)
            return { posted: false, reason: 'the chat of this reminder is gone' }
          const text = webReminderPost(rem.body)
          await factory.prepare(def)
          await factory
            .openSession(def, sessionId)
            .inject(
              'eh.notice',
              { level: 'info', code: 'EH_REMINDER', message: text },
              { key: `reminder:${rem.id}:${slot}` },
            )
          events.append({
            type: 'message-added',
            agentId: def.id,
            sessionId,
            payload: { role: 'assistant', preview: text.slice(0, 120) },
          })
          channelNotify({
            key: `reminder:${rem.id}:${slot}`,
            title: 'Reminder',
            body: text,
            agentId: def.id,
            link: `/a/${def.id}?t=${encodeURIComponent(sessionId)}`,
          })
          return { posted: true }
        },
      },
      maxRepeatingPerPerson:
        config.channels?.maxRepeatingReminders ??
        (Number.isInteger(Number((config.env ?? process.env).TEAM_MAX_REPEATING_REMINDERS)) &&
        (config.env ?? process.env).TEAM_MAX_REPEATING_REMINDERS?.trim() !== ''
          ? Number((config.env ?? process.env).TEAM_MAX_REPEATING_REMINDERS)
          : 10),
    },
    library: {
      write: async (path, text) => {
        await channelFiles.write(path, text)
      },
    },
    ...(config.channels?.maintenanceMs === undefined
      ? {}
      : { maintenanceMs: config.channels.maintenanceMs }),
    ...(config.channels?.collect === undefined ? {} : { collect: config.channels.collect }),
    ...(config.channels?.typingEveryMs === undefined
      ? {}
      : { typingEveryMs: config.channels.typingEveryMs }),
    ...(config.channels?.outbound === undefined ? {} : { outbound: config.channels.outbound }),
    ...(config.channels?.delivery === undefined ? {} : { delivery: config.channels.delivery }),
    // approvals of a channel turn can be answered from the chat, the same path as the web app
    approvals: { answer: channelApprovalAnswerer({ factory, agents, store: activityStore }) },
    webLink: ({ agentId, sessionId }) => {
      // a link to this machine is useless in a chat: only an address people can reach
      if (isLoopbackWebUrl(webUrl)) return undefined
      const thread = threadStore.getBySession(sessionId)
      return thread === undefined
        ? undefined
        : `${webUrl}/a/${agentId}?t=${encodeURIComponent(thread.id)}`
    },
    sessionPath: ({ agentId, sessionId }) => {
      const thread = threadStore.getBySession(sessionId)
      return thread === undefined ? undefined : `/a/${agentId}?t=${encodeURIComponent(thread.id)}`
    },
    log: { warn: (message) => console.warn(`team: ${message}`) },
  })
  const channels = channelGateway
  // the Telegram bot transport: one poller per connected, bound connection (`infra/telegram`)
  const telegramEnv = config.env ?? process.env
  telegram = createTelegramChannels({
    sqlite: conn.sqlite,
    gateway: channels,
    connectors,
    agents,
    notify: (n) => channelNotify(n),
    ...(telegramEnv.TEAM_TELEGRAM_API_ROOT === undefined
      ? {}
      : { apiRoot: telegramEnv.TEAM_TELEGRAM_API_ROOT }),
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    ...(config.telegram?.pollTimeoutSec === undefined
      ? {}
      : { pollTimeoutSec: config.telegram.pollTimeoutSec }),
    ...(config.telegram?.syncPollMs === undefined
      ? {}
      : { syncPollMs: config.telegram.syncPollMs }),
    ...(config.telegram?.retryMs === undefined ? {} : { retryMs: config.telegram.retryMs }),
  })
  // Telegram user accounts: one live MTProto client per connected, bound connection (`infra/telegram-user`)
  telegramUser = createTelegramUserChannels({
    sqlite: conn.sqlite,
    gateway: channels,
    connectors,
    agents,
    clientFactory: config.telegramUser?.client ?? createMtcuteClient(),
    instanceId: instance,
    collectors: {
      add: (c) => {
        const at = collectorList.findIndex((x) => x.id === c.id)
        if (at >= 0) collectorList.splice(at, 1)
        collectorList.push(c)
      },
      remove: (id) => {
        const at = collectorList.findIndex((x) => x.id === id)
        if (at >= 0) collectorList.splice(at, 1)
      },
    },
    notify: (n) => channelNotify(n),
    ...(config.telegramUser?.syncPollMs === undefined
      ? {}
      : { syncPollMs: config.telegramUser.syncPollMs }),
    ...(config.telegramUser?.retryMs === undefined ? {} : { retryMs: config.telegramUser.retryMs }),
    ...(config.telegramUser?.leaseTtlMs === undefined
      ? {}
      : { leaseTtlMs: config.telegramUser.leaseTtlMs }),
    ...(config.telegramUser?.jobs === undefined ? {} : { jobs: config.telegramUser.jobs }),
  })
  channelsPort = compositeChannelsPort(telegram, telegramUser)
  channelInboxPort = createChannelInboxPort({
    gateway: channels,
    connection: async (id) => (await channelsPort?.connection(id)) as unknown,
  })
  peoplePort = createPeoplePort({ gateway: channels, now: () => Date.now() })
  const purgeChannels = (): void => {
    try {
      channels.purge()
      // the activity of the channels follows the same retention as the events feed
      channels.activity.prune({
        ...(eventsRetentionMs > 0 ? { olderThan: Date.now() - eventsRetentionMs } : {}),
        keepLast: eventsMaxRows,
      })
    } catch (error) {
      console.warn(`team: purging the channel log failed: ${String(error)}`)
    }
  }
  purgeChannels()
  telegram.start()
  telegramUser.start()
  const channelPurgeMs = config.channels?.purgeEveryMs ?? 3_600_000
  const channelPurgeTimer =
    channelPurgeMs > 0 ? setInterval(purgeChannels, channelPurgeMs) : undefined
  channelPurgeTimer?.unref()
  if (config.seed !== false && config.seedAgents !== false) seedAgents(deps)
  // every agent has a persona: the first version is made from its old instructions (idempotent)
  ensureAllPersonas(deps)
  // agents from before threads keep their single DM as their first thread
  ensureAllFirstThreads(deps)
  // every agent with a heartbeat (the lead by default) has its routine, and the lead the digest
  ensureHeartbeats(deps)

  // one repair pass at a time per instance; safe to run on several instances at once
  let repairing: Promise<ReconcileReport> | undefined
  const reconcile = (): Promise<ReconcileReport> => {
    repairing ??= team
      .reconcile()
      .then((report) => {
        // a beat whose turn the repair closed will not end by itself: close its record too
        for (const { sessionId } of report.recovered) {
          const agentId = /^heartbeat:(.+)$/.exec(sessionId)?.[1]
          if (agentId !== undefined) {
            abandonBeat(deps, agentId, 'interrupted (the server stopped)', Date.now())
          }
        }
        // a chat turn a restart cut short: the person is told once to ask again
        for (const { sessionId } of report.recovered) {
          if (sessionId.startsWith('channel:')) {
            void channelGateway?.turnInterrupted(sessionId).catch((error) => {
              console.warn(`team: interruption notice of ${sessionId} failed: ${String(error)}`)
            })
          }
        }
        // ... and a routine or program run whose turn the repair closed must end its run row
        return Promise.all(
          report.recovered
            .filter(({ sessionId }) => /^(program|routine):/.test(sessionId))
            .map(({ sessionId }) =>
              routines?.outcomes.turnEnded({ sessionId, stop: 'interrupted', needsPerson: false }),
            ),
        ).then(() => report)
      })
      .finally(() => {
        repairing = undefined
      })
    return repairing
  }
  // queued tasks start on their own: after the repair pass (boot, so tasks queued before the
  // redesign or before a restart start), when a task ends, and on a short timer as a safety net
  const dispatch = (): void => {
    try {
      dispatchQueue(deps)
    } catch (error) {
      console.warn(`team: starting queued tasks failed: ${String(error)}`)
    }
  }
  const quiet = (): Promise<void> =>
    reconcile().then(
      () => dispatch(),
      (error) => console.warn(`team: reconcile failed: ${String(error)}`),
    )
  // agents from before connectors get their enablement, then every agent's connectors activate
  const connectorsReady = providersReady.then(async () => {
    // legacy `v1:` blobs (and rows of a rotated-out key) are rewritten with the current key
    const resealed = await profileStore.reseal()
    if (resealed > 0)
      console.warn(`team: re-sealed ${resealed} stored secret row(s) with the current key`)
    await migrateLegacyAgents({
      sqlite: conn.sqlite,
      connections: connectors.stores.connections,
      changed: () => connectors.profileChanged('connection'),
    })
    await backfillCustomSlugs({
      connections: connectors.stores.connections,
      changed: () => connectors.profileChanged('connection'),
    })
    if (config.seed !== false) await seedBuiltinSkills(conn.sqlite)
    await factory.prepare()
  })
  connectorsReady.catch(() => undefined)
  // the repair pass opens sessions, which needs the provider profiles and connectors
  const ready =
    config.reconcile?.onBoot === false ? Promise.resolve() : connectorsReady.then(quiet, quiet)
  const everyMs = config.reconcile?.everyMs ?? 60_000
  const timer = everyMs > 0 ? setInterval(() => void quiet(), everyMs) : undefined
  timer?.unref()
  const dispatchEveryMs = config.reconcile?.everyMs === 0 ? 0 : 10_000
  const dispatchTimer = dispatchEveryMs > 0 ? setInterval(dispatch, dispatchEveryMs) : undefined
  dispatchTimer?.unref()
  // agent health: anomalies found in the data the server keeps, every 10 minutes
  const healthScan = (): Promise<HealthJobReport> =>
    runHealthJob(deps, { suggest: suggestAuthority })
  const healthEveryMs = config.reconcile?.everyMs === 0 ? 0 : (config.health?.everyMs ?? 600_000)
  const healthTimer =
    healthEveryMs > 0 ? setInterval(() => void healthScan(), healthEveryMs) : undefined
  healthTimer?.unref()

  // chat, sessions, attention answers and the activity feed: the library's HTTP module
  const harness = createTeamHttp({
    factory,
    agents,
    tasks,
    threads: threadStore,
    team,
    activity: activityStore,
    token: config.token,
    bootId: BOOT_ID,
    ...(config.eventsPollMs === undefined ? {} : { pollMs: config.eventsPollMs }),
    maxBodyBytes: MAX_REQUEST_BYTES,
    checkChatBody: (body) => checkChatBody(deps, body),
    // "always allow" saved as a rule of the agent, or of every agent
    rememberRule: (agent, toolName, scope) => {
      const targets = scope === 'agent' ? [agent] : agents.list()
      for (const target of targets) {
        if (target.archivedAt !== null || target.rules.allow.includes(toolName)) continue
        try {
          updateAgent(deps, target.id, {
            rules: { ...target.rules, allow: [...target.rules.allow, toolName] },
          })
        } catch (error) {
          console.warn(`team: saving the rule for ${target.slug} failed: ${errorText(error)}`)
        }
      }
    },
  })
  const allowedOrigins = [
    ...new Set(
      [webUrl, publicUrl, ...(process.env.TEAM_ALLOWED_ORIGINS ?? '').split(',')]
        .map((u) => originOf(u.trim()))
        .filter((o): o is string => o !== undefined),
    ),
  ]
  const app = createApp({
    deps,
    token: config.token,
    harness,
    content: artifactContent,
    allowedOrigins,
    login: config.loginPassword
      ? {
          password: config.loginPassword,
          // the session signing key mixes in the server secret (`TEAM_SECRET_KEY`, else the key id of the dev key)
          secret: `${(config.env ?? process.env).TEAM_SECRET_KEY ?? ''}|${vault.keyId ?? ''}`,
          publicUrl,
          trustProxy: (config.env ?? process.env).TEAM_TRUST_PROXY === '1',
        }
      : undefined,
  })
  routines.start()
  // phantom connector names of stored programs (a tool prefix instead of the id) are repaired once
  // (after the connectors are prepared: the repair itself never opens a connection)
  void connectorsReady.then(() => repairProgramAuthorities(deps)).catch(() => undefined)
  return {
    app,
    artifactContent,
    artifacts,
    deps,
    conn,
    factory,
    team,
    routines,
    programs: programRunner,
    rehearsals: rehearsalService,
    decisions: decisionService,
    heartbeats,
    channels,
    telegram,
    telegramUser,
    activityLog,
    metrics: observer.snapshot,
    providers,
    providersReady,
    connectors,
    connectorsReady,
    ready,
    reconcile,
    healthScan,
    async close() {
      if (timer !== undefined) clearInterval(timer)
      if (healthTimer !== undefined) clearInterval(healthTimer)
      if (dispatchTimer !== undefined) clearInterval(dispatchTimer)
      if (pruneTimer !== undefined) clearInterval(pruneTimer)
      if (channelPurgeTimer !== undefined) clearInterval(channelPurgeTimer)
      offBrowserEvents()
      heartbeats.close()
      // kills the engines this process started
      await browserService.close()
      await telegram?.stop()
      await telegramUser?.stop()
      await channels.stop()
      await routines?.stop()
      await ready
      await repairing?.catch(() => undefined)
      await factory.close()
      changes.close()
      providers.close()
      connectors.close()
      await connectorsReady.catch(() => undefined)
      await providersReady.catch(() => undefined)
      conn.close()
    },
  }
}

if (import.meta.main) {
  const token = process.env.TEAM_TOKEN
  const budget = Number(process.env.TEAM_BUDGET_USD)
  const spawnCap = Number(process.env.TEAM_SPAWN_CAP)
  const tickMs = Number(process.env.TEAM_ROUTINE_TICK_MS)
  const logRows = Number(process.env.TEAM_LOG_MAX_ROWS)
  const logDays = Number(process.env.TEAM_LOG_RETENTION_DAYS)
  const eventHours = Number(process.env.TEAM_EVENTS_RETENTION_HOURS)
  const eventRows = Number(process.env.TEAM_EVENTS_MAX_ROWS)
  const dbFile = process.env.TEAM_DB ?? './data/team.db'
  const retentionDays = (name: string): number | undefined => {
    const v = Number(process.env[name])
    return process.env[name] !== undefined && Number.isFinite(v) && v >= 0 ? v : undefined
  }
  const listenPort = Number(process.env.PORT ?? 4000)
  const server = compose({
    dbFile,
    seedAgents: process.env.TEAM_SEED_AGENTS === '1',
    instanceId: process.env.TEAM_INSTANCE_ID ?? `team-${listenPort}`,
    token,
    loginPassword: process.env.BASIC_AUTH_PASSWORD,
    ...(Number.isFinite(budget) && budget > 0 ? { budgetUsd: budget } : {}),
    ...(() => {
      const num = (name: string): number | undefined => {
        const raw = process.env[name]
        if (raw === undefined || raw.trim() === '') return undefined
        const n = Number(raw)
        return Number.isFinite(n) && n >= 0 ? n : undefined
      }
      const maxCostUsd = num('TEAM_LONG_RUN_MAX_COST_USD')
      const maxHours = num('TEAM_LONG_RUN_MAX_HOURS')
      const chunkSteps = num('TEAM_LONG_RUN_CHUNK_STEPS')
      const longRun = {
        ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
        ...(maxHours === undefined ? {} : { maxDurationMs: maxHours * 60 * 60 * 1000 }),
        ...(chunkSteps === undefined || chunkSteps < 10 ? {} : { chunkSteps }),
      }
      const contextCap = Number(process.env.TEAM_CONTEXT_CAP)
      const limits = {
        ...(Number.isFinite(contextCap) && contextCap >= 16_000 ? { contextCap } : {}),
        ...(Number.isFinite(spawnCap) && spawnCap > 0 ? { spawnCap } : {}),
        ...(Object.keys(longRun).length === 0 ? {} : { longRun }),
      }
      return Object.keys(limits).length === 0 ? {} : { limits }
    })(),
    logs: {
      ...(Number.isFinite(logRows) && logRows > 0 ? { maxRows: logRows } : {}),
      ...(Number.isFinite(logDays) && logDays > 0 ? { retentionDays: logDays } : {}),
    },
    events: {
      ...(process.env.TEAM_EVENTS_RETENTION_HOURS !== undefined &&
      Number.isFinite(eventHours) &&
      eventHours >= 0
        ? { retentionHours: eventHours }
        : {}),
      ...(Number.isFinite(eventRows) && eventRows > 0 ? { maxRows: eventRows } : {}),
    },
    ...(process.env.TEAM_DB_COMPACT === '1' ? { dbCompact: true } : {}),
    retention: {
      ...(retentionDays('TEAM_MEDIA_RETENTION_DAYS') === undefined
        ? {}
        : { mediaDays: retentionDays('TEAM_MEDIA_RETENTION_DAYS') as number }),
      ...(retentionDays('TEAM_ROUTINE_RUNS_RETENTION_DAYS') === undefined
        ? {}
        : { routineRunsDays: retentionDays('TEAM_ROUTINE_RUNS_RETENTION_DAYS') as number }),
      ...(retentionDays('TEAM_TASKS_RETENTION_DAYS') === undefined
        ? {}
        : { tasksDays: retentionDays('TEAM_TASKS_RETENTION_DAYS') as number }),
      ...(retentionDays('TEAM_LIBRARY_HISTORY_RETENTION_DAYS') === undefined
        ? {}
        : { libraryHistoryDays: retentionDays('TEAM_LIBRARY_HISTORY_RETENTION_DAYS') as number }),
    },
    ...(process.env.TEAM_ROUTINE_TICK_MS !== undefined && Number.isFinite(tickMs) && tickMs >= 0
      ? { routines: { tickMs } }
      : {}),
  })
  try {
    // profiles (decrypting them needs a valid TEAM_SECRET_KEY) and catalogs
    await server.providersReady
    await server.connectorsReady
  } catch (error) {
    console.error(`provider setup failed: ${errorText(error)}`)
    process.exit(1)
  }
  const port = Number(process.env.PORT ?? 4000)
  let listen: ListenConfig
  try {
    listen = listenConfig(process.env)
  } catch (error) {
    console.error(errorText(error))
    process.exit(1)
  }
  // a public share page (`/s/<token>`) carries link-preview tags for chat apps (P45)
  const web = process.env.TEAM_WEB_DIR
    ? webStatic(process.env.TEAM_WEB_DIR, {
        shareMeta: (shareToken) => {
          const found = server.artifacts.share(shareToken)?.artifact
          if (found === undefined) return undefined
          const description = found.description.trim() || `Shared ${found.kind} artifact`
          return { title: found.title, description: description.slice(0, 300), kind: found.kind }
        },
      })
    : undefined
  // idleTimeout 0: Bun closes a connection after 10 s without bytes by default, which cuts chat
  // streams while a long tool runs (the activity stream has its own 8 s keep-alive)
  const http = Bun.serve({
    port,
    hostname: listen.hostname,
    idleTimeout: 0,
    // the live browser view (`GET /browser/profiles/{id}/live`)
    websocket,
    fetch: (request, bunServer) => {
      // DNS rebinding guard: only loopback names and the configured public hosts are served
      if (!hostAllowed(request.headers.get('host') ?? undefined, listen.allowedHosts)) {
        return Response.json(
          {
            error: { code: 'FORBIDDEN_HOST', message: 'host not allowed (see TEAM_ALLOWED_HOSTS)' },
          },
          { status: 403 },
        )
      }
      if (!web) return server.app.fetch(request, bunServer)
      // artifact content (signed or share tokens) lives next to /api, not in the web build
      if (new URL(request.url).pathname.startsWith('/art/'))
        return server.artifactContent.fetch(request)
      const api = web.apiRequest(request)
      return api ? server.app.fetch(api, upgradeEnv(request, bunServer)) : web.serve(request)
    },
  })
  // TEAM_ARTIFACT_PORT: the content routes alone on their own port (a separate origin behind a proxy, or in dev)
  const artifactPort = Number(process.env.TEAM_ARTIFACT_PORT)
  const artifactHttp =
    Number.isInteger(artifactPort) && artifactPort > 0 && artifactPort !== http.port
      ? Bun.serve({
          port: artifactPort,
          hostname: listen.hostname,
          idleTimeout: 0,
          fetch: (request) =>
            new URL(request.url).pathname.startsWith('/art/')
              ? server.artifactContent.fetch(request)
              : new Response('not found', { status: 404 }),
        })
      : undefined
  if (artifactHttp !== undefined) {
    console.log(
      `artifact content on http://${listen.hostname}:${artifactHttp.port} (set TEAM_ARTIFACT_URL to its public URL)`,
    )
  }
  console.log(
    `team server on http://${listen.hostname}:${http.port} (${web ? 'web at /, API and docs under /api' : 'docs at /docs'}, ${[token ? 'token auth' : '', process.env.BASIC_AUTH_PASSWORD ? 'password login' : ''].filter(Boolean).join(' + ') || 'no TEAM_TOKEN: open, loopback only'})`,
  )
  let shuttingDown = false
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    // hard timeout: never hang on a stuck stream or a store that does not close
    const hard = setTimeout(() => {
      console.error('shutdown timed out, forcing exit')
      process.exit(1)
    }, 10_000)
    hard.unref()
    try {
      // stop accepting, give in-flight requests a short drain, then close the streams
      const stopped = http.stop()
      await Promise.race([stopped, new Promise((r) => setTimeout(r, 1500))])
      await http.stop(true)
      await artifactHttp?.stop(true)
      await server.close()
    } catch (error) {
      console.error(`shutdown failed: ${errorText(error)}`)
      process.exit(1)
    }
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
  process.on('unhandledRejection', (reason) => {
    console.error('unhandledRejection:', reason)
  })
  process.on('uncaughtException', (error) => {
    console.error('uncaughtException:', error)
    void shutdown()
  })
}
