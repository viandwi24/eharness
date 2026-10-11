import type { ActivityRecord } from 'eharness/client';
import type { AgentActivity } from './agents-core';

export type ActivityEffect = { markRead?: string };

/**
 * Apply one event to the sidebar activity map (mutates `activity`; pass the `$state` proxy).
 * `viewing` is the agent id whose chat is open AND visible: its messages are read at once, which
 * the caller persists with `POST /agents/{id}/read` (returned as `markRead`).
 */
export function applyActivity(
	activity: Record<string, AgentActivity>,
	e: ActivityRecord,
	viewing: string | null
): ActivityEffect {
	if (e.type !== 'message-added' || !e.agentId) return {};
	const role = e.payload.role;
	const cur = activity[e.agentId] ?? { preview: null, lastMessageAt: null, unread: 0 };
	const preview = typeof e.payload.preview === 'string' && e.payload.preview ? e.payload.preview : cur.preview;
	const visible = viewing === e.agentId;
	const unread = role === 'assistant' && !visible ? cur.unread + 1 : visible ? 0 : cur.unread;
	activity[e.agentId] = { preview, lastMessageAt: e.createdAt || Date.now(), unread };
	return role === 'assistant' && visible ? { markRead: e.agentId } : {};
}
