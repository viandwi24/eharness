/**
 * The event feed (plan §5.3): append-only rows every instance tails by `seq`. Pure.
 *
 * The feed is the library's `ActivityStore` (`eharness/activity`): session events come from its
 * `activity()` plugin, the app appends its own types next to them.
 */

/** Events of the app itself (the library's types are in `SESSION_EVENT_TYPES`). */
export const APP_EVENT_TYPES = [
  'message-added',
  'task-changed',
  'agent-message',
  'file-changed',
  'agent-changed',
  'routine-fired',
  'routine-changed',
  'settings-changed',
  'mode-changed',
  'model-call',
  'providers-changed',
  'connectors-changed',
] as const

/**
 * Session events of `eharness/activity` this app enables (`turn-started`: every turn of every
 * session, `pending-changed`: what waits for a person, `approval-decided`, `attention-answered`,
 * `session-recovered`, `child-reported`; see spec 25). Mirrors `SESSION_ACTIVITY_TYPES`
 * (checked in test/activity-feed.test.ts).
 */
export const SESSION_EVENT_TYPES = [
  'turn-started',
  'pending-changed',
  'approval-decided',
  'attention-answered',
  'session-recovered',
  'child-reported',
] as const

export const EVENT_TYPES = [...APP_EVENT_TYPES, ...SESSION_EVENT_TYPES] as const
export type EventType = (typeof EVENT_TYPES)[number]

export interface TeamEvent {
  seq: number
  type: EventType
  agentId: string | null
  sessionId: string | null
  payload: Record<string, unknown>
  createdAt: number
}

export interface NewEvent {
  type: EventType
  agentId?: string | null
  sessionId?: string | null
  payload: Record<string, unknown>
  /** Epoch ms of the event; default: now. */
  at?: number
}
