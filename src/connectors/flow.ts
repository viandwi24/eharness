/**
 * The setup flow engine: server-driven UI as data. A flow is a list of steps; the engine keeps
 * a {@link FlowState} (the current view, a revision and a sealed scratch space) and advances it
 * with `startFlow` / `advanceFlow` / `completeOAuth`. Nothing here renders anything: a UI draws
 * the closed view vocabulary (`form`, `oauth`, `deviceCode`, `choose`, `confirm`, `status`,
 * `error`) and answers with the `viewId` of the view it drew.
 *
 * @see docs/specs/24-connectors.md#2-setup-flows
 */
import { uuidv7 } from '../index.ts'
import {
  formSpec,
  mergeSecretPatch,
  redactSettings,
  scrub,
  secretValuesOf,
} from '../providers/index.ts'
import { connectorSchema } from './definition.ts'
import {
  buildAuthorizationUrl,
  discoverMcpAuthorization,
  exchangeCode,
  generatePkce,
  generateState,
  pollDeviceToken,
  registerClient,
  requestDeviceCode,
} from './oauth.ts'
import type {
  AdvanceResult,
  AnyConnectorDefinition,
  ChooseSpec,
  ConnectionCredentials,
  ConnectionRecord,
  ConnectorCallContext,
  FlowAction,
  FlowCompletion,
  FlowDeps,
  FlowInput,
  FlowState,
  FlowStepContext,
  FlowStepDef,
  FlowStore,
  FlowView,
  FlowViewBody,
  OAuth2Auth,
  OAuthClient,
  OAuthEndpoints,
  ResolvedFlowDeps,
  StepOutcome,
} from './types.ts'
import { base64url, connectorError, isRecord, randomBytes, sha256Hex } from './util.ts'

/** Default lifetime of a flow. */
export const DEFAULT_FLOW_TTL_MS: number = 15 * 60_000
const OAUTH_WAIT_MS = 10 * 60_000
const POLL_MS = 2000

/** Apply defaults to {@link FlowDeps}. */
export function resolveFlowDeps(deps: FlowDeps): ResolvedFlowDeps {
  const list = deps.definitions
  return {
    definition: (id) => (typeof list === 'function' ? list(id) : list.find((d) => d.id === id)),
    vault: deps.vault,
    fetch: deps.fetch ?? globalThis.fetch,
    now: deps.now ?? Date.now,
    newId: deps.newId ?? uuidv7,
    redirectUri: (definitionId) =>
      typeof deps.redirectUri === 'function' ? deps.redirectUri(definitionId) : deps.redirectUri,
    clientConfig: async (definitionId, flow) => deps.clientConfig?.(definitionId, flow),
    ttlMs: deps.ttlMs ?? DEFAULT_FLOW_TTL_MS,
  }
}

type Scratch = Record<string, unknown>

const settingsOf = (scratch: Scratch): Record<string, unknown> =>
  isRecord(scratch.settings) ? scratch.settings : {}
const choicesOf = (scratch: Scratch): Record<string, unknown> =>
  isRecord(scratch.choices) ? scratch.choices : {}
const credentialsOf = (scratch: Scratch): ConnectionCredentials | undefined =>
  isRecord(scratch.credentials) ? (scratch.credentials as ConnectionCredentials) : undefined

function callContext(ctx: FlowStepContext): ConnectorCallContext {
  return {
    settings: settingsOf(ctx.scratch),
    choices: choicesOf(ctx.scratch),
    accessToken: credentialsOf(ctx.scratch)?.tokens?.accessToken,
    fetch: ctx.deps.fetch,
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unexpected error.'

// -- default steps ------------------------------------------------------------------------

function settingsStep(): FlowStepDef {
  return {
    id: 'settings',
    skip: (ctx) =>
      formSpec(ctx.schema).fields.length === 0 ||
      (ctx.reconnect && ctx.schema.safeParse(settingsOf(ctx.scratch)).success),
    view: (ctx) => ({
      type: 'form',
      title: `Connect ${ctx.definition.name}`,
      description: ctx.definition.description,
      fields: formSpec(ctx.schema).fields,
      values: redactSettings(ctx.schema, settingsOf(ctx.scratch)),
      ...(ctx.notice?.errors === undefined ? {} : { errors: ctx.notice.errors }),
      ...(ctx.notice?.message === undefined ? {} : { message: ctx.notice.message }),
      submitLabel: 'Continue',
    }),
    advance: (ctx, { action, data }) => {
      if (action !== 'submit') return { pending: true }
      const merged = mergeSecretPatch(ctx.schema, settingsOf(ctx.scratch), data)
      const parsed = ctx.schema.safeParse(merged)
      if (!parsed.success) {
        const errors: Record<string, string> = {}
        for (const issue of parsed.error.issues) errors[issue.path.join('.')] ??= issue.message
        ctx.scratch.settings = merged
        return { stay: true, errors }
      }
      ctx.scratch.settings = parsed.data
      return { next: true }
    },
  }
}

const oauthAuth = (def: AnyConnectorDefinition): OAuth2Auth | undefined =>
  def.auth.type === 'oauth2' ? def.auth : undefined

async function oauthClient(
  ctx: FlowStepContext,
  auth: { client?: OAuth2Auth['client'] },
  register?: { url: string; redirectUri: string; scopes: string[] },
): Promise<OAuthClient> {
  const config = await ctx.deps.clientConfig(ctx.definition.id, {
    flowId: ctx.flowId,
    scope: ctx.scope,
    scopeId: ctx.scopeId,
    reconnect: ctx.reconnect,
    settings: settingsOf(ctx.scratch),
  })
  if (config !== undefined) {
    const parsed =
      auth.client === undefined ? { success: true, data: config } : auth.client.safeParse(config)
    const value = parsed.success ? (parsed.data as Record<string, unknown>) : undefined
    if (value === undefined || typeof value.clientId !== 'string' || value.clientId === '') {
      throw connectorError(
        'client-config-invalid',
        `The OAuth client configuration of '${ctx.definition.id}' is invalid.`,
      )
    }
    return {
      clientId: value.clientId,
      ...(typeof value.clientSecret === 'string' && value.clientSecret !== ''
        ? { clientSecret: value.clientSecret }
        : {}),
    }
  }
  if (register !== undefined) {
    return registerClient({
      registrationEndpoint: register.url,
      clientName: ctx.definition.name,
      redirectUris: [register.redirectUri],
      scopes: register.scopes,
      fetch: ctx.deps.fetch,
      now: ctx.now,
    })
  }
  throw connectorError(
    'client-missing',
    `No OAuth client is configured for '${ctx.definition.id}'.`,
  )
}

function authorizeStep(): FlowStepDef {
  return {
    id: 'authorize',
    skip: (ctx) => {
      const auth = oauthAuth(ctx.definition)
      return auth === undefined || (auth.when?.(settingsOf(ctx.scratch)) ?? true) === false
    },
    enter: async (ctx) => {
      const auth = oauthAuth(ctx.definition) as OAuth2Auth
      const settings = settingsOf(ctx.scratch)
      const redirectUri = ctx.deps.redirectUri(ctx.definition.id)
      if (redirectUri === undefined) {
        throw connectorError('redirect-missing', 'No OAuth redirect URI is configured.')
      }
      const resource = typeof auth.resource === 'function' ? auth.resource(settings) : auth.resource
      let endpoints: OAuthEndpoints
      let scopes = auth.scopes
      if (auth.discovery === 'mcp') {
        const url = auth.serverUrl?.(settings) ?? settings.url
        if (typeof url !== 'string') {
          throw connectorError('settings-invalid', 'The server URL is missing.')
        }
        const found = await discoverMcpAuthorization(url, { fetch: ctx.deps.fetch, now: ctx.now })
        endpoints = {
          authorizationUrl: found.server.authorization_endpoint,
          tokenUrl: found.server.token_endpoint,
          issuer: found.server.issuer,
          ...(found.server.registration_endpoint === undefined
            ? {}
            : { registrationUrl: found.server.registration_endpoint }),
          resource: resource ?? found.resource,
        }
        if (scopes.length === 0 && found.scopes !== undefined) scopes = found.scopes
      } else {
        if (auth.authorizationUrl === undefined || auth.tokenUrl === undefined) {
          throw connectorError(
            'definition-invalid',
            `'${ctx.definition.id}' has no OAuth endpoints.`,
          )
        }
        endpoints = {
          authorizationUrl: auth.authorizationUrl,
          tokenUrl: auth.tokenUrl,
          ...(resource === undefined ? {} : { resource }),
        }
      }
      endpoints.scopes = scopes
      if (auth.clientAuth !== undefined) endpoints.clientAuth = auth.clientAuth
      const client = await oauthClient(
        ctx,
        auth,
        auth.dcr !== 'never' && endpoints.registrationUrl !== undefined
          ? { url: endpoints.registrationUrl, redirectUri, scopes }
          : undefined,
      )
      const pkce = await generatePkce()
      const state = generateState()
      ctx.scratch.stateHash = await sha256Hex(state)
      ctx.scratch.oauth = {
        authorizeUrl: buildAuthorizationUrl({
          authorizationUrl: endpoints.authorizationUrl as string,
          clientId: client.clientId,
          redirectUri,
          scopes,
          state,
          codeChallenge: pkce.challenge,
          ...(endpoints.resource === undefined ? {} : { resource: endpoints.resource }),
        }),
        verifier: pkce.verifier,
        redirectUri,
        endpoints,
        client,
        expiresAt: ctx.now() + OAUTH_WAIT_MS,
      }
      return undefined
    },
    view: (ctx) => {
      const oauth = ctx.scratch.oauth as { authorizeUrl: string; expiresAt: number }
      return {
        type: 'oauth',
        title: `Authorize ${ctx.label ?? ctx.definition.name}`,
        authorizeUrl: oauth.authorizeUrl,
        pollIntervalMs: POLL_MS,
        expiresAt: oauth.expiresAt,
      }
    },
    advance: async (ctx, { action, data }) => {
      const oauth = ctx.scratch.oauth as
        | {
            verifier: string
            redirectUri: string
            endpoints: OAuthEndpoints
            client: OAuthClient
            expiresAt: number
          }
        | undefined
      if (oauth === undefined)
        return { error: 'The authorization request is gone.', retryable: true }
      if (action === 'callback') {
        delete ctx.scratch.stateHash // the state is single-use
        if (typeof data.error === 'string') {
          const detail =
            typeof data.errorDescription === 'string'
              ? `: ${data.errorDescription.slice(0, 200)}`
              : ''
          return {
            error: `Authorization failed (${data.error.slice(0, 60)})${detail}`,
            retryable: true,
          }
        }
        if (typeof data.code !== 'string' || data.code === '') {
          return { error: 'The authorization response has no code.', retryable: true }
        }
        const tokens = await exchangeCode({
          tokenUrl: oauth.endpoints.tokenUrl,
          clientId: oauth.client.clientId,
          ...(oauth.client.clientSecret === undefined
            ? {}
            : { clientSecret: oauth.client.clientSecret }),
          ...(oauth.endpoints.clientAuth === undefined
            ? {}
            : { method: oauth.endpoints.clientAuth }),
          code: data.code,
          redirectUri: oauth.redirectUri,
          codeVerifier: oauth.verifier,
          ...(oauth.endpoints.resource === undefined ? {} : { resource: oauth.endpoints.resource }),
          fetch: ctx.deps.fetch,
          now: ctx.now,
        })
        ctx.scratch.credentials = { tokens, client: oauth.client, endpoints: oauth.endpoints }
        delete ctx.scratch.oauth
        return { next: true }
      }
      if (action === 'poll' && ctx.now() > oauth.expiresAt) {
        delete ctx.scratch.stateHash
        return { error: 'The authorization request expired.', retryable: true }
      }
      return { pending: true }
    },
  }
}

function deviceStep(): FlowStepDef {
  const authOf = (def: AnyConnectorDefinition) =>
    def.auth.type === 'deviceCode' ? def.auth : undefined
  return {
    id: 'device',
    skip: (ctx) => {
      const auth = authOf(ctx.definition)
      return auth === undefined || (auth.when?.(settingsOf(ctx.scratch)) ?? true) === false
    },
    enter: async (ctx) => {
      const auth = authOf(ctx.definition)
      if (auth === undefined) return { next: true }
      const client = await oauthClient(ctx, auth)
      const started = await requestDeviceCode({
        deviceAuthorizationUrl: auth.deviceAuthorizationUrl,
        clientId: client.clientId,
        scopes: auth.scopes,
        fetch: ctx.deps.fetch,
        now: ctx.now,
      })
      ctx.scratch.device = {
        ...started,
        nextPollAt: ctx.now() + started.intervalMs,
        client,
        endpoints: { tokenUrl: auth.tokenUrl, scopes: auth.scopes } satisfies OAuthEndpoints,
      }
      return undefined
    },
    view: (ctx) => {
      const d = ctx.scratch.device as {
        userCode: string
        verificationUrl: string
        verificationUrlComplete?: string
        expiresAt: number
        intervalMs: number
      }
      return {
        type: 'deviceCode',
        title: `Authorize ${ctx.label ?? ctx.definition.name}`,
        userCode: d.userCode,
        verificationUrl: d.verificationUrl,
        ...(d.verificationUrlComplete === undefined
          ? {}
          : { verificationUrlComplete: d.verificationUrlComplete }),
        expiresAt: d.expiresAt,
        pollIntervalMs: d.intervalMs,
      }
    },
    advance: async (ctx, { action }) => {
      const d = ctx.scratch.device as
        | {
            deviceCode: string
            expiresAt: number
            intervalMs: number
            nextPollAt: number
            client: OAuthClient
            endpoints: OAuthEndpoints
          }
        | undefined
      if (d === undefined) return { error: 'The device authorization is gone.', retryable: true }
      if (action !== 'poll') return { pending: true }
      if (ctx.now() > d.expiresAt) return { error: 'The device code expired.', retryable: true }
      if (ctx.now() < d.nextPollAt) return { pending: true }
      const result = await pollDeviceToken({
        tokenUrl: d.endpoints.tokenUrl,
        clientId: d.client.clientId,
        ...(d.client.clientSecret === undefined ? {} : { clientSecret: d.client.clientSecret }),
        deviceCode: d.deviceCode,
        intervalMs: d.intervalMs,
        fetch: ctx.deps.fetch,
        now: ctx.now,
      })
      if (result.status === 'pending') {
        d.intervalMs = result.intervalMs
        d.nextPollAt = ctx.now() + result.intervalMs
        return { pending: true }
      }
      if (result.status === 'authorized') {
        ctx.scratch.credentials = {
          tokens: result.tokens,
          client: d.client,
          endpoints: d.endpoints,
        }
        delete ctx.scratch.device
        return { next: true }
      }
      return {
        error: result.status === 'denied' ? 'The request was denied.' : 'The device code expired.',
        retryable: true,
      }
    },
  }
}

function chooseStep(): FlowStepDef {
  return {
    id: 'choose',
    skip: (ctx) => ctx.definition.choose === undefined,
    enter: async (ctx) => {
      const spec = await ctx.definition.choose?.(callContext(ctx))
      if (spec === undefined || spec.options.length === 0) return { next: true }
      ctx.scratch.choose = spec
      return undefined
    },
    view: (ctx) => {
      const spec = ctx.scratch.choose as ChooseSpec
      const current = choicesOf(ctx.scratch)[spec.key]
      const selected = Array.isArray(current)
        ? current.map(String)
        : typeof current === 'string'
          ? [current]
          : []
      return {
        type: 'choose',
        title: spec.title,
        ...(spec.description === undefined ? {} : { description: spec.description }),
        options: spec.options,
        multiple: spec.multiple === true,
        selected,
        min: spec.min ?? 1,
        ...(ctx.notice?.errors === undefined ? {} : { errors: ctx.notice.errors }),
        ...(ctx.notice?.message === undefined ? {} : { message: ctx.notice.message }),
      }
    },
    advance: (ctx, { action, data }) => {
      if (action !== 'submit') return { pending: true }
      const spec = ctx.scratch.choose as ChooseSpec
      const raw = data.selected
      const selected = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(String)
      const known = new Set(spec.options.map((o) => o.value))
      const min = spec.min ?? 1
      if (!selected.every((v) => known.has(v))) {
        return { stay: true, errors: { selected: 'Choose from the listed options.' } }
      }
      if (selected.length < min || (spec.multiple !== true && selected.length > 1)) {
        return {
          stay: true,
          errors: {
            selected: spec.multiple === true ? `Choose at least ${min}.` : 'Choose one option.',
          },
        }
      }
      const choices = choicesOf(ctx.scratch)
      choices[spec.key] = spec.multiple === true ? selected : selected[0]
      ctx.scratch.choices = choices
      delete ctx.scratch.choose
      return { next: true }
    },
  }
}

function testStep(): FlowStepDef {
  return {
    id: 'test',
    auto: true,
    skip: (ctx) => ctx.definition.test === undefined,
    view: () => ({ type: 'status', state: 'running', message: 'Testing the connection…' }),
    advance: async (ctx) => {
      const result = await ctx.definition.test?.(callContext(ctx))
      if (result === undefined) return { next: true }
      if (!result.ok)
        return { error: result.message ?? 'The connection test failed.', retryable: true }
      ctx.scratch.test = {
        ...(result.accountLabel === undefined ? {} : { accountLabel: result.accountLabel }),
        ...(result.capabilities === undefined ? {} : { capabilities: result.capabilities }),
      }
      return { next: true }
    },
  }
}

/**
 * The default steps of a definition: `settings` (a form of the auth fields and settings), `authorize`
 * (OAuth) or `device` (device code), `choose`, `test`. A step whose condition does not hold is
 * skipped, so a connector without settings or auth finishes at once.
 */
export function defaultFlowSteps(_definition?: AnyConnectorDefinition): FlowStepDef[] {
  return [settingsStep(), authorizeStep(), deviceStep(), chooseStep(), testStep()]
}

/** The steps a definition runs: its own `flow`, or the defaults. */
export function flowStepsOf(definition: AnyConnectorDefinition): FlowStepDef[] {
  const defaults = defaultFlowSteps(definition)
  if (definition.flow === undefined) return defaults
  const steps = typeof definition.flow === 'function' ? definition.flow(defaults) : definition.flow
  const ids = new Set<string>()
  for (const step of steps) {
    if (step.id === 'done' || ids.has(step.id)) {
      throw connectorError(
        'flow-invalid',
        `Flow of '${definition.id}': step ids must be unique and not 'done'.`,
      )
    }
    ids.add(step.id)
  }
  return steps
}

// -- the machine --------------------------------------------------------------------------

interface Machine {
  state: FlowState
  scratch: Scratch
  steps: FlowStepDef[]
  definition: AnyConnectorDefinition
  deps: ResolvedFlowDeps
  schema: ReturnType<typeof connectorSchema>
}

function stepContext(m: Machine, notice?: FlowStepContext['notice']): FlowStepContext {
  return {
    definition: m.definition,
    flowId: m.state.id,
    scope: m.state.scope,
    scopeId: m.state.scopeId,
    deps: m.deps,
    schema: m.schema,
    scratch: m.scratch,
    notice,
    reconnect: m.scratch.reconnect === true,
    label: m.state.label || undefined,
    now: m.deps.now,
  }
}

function secretsOf(m: Machine): string[] {
  const out = secretValuesOf(m.schema, settingsOf(m.scratch))
  const creds = credentialsOf(m.scratch)
  for (const value of [
    creds?.tokens?.accessToken,
    creds?.tokens?.refreshToken,
    creds?.client?.clientSecret,
  ]) {
    if (value !== undefined) out.push(value)
  }
  const oauth = m.scratch.oauth
  if (isRecord(oauth)) {
    if (typeof oauth.verifier === 'string') out.push(oauth.verifier)
    const client = oauth.client
    if (isRecord(client) && typeof client.clientSecret === 'string') out.push(client.clientSecret)
  }
  return out
}

const safeMessage = (m: Machine, error: unknown): string => scrub(errorText(error), secretsOf(m))

async function viewId(m: Machine, step: string): Promise<string> {
  return (await sha256Hex(`${String(m.scratch.salt)}:${step}:${m.state.rev}`)).slice(0, 24)
}

async function show(m: Machine, step: string, body: FlowViewBody, bump: boolean): Promise<void> {
  if (bump) m.state.rev++
  m.state.step = step
  m.state.view = { ...body, viewId: await viewId(m, step), step } as FlowView
}

async function render(
  m: Machine,
  step: FlowStepDef,
  notice: FlowStepContext['notice'],
  bump: boolean,
): Promise<void> {
  await show(m, step.id, await step.view(stepContext(m, notice)), bump)
}

async function guard<T>(m: Machine, run: () => Promise<T>): Promise<T | StepOutcome> {
  try {
    return await run()
  } catch (error) {
    return { error: safeMessage(m, error), retryable: true }
  }
}

const isOutcome = (value: unknown): value is StepOutcome =>
  isRecord(value) &&
  ('next' in value || 'goto' in value || 'stay' in value || 'pending' in value || 'error' in value)

async function settle(
  m: Machine,
  start: FlowStepDef | undefined,
  first: StepOutcome,
): Promise<void> {
  let current = start
  let outcome = first
  for (let turn = 0; turn < 32; turn++) {
    if ('pending' in outcome) {
      if (current !== undefined) await render(m, current, undefined, false)
      return
    }
    if ('error' in outcome) {
      const at = current?.id ?? m.state.step
      m.scratch.failed = at
      await show(
        m,
        at,
        {
          type: 'error',
          message: scrub(outcome.error, secretsOf(m)),
          retryable: outcome.retryable === true,
        },
        true,
      )
      return
    }
    if ('stay' in outcome && current !== undefined) {
      await render(
        m,
        current,
        {
          ...(outcome.errors === undefined ? {} : { errors: outcome.errors }),
          ...(outcome.message === undefined ? {} : { message: outcome.message }),
        },
        true,
      )
      return
    }
    // next / goto
    const gotoId = 'goto' in outcome ? outcome.goto : undefined
    let index =
      gotoId !== undefined
        ? gotoId === 'done'
          ? m.steps.length
          : m.steps.findIndex((s) => s.id === gotoId)
        : (current === undefined ? -1 : m.steps.findIndex((s) => s.id === current?.id)) + 1
    if (index < 0) throw connectorError('flow-invalid', 'The flow went to an unknown step.')
    const jump = 'goto' in outcome
    let target: FlowStepDef | undefined = m.steps[index]
    while (target !== undefined && !jump && (await target.skip?.(stepContext(m))) === true) {
      index++
      target = m.steps[index]
    }
    if (target === undefined) {
      m.state.status = 'done'
      delete m.scratch.failed
      const account = (m.scratch.test as { accountLabel?: string } | undefined)?.accountLabel
      await show(
        m,
        'done',
        {
          type: 'status',
          state: 'success',
          message: `${m.state.label || m.definition.name} is connected.`,
          ...(account === undefined ? {} : { account }),
        },
        true,
      )
      return
    }
    current = target
    delete m.scratch.failed
    m.state.step = target.id
    const entered = await guard(m, async () => target?.enter?.(stepContext(m)))
    if (isOutcome(entered)) {
      outcome = entered
      continue
    }
    if (target.auto === true) {
      const t = target
      const next = await guard(m, async () =>
        t.advance(stepContext(m), { action: 'auto', data: {} }),
      )
      outcome = isOutcome(next) ? next : { next: true }
      continue
    }
    await render(m, target, undefined, true)
    return
  }
  throw connectorError('flow-invalid', 'The flow did not settle.')
}

async function sealScratch(m: Machine): Promise<void> {
  const hash = m.scratch.stateHash
  if (typeof hash === 'string' && m.state.status === 'active') m.state.stateHash = hash
  else delete m.state.stateHash
  m.state.sealed = await m.deps.vault.seal(JSON.stringify(m.scratch), `flow:${m.state.id}`)
  m.state.updatedAt = m.deps.now()
}

async function openMachine(state: FlowState, deps: ResolvedFlowDeps): Promise<Machine> {
  const definition = deps.definition(state.definitionId)
  if (definition === undefined) {
    throw connectorError('unknown-definition', `Unknown connector '${state.definitionId}'.`)
  }
  const scratch = JSON.parse(await deps.vault.open(state.sealed, `flow:${state.id}`)) as Scratch
  return {
    state: structuredClone(state),
    scratch,
    steps: flowStepsOf(definition),
    definition,
    deps,
    schema: connectorSchema(definition),
  }
}

/** Parameters of {@link startFlow}. */
export interface StartFlowParams {
  definition: AnyConnectorDefinition
  scope: 'workspace' | 'agent' | 'user'
  /** Required for `agent` and `user` scope. */
  scopeId?: string
  /** Connection label. Default: the connector's default label. */
  label?: string
  /** Reconnect this connection (its settings are reused; the settings form is skipped when valid). */
  connection?: ConnectionRecord
  /** Passed through to {@link FlowCompletion.defaultEnabled}. */
  defaultEnabled?: boolean
}

/**
 * Start a setup flow. Returns the first state: the first view, or a finished flow when no step
 * applies (a connector without settings, auth or test).
 */
export async function startFlow(params: StartFlowParams, depsInput: FlowDeps): Promise<FlowState> {
  const deps = resolveFlowDeps(depsInput)
  const { definition, scope } = params
  if (!definition.scopes.includes(scope)) {
    throw connectorError(
      'scope-invalid',
      `'${definition.id}' cannot be connected at ${scope} scope.`,
    )
  }
  if (scope !== 'workspace' && (params.scopeId === undefined || params.scopeId === '')) {
    throw connectorError('scope-invalid', `A ${scope}-scoped connection needs a scopeId.`)
  }
  const now = deps.now()
  const id = deps.newId()
  const existing = params.connection
  const scratch: Scratch = {
    salt: base64url(randomBytes(12)),
    settings: existing === undefined ? {} : structuredClone(existing.settings),
    choices: existing?.choices === undefined ? {} : structuredClone(existing.choices),
    ...(existing === undefined ? {} : { reconnect: true }),
    ...(params.defaultEnabled === undefined ? {} : { defaultEnabled: params.defaultEnabled }),
  }
  const state: FlowState = {
    id,
    definitionId: definition.id,
    scope,
    ...(params.scopeId === undefined ? {} : { scopeId: params.scopeId }),
    label:
      params.label ??
      existing?.label ??
      definition.scopeDefaults?.[scope]?.label ??
      definition.name,
    ...(existing === undefined ? {} : { connectionId: existing.id }),
    status: 'active',
    step: 'start',
    rev: 0,
    view: { type: 'status', state: 'running', message: 'Starting…', viewId: '', step: 'start' },
    createdAt: now,
    updatedAt: now,
    expiresAt: now + deps.ttlMs,
    sealed: '',
  }
  const m: Machine = {
    state,
    scratch,
    steps: flowStepsOf(definition),
    definition,
    deps,
    schema: connectorSchema(definition),
  }
  await settle(m, undefined, { next: true })
  await sealScratch(m)
  return m.state
}

const ALLOWED: Record<FlowView['type'], readonly (FlowAction | 'callback')[]> = {
  form: ['submit', 'back', 'cancel'],
  oauth: ['poll', 'cancel', 'callback'],
  deviceCode: ['poll', 'cancel'],
  choose: ['submit', 'back', 'cancel'],
  confirm: ['submit', 'back', 'cancel'],
  status: ['cancel'],
  error: ['retry', 'back', 'cancel'],
}

function failure(
  state: FlowState,
  error: Extract<AdvanceResult, { ok: false }>['error'],
  message: string,
): AdvanceResult {
  return { ok: false, error, message, state }
}

async function advance(
  state: FlowState,
  action: FlowAction | 'callback',
  data: Record<string, unknown>,
  quotedViewId: string | undefined,
  depsInput: FlowDeps,
): Promise<AdvanceResult> {
  const deps = resolveFlowDeps(depsInput)
  if (state.status !== 'active') return failure(state, 'finished', 'The flow is finished.')
  if (deps.now() > state.expiresAt)
    return failure(state, 'expired', 'The flow expired; start again.')
  if (quotedViewId !== undefined && quotedViewId !== state.view.viewId) {
    return failure(state, 'stale-view', 'The view is out of date; render the current one.')
  }
  const view = state.view
  if (
    !ALLOWED[view.type].includes(action) ||
    (view.type === 'error' && action === 'retry' && !view.retryable)
  ) {
    return failure(state, 'invalid-action', `The action '${action}' does not apply to this view.`)
  }
  const m = await openMachine(state, deps)
  const index = m.steps.findIndex(
    (s) =>
      s.id ===
      (action === 'retry' || action === 'back' ? (m.scratch.failed ?? state.step) : state.step),
  )
  const step = m.steps[index]

  if (action === 'cancel') {
    m.state.status = 'cancelled'
    m.state.rev++
    await sealScratch(m)
    return { ok: true, state: m.state }
  }
  if (step === undefined) return failure(state, 'invalid-action', 'The flow is not at a step.')
  if (action === 'retry') {
    await settle(m, undefined, { goto: step.id })
  } else if (action === 'back') {
    let target: FlowStepDef | undefined
    for (let i = index - (view.type === 'error' ? 0 : 1); i >= 0; i--) {
      const candidate = m.steps[i] as FlowStepDef
      if (candidate.auto !== true && (await candidate.skip?.(stepContext(m))) !== true) {
        target = candidate
        break
      }
    }
    if (target === undefined || (target.id === step.id && view.type !== 'error')) {
      return failure(state, 'invalid-action', 'There is no earlier step.')
    }
    await settle(m, undefined, { goto: target.id })
  } else {
    const outcome = await guard(m, async () => step.advance(stepContext(m), { action, data }))
    await settle(m, step, isOutcome(outcome) ? outcome : { next: true })
  }
  await sealScratch(m)
  return { ok: true, state: m.state }
}

/**
 * Apply an action to a flow. Pure with respect to storage: it returns the next state (persist
 * it) or a failure that carries the current state:
 * - `stale-view`: the `viewId` is not the current view's; re-render `state.view`;
 * - `expired` / `finished`: the flow is over;
 * - `invalid-action`: the action does not apply to the view.
 * Validation problems are not failures: they come back as a state whose `form` view has `errors`.
 *
 * @example
 * ```ts
 * const result = await advanceFlow(state, { viewId: state.view.viewId, action: 'submit', data: { apiKey } }, deps)
 * ```
 */
export function advanceFlow(
  state: FlowState,
  input: FlowInput,
  deps: FlowDeps,
): Promise<AdvanceResult> {
  return advance(state, input.action, input.data ?? {}, input.viewId, deps)
}

/** The OAuth redirect parameters of the app's callback route. */
export interface OAuthCallback {
  state: string
  code?: string
  error?: string
  errorDescription?: string
}

/** Result of {@link completeOAuth}. */
export type CompleteOAuthResult =
  | AdvanceResult
  | { ok: false; error: 'unknown-state'; message: string }

/**
 * Deliver the OAuth redirect to the flow waiting for it (found by `state`; a state works once),
 * exchange the code and move the flow on. Persists the new state in `store`. Call it from the
 * app's callback route; then show the person the flow's current view (or a "you can close this
 * tab" page, since the original tab polls).
 */
export async function completeOAuth(
  callback: OAuthCallback,
  store: FlowStore,
  depsInput: FlowDeps,
): Promise<CompleteOAuthResult> {
  const found = await store.findByStateHash(await sha256Hex(callback.state))
  if (found === undefined) {
    return {
      ok: false,
      error: 'unknown-state',
      message: 'The authorization request is unknown or expired.',
    }
  }
  const result = await advance(
    found,
    'callback',
    {
      ...(callback.code === undefined ? {} : { code: callback.code }),
      ...(callback.error === undefined ? {} : { error: callback.error }),
      ...(callback.errorDescription === undefined
        ? {}
        : { errorDescription: callback.errorDescription }),
    },
    undefined,
    depsInput,
  )
  if (result.ok) await store.put(result.state)
  return result
}

/**
 * What a finished flow produced (secrets included: save it as a connection and credentials; never
 * send it to a browser). Throws when the flow is not `done`.
 */
export async function flowCompletion(
  state: FlowState,
  depsInput: FlowDeps,
): Promise<FlowCompletion> {
  if (state.status !== 'done') throw connectorError('flow-not-done', 'The flow is not finished.')
  const deps = resolveFlowDeps(depsInput)
  const m = await openMachine(state, deps)
  const test = m.scratch.test as
    | { accountLabel?: string; capabilities?: FlowCompletion['capabilities'] }
    | undefined
  const credentials = credentialsOf(m.scratch)
  return {
    definitionId: state.definitionId,
    scope: state.scope,
    ...(state.scopeId === undefined ? {} : { scopeId: state.scopeId }),
    label: state.label,
    ...(state.connectionId === undefined ? {} : { connectionId: state.connectionId }),
    settings: settingsOf(m.scratch),
    choices: choicesOf(m.scratch),
    ...(test?.accountLabel === undefined ? {} : { accountLabel: test.accountLabel }),
    ...(test?.capabilities === undefined ? {} : { capabilities: test.capabilities }),
    ...(credentials === undefined ? {} : { credentials }),
    ...(typeof m.scratch.defaultEnabled === 'boolean'
      ? { defaultEnabled: m.scratch.defaultEnabled }
      : {}),
  }
}

/** A flow without its sealed scratch: what to send to a browser. */
export function publicFlow(state: FlowState): Omit<FlowState, 'sealed' | 'stateHash'> {
  const { sealed: _sealed, stateHash: _hash, ...rest } = state
  return structuredClone(rest)
}
