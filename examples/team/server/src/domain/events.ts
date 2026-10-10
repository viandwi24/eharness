/** The event feed (plan §5.3): append-only rows every instance tails by `seq`. Pure. */
export const EVENT_TYPES = [
  'message-added',
  'turn-started',
  'task-changed',
  'approval-needed',
  'approval-decided',
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
}
