/**
 * Trigger use cases (docs/events-and-triggers.md): who may change them, what a change must satisfy,
 * and the dry run. Only the owner (the web app) or an owner or admin of the team in a chat may
 * create, edit, switch or delete a trigger; everybody else is refused with a sentence.
 */
import { conflict, DomainError, invalid, notFound } from '../domain/errors.ts'
import type { StreamEvent } from '../domain/event-stream.ts'
import { freshMs, HIGH_VOLUME_TYPES } from '../domain/event-stream.ts'
import {
  checkTriggerInput,
  describeAction,
  describeEvent,
  GATE_TEXT,
  gateOf,
  MAX_TRIGGERS,
  type MatchContext,
  matchTrigger,
  type SkipReason,
  type Trigger,
  type TriggerFire,
  type TriggerInput,
  wakeText,
  webhookPayload,
} from '../domain/triggers.ts'
import type { Deps } from './ports.ts'

/** Who is asking: the signed-in owner of the web app, or a person in a chat with a directory role. */
export type TriggerActor = { kind: 'web' } | { kind: 'chat'; role: string; name: string }

export type { Trigger }

export const WEB_OWNER_LABEL = 'web owner'

export const triggerActorLabel = (a: TriggerActor): string =>
  a.kind === 'web' ? WEB_OWNER_LABEL : `${a.name} (${a.role})`

/** Owner (web) and the team's owners and admins; a member or a guest is refused. */
export const mayManageTriggers = (a: TriggerActor): boolean =>
  a.kind === 'web' || a.role === 'owner' || a.role === 'admin'

function allow(a: TriggerActor): void {
  if (!mayManageTriggers(a))
    throw new DomainError(
      'forbidden',
      'TRIGGER_FORBIDDEN',
      'Only the owner or an admin of the team can create or change triggers. Ask one of them.',
    )
}

export function listTriggers(deps: Deps): Trigger[] {
  return deps.triggers.list()
}

export function getTrigger(deps: Deps, id: string): Trigger {
  const t = deps.triggers.get(id)
  if (t === undefined) throw notFound('trigger', id)
  return t
}

/** A trigger by id, or by exact or partial name (case-insensitive); a sentence for the agent when it is not one. */
export function findTrigger(deps: Deps, ref: string): Trigger {
  const all = deps.triggers.list()
  const lower = ref.trim().toLowerCase()
  const exact = all.filter((t) => t.id === ref.trim() || t.name.toLowerCase() === lower)
  const found = exact.length > 0 ? exact : all.filter((t) => t.name.toLowerCase().includes(lower))
  if (found.length === 0)
    throw notFound(
      'trigger',
      `${ref} (triggers: ${all.map((t) => `"${t.name}"`).join(', ') || 'none'})`,
    )
  if (found.length > 1)
    throw invalid(
      `"${ref}" matches several triggers: ${found.map((t) => `"${t.name}" (${t.id})`).join(', ')}. Use the id.`,
      'AMBIGUOUS_TRIGGER',
    )
  return found[0] as Trigger
}

/** What must exist for the trigger to work: the agent and the program. Throws `invalid`. (Connections are checked by the dry run.) */
async function checkReferences(deps: Deps, c: ReturnType<typeof checkTriggerInput>): Promise<void> {
  const a = c.action
  if (a.kind === 'wake') {
    const def = deps.agents.get(a.agentId)
    if (def === undefined) throw invalid(`there is no agent ${a.agentId}`, 'INVALID_TRIGGER')
    if (def.archivedAt !== null)
      throw invalid(`the agent ${def.name} is archived`, 'INVALID_TRIGGER')
  }
  if (a.kind === 'program') {
    const p = deps.programs.get(a.programId)
    if (p === undefined) throw invalid(`there is no program ${a.programId}`, 'INVALID_TRIGGER')
  }
  if (a.kind === 'webhook') {
    const blocked = await deps.triggerEngine.webhookBlocked(a.url)
    if (blocked !== undefined) throw invalid(`action.url: ${blocked}`, 'INVALID_TRIGGER')
  }
}

const changed = (deps: Deps, id: string, change: string): void =>
  deps.events.append({
    type: 'settings-changed',
    payload: { keys: ['triggers'], change, triggerId: id },
  })

export async function createTrigger(
  deps: Deps,
  actor: TriggerActor,
  input: TriggerInput,
  options: {
    /**
     * A webhook without a secret is created switched off (the agent tool: a secret never goes
     * through a chat; the owner sets it on the Triggers page and switches it on).
     */
    allowNoSecret?: boolean
  } = {},
): Promise<Trigger> {
  allow(actor)
  if (deps.triggers.list().length >= MAX_TRIGGERS)
    throw conflict(
      `there are ${MAX_TRIGGERS} triggers already: delete one first`,
      'TOO_MANY_TRIGGERS',
    )
  const c = checkTriggerInput(input, {
    allowPrivateWebhooks: deps.triggerEngine.allowPrivateWebhooks,
  })
  await checkReferences(deps, c)
  const noSecret =
    c.action.kind === 'webhook' &&
    options.allowNoSecret === true &&
    input.webhookSecret === undefined
  if (noSecret) c.enabled = false
  if (c.action.kind === 'webhook' && !noSecret && (input.webhookSecret ?? '').length < 16)
    throw invalid(
      'a webhook needs a secret of at least 16 characters, so the receiver can check the signature',
      'INVALID_TRIGGER',
    )
  const id = deps.ids.next()
  const sealed =
    c.action.kind === 'webhook' && input.webhookSecret !== undefined
      ? await deps.triggerSecrets.seal(id, input.webhookSecret)
      : null
  const t = deps.triggers.insert({
    id,
    ...c,
    eventTypes: c.eventTypes,
    sealedSecret: sealed,
    createdBy: triggerActorLabel(actor),
    now: deps.clock.now(),
  })
  changed(deps, t.id, 'trigger created')
  return t
}

export interface TriggerUpdate extends Partial<TriggerInput> {
  /** Forget the stored webhook secret (the action is no longer a webhook). */
  clearSecret?: boolean
}

export async function updateTrigger(
  deps: Deps,
  actor: TriggerActor,
  id: string,
  update: TriggerUpdate,
): Promise<Trigger> {
  allow(actor)
  const current = getTrigger(deps, id)
  // switching on or off must work for a trigger whose agent or program is gone
  const keys = Object.keys(update).filter(
    (k) => (update as Record<string, unknown>)[k] !== undefined,
  )
  if (keys.length === 1 && keys[0] === 'enabled')
    return setTriggerEnabled(deps, actor, id, update.enabled === true)
  const merged: TriggerInput = {
    name: update.name ?? current.name,
    enabled: update.enabled ?? current.enabled,
    eventTypes: update.eventTypes ?? current.eventTypes,
    scope: update.scope ?? current.scope,
    filters: update.filters ?? current.filters,
    action: update.action ?? current.action,
    cooldownSec: update.cooldownSec ?? current.cooldownSec,
    allowSelf: update.allowSelf ?? current.allowSelf,
    notes: update.notes === undefined ? current.notes : update.notes,
  }
  const c = checkTriggerInput(merged, {
    allowPrivateWebhooks: deps.triggerEngine.allowPrivateWebhooks,
  })
  await checkReferences(deps, c)
  let sealedSecret: string | null | undefined
  if (c.action.kind !== 'webhook') sealedSecret = null
  else if (update.webhookSecret !== undefined) {
    if (update.webhookSecret.length < 16)
      throw invalid('the webhook secret needs at least 16 characters', 'INVALID_TRIGGER')
    sealedSecret = await deps.triggerSecrets.seal(id, update.webhookSecret)
  } else if (!current.hasSecret)
    throw invalid(
      'a webhook needs a secret of at least 16 characters, so the receiver can check the signature',
      'INVALID_TRIGGER',
    )
  const next = deps.triggers.update(
    id,
    {
      name: c.name,
      enabled: c.enabled,
      eventTypes: c.eventTypes,
      scope: c.scope,
      filters: c.filters,
      action: c.action,
      cooldownSec: c.cooldownSec,
      allowSelf: c.allowSelf,
      notes: c.notes,
      ...(sealedSecret === undefined ? {} : { sealedSecret }),
    },
    deps.clock.now(),
  )
  if (next === undefined) throw notFound('trigger', id)
  changed(deps, id, 'trigger updated')
  return next
}

export function setTriggerEnabled(
  deps: Deps,
  actor: TriggerActor,
  id: string,
  enabled: boolean,
): Trigger {
  allow(actor)
  const current = getTrigger(deps, id)
  if (enabled && current.action.kind === 'webhook' && !current.hasSecret)
    throw invalid(
      'this webhook has no secret yet: set one on the Triggers page (Edit, Webhook secret), then switch it on',
      'INVALID_TRIGGER',
    )
  const next = deps.triggers.update(id, { enabled }, deps.clock.now()) as Trigger
  changed(deps, id, enabled ? 'trigger switched on' : 'trigger switched off')
  return next
}

export function deleteTrigger(deps: Deps, actor: TriggerActor, id: string): Trigger {
  allow(actor)
  const t = getTrigger(deps, id)
  deps.triggers.delete(id)
  changed(deps, id, 'trigger deleted')
  return t
}

export function triggerFires(
  deps: Deps,
  q: {
    triggerId?: string | undefined
    result?: string | undefined
    before?: string | undefined
    limit?: number | undefined
  },
): { items: TriggerFire[]; next?: string } {
  if (q.triggerId !== undefined) getTrigger(deps, q.triggerId)
  return deps.triggers.fires({
    ...(q.triggerId === undefined ? {} : { triggerId: q.triggerId }),
    ...(q.result === undefined ? {} : { result: q.result }),
    ...(q.before === undefined ? {} : { before: q.before }),
    limit: Math.min(200, Math.max(1, q.limit ?? 50)),
  })
}

// --- the dry run -------------------------------------------------------------------------------

export interface DryRun {
  trigger: { id: string; name: string }
  event: StreamEvent
  /** `fire`: it would run the action. `skip`: it would not, for `reason`. `nomatch`: not an event it listens to. */
  verdict: 'fire' | 'skip' | 'nomatch'
  reason?: SkipReason | 'type' | 'scope' | 'filtered'
  /** One sentence on the verdict. */
  summary: string
  notes: string[]
  /** Problems the action would run into now (a gone agent, a blocked host). */
  problems: string[]
  /** What the action would do, line by line (nothing was done). */
  wouldDo: string[]
}

/**
 * What a trigger would do with a past event, without doing it: the match and the gates as they are
 * now, the problems the action would meet, and the text or body it would send.
 */
export async function testTrigger(
  deps: Deps,
  id: string,
  eventId: string,
  options: { time?: (at: number) => string; text?: string } = {},
): Promise<DryRun> {
  const t = getTrigger(deps, id)
  const event = await deps.eventStream.get(eventId)
  if (event === undefined) throw notFound('event', eventId)
  const time = options.time ?? ((at: number) => new Date(at).toISOString())
  const ctx: MatchContext = { text: options.text }
  const m = matchTrigger(t, event, ctx)
  const base = { trigger: { id: t.id, name: t.name }, event }
  if (!m.matched) {
    return {
      ...base,
      verdict: 'nomatch',
      reason: m.reason,
      summary: `Would not fire: ${m.why}.`,
      notes: [],
      problems: [],
      wouldDo: [],
    }
  }
  const notes = [...m.notes]
  if (m.error !== undefined) notes.push(`the text expression failed: ${m.error}`)
  if (Date.now() - event.at > freshMs(event.type))
    notes.push(
      `this event is older than ${Math.round(freshMs(event.type) / 60_000)} minutes: a live event is handled when it arrives, an old one is ignored`,
    )
  if ((HIGH_VOLUME_TYPES as readonly string[]).includes(event.type))
    notes.push('a message or reaction that does not match the filters is counted, not logged')
  const now = deps.clock.now()
  const recent = deps.triggers
    .fires({ triggerId: t.id, limit: 1 })
    .items.find((f) => f.result !== 'skipped')
  const gate = gateOf(t, event, {
    now,
    paused: deps.pause.get().pausedAt !== null,
    executedLastHour: deps.triggers.executedSince(now - 3_600_000),
    hourlyCap: deps.settings.get().triggersMaxPerHour,
    lastFiredAt: t.lastFiredAt ?? recent?.at ?? null,
  })
  const problems = await deps.triggerEngine.preflight(t, event)
  const a = t.action
  const wouldDo: string[] = [
    `Action: ${describeAction(a, { agent: agentName(deps, a), program: programName(deps, a) })}`,
  ]
  if (a.kind === 'wake') {
    wouldDo.push(
      'The agent would receive:',
      wakeText(t, a, event, { time }, a.includeText === true ? { text: options.text } : {}),
    )
  } else if (a.kind === 'program') {
    wouldDo.push('The run would get this event as context:', describeEvent(event, { time }))
  } else if (a.kind === 'notify') {
    wouldDo.push(`A bell notification: "${a.title ?? `Trigger: ${t.name}`}" - ${event.summary}`)
  } else {
    wouldDo.push(
      'The receiver would get this JSON, signed in X-Team-Signature:',
      JSON.stringify(webhookPayload(t, event, '<delivery id>', now), null, 2),
    )
  }
  if (gate !== undefined)
    return {
      ...base,
      verdict: 'skip',
      reason: gate,
      summary: `Would not run the action now: ${GATE_TEXT[gate]}.`,
      notes,
      problems,
      wouldDo,
    }
  return {
    ...base,
    verdict: 'fire',
    summary:
      problems.length > 0
        ? `Would fire, but the action would fail: ${problems.join('; ')}.`
        : 'Would fire and run the action.',
    notes,
    problems,
    wouldDo,
  }
}

function agentName(deps: Deps, a: Trigger['action']): string | undefined {
  return a.kind === 'wake' ? deps.agents.get(a.agentId)?.name : undefined
}
function programName(deps: Deps, a: Trigger['action']): string | undefined {
  return a.kind === 'program' ? deps.programs.get(a.programId)?.name : undefined
}

/** Names for the lists a person reads: the agent and program of each action. */
export function triggerNames(deps: Deps, t: Trigger): { agent?: string; program?: string } {
  const agent = agentName(deps, t.action)
  const program = programName(deps, t.action)
  return {
    ...(agent === undefined ? {} : { agent }),
    ...(program === undefined ? {} : { program }),
  }
}
