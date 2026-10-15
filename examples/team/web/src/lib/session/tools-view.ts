// Pure logic of "Tools in this session": the configured tools of `GET /sessions/{id}/tools` against
// what the last model call carried, as groups with a badge per tool.
import type { components } from '../api/schema';

export type SessionTools = components['schemas']['SessionTools'];

export type ToolState = 'loaded' | 'deferred' | 'missing' | 'off' | 'chat-off' | 'unchecked';

export const TOOL_STATE_LABEL: Record<ToolState, string> = {
	loaded: 'Loaded',
	deferred: 'On demand',
	missing: 'Missing',
	off: 'Off',
	'chat-off': 'Off in this chat',
	unchecked: 'Not checked'
};

export interface ToolRowView {
	name: string;
	state: ToolState;
	/** The agent asks before it runs this tool. */
	asks: boolean;
}

export interface ToolGroupView {
	key: string;
	/** "Phone" or "Phone · work account" when the label adds something. */
	title: string;
	rows: ToolRowView[];
	/** Tools the model may use (not off) in the group. */
	total: number;
	/** Of those, loaded or on demand in the last call (all of them when the call is unknown). */
	available: number;
	missing: number;
	/** "phone — 3 of 16 available", or "16 tools" when the last call is unknown. */
	summary: string;
}

export interface SessionToolsView {
	groups: ToolGroupView[];
	/** Configured and allowed, yet not in the last call: the warning. */
	missing: string[];
	/** Carried by the last call, not configured (plugin tools). */
	extra: string[];
	/** The last call could be read. */
	checked: boolean;
}

const ORDER: Record<ToolState, number> = { missing: 0, loaded: 1, deferred: 2, unchecked: 3, 'chat-off': 4, off: 5 };

export function groupSessionTools(view: SessionTools): SessionToolsView {
	const call = view.lastCall;
	const loaded = new Set(call?.loaded ?? []);
	const deferred = new Set(call?.deferred ?? []);
	const groups: ToolGroupView[] = view.configured.map((g) => {
		const rows: ToolRowView[] = g.tools.map((t) => {
			let state: ToolState;
			if (t.mode === 'off') state = 'off';
			else if (t.chatOff) state = 'chat-off';
			else if (call === null) state = 'unchecked';
			else if (loaded.has(t.name)) state = 'loaded';
			else if (deferred.has(t.name)) state = 'deferred';
			else state = 'missing';
			return { name: t.name, state, asks: t.mode === 'ask' };
		});
		rows.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));
		const usable = rows.filter((r) => r.state !== 'off' && r.state !== 'chat-off');
		const available = usable.filter((r) => r.state !== 'missing').length;
		const missing = usable.length - available;
		const name = g.label && g.label.toLowerCase() !== g.name.toLowerCase() ? `${g.name} · ${g.label}` : g.name;
		const summary = call === null ? `${name} — ${usable.length} ${usable.length === 1 ? 'tool' : 'tools'}` : `${name} — ${available} of ${usable.length} available`;
		return { key: g.connectionId ?? `connector:${g.connectorId}`, title: name, rows, total: usable.length, available, missing, summary };
	});
	groups.sort((a, b) => Number(b.missing > 0) - Number(a.missing > 0) || a.title.localeCompare(b.title));
	return { groups, missing: view.missing, extra: view.extra, checked: call !== null };
}
