// The numeric product knobs of Settings (limits, reliability, retention), as data: the page renders
// them from this table and the same table parses and validates what was typed. The ranges mirror
// the server's `checkSettingsPatch`. Pure, unit-tested.
export type KnobKey =
	| 'toolWarmDays'
	| 'stuckRunMinutes'
	| 'connectorHealthTtlMs'
	| 'connectorProbeRetryMs'
	| 'longRunMaxCostUsd'
	| 'longRunMaxHours'
	| 'longRunChunkSteps'
	| 'contextCap'
	| 'heartbeatContextWindow'
	| 'maxRepeatingReminders'
	| 'eventsRetentionHours'
	| 'eventsMaxRows'
	| 'logMaxRows'
	| 'logRetentionDays'
	| 'logBodyHours'
	| 'mediaRetentionDays'
	| 'routineRunsRetentionDays'
	| 'tasksRetentionDays'
	| 'libraryHistoryRetentionDays';

export type Knob = {
	key: KnobKey;
	label: string;
	description: string;
	min: number;
	max: number;
	integer: boolean;
	/** Empty means null (no limit / off) instead of an error. */
	nullable?: boolean;
	/** The API holds `value * scale` of what the field shows (the field shows seconds, the API milliseconds). */
	scale?: number;
	unit?: string;
	placeholder?: string;
};

export type KnobGroup = { id: 'reliability' | 'limits' | 'retention'; title: string; description: string; knobs: Knob[] };

export const KNOB_GROUPS: KnobGroup[] = [
	{
		id: 'reliability',
		title: 'Reliability',
		description: 'How the server notices and reacts to things that stopped working.',
		knobs: [
			{ key: 'stuckRunMinutes', label: 'Stuck run limit', unit: 'minutes', min: 5, max: 1440, integer: true, description: 'A program, routine or queued run with no activity for this long is stopped and raises an alarm. It is never run again by itself.' },
			{ key: 'connectorHealthTtlMs', label: 'Connector check interval', unit: 'seconds', scale: 1000, min: 0, max: 86400, integer: true, nullable: true, placeholder: 'Off', description: 'A custom connector is re-checked in the background when its last check is older than this. 0 checks on every listing; empty never checks.' },
			{ key: 'connectorProbeRetryMs', label: 'Connector retry delay', unit: 'seconds', scale: 1000, min: 0, max: 60, integer: false, description: 'A failed check of a connected server is retried once after this long before the connection counts as down (a dropped socket is not an outage).' }
		]
	},
	{
		id: 'limits',
		title: 'Limits',
		description: 'Caps on background work and on what one person or agent can pile up.',
		knobs: [
			{ key: 'longRunMaxCostUsd', label: 'Background job cost limit', unit: 'USD', min: 0, max: 100000, integer: false, description: 'A background worker job stops when its estimated cost reaches this. 0 means no limit.' },
			{ key: 'longRunMaxHours', label: 'Background job time limit', unit: 'hours', min: 0, max: 8760, integer: false, description: 'A background worker job stops this long after it started. 0 means no limit.' },
			{ key: 'longRunChunkSteps', label: 'Steps per background chunk', min: 10, max: 500, integer: true, description: 'A background job runs in chunks of this many steps, checking its limits between them.' },
			{ key: 'maxRepeatingReminders', label: 'Repeating reminders per person', min: 0, max: 1000, integer: true, description: 'Most active repeating reminders one person may have in a chat. 0 means no limit.' },
			{ key: 'heartbeatContextWindow', label: 'Heartbeat context window', unit: 'tokens', min: 16000, max: 10000000, integer: true, description: "The working window of every heartbeat session, separate from the chat window and never above the model's. Beats summarize early so each one starts small and cheap." },
			{ key: 'contextCap', label: 'Context window ceiling (deprecated)', unit: 'tokens', min: 16000, max: 10000000, integer: true, nullable: true, placeholder: 'None', description: "A global ceiling on every agent's context window. Leave empty: the window follows each agent's model, and an agent can set its own smaller limit." }
		]
	},
	{
		id: 'retention',
		title: 'Data retention',
		description: 'How long the server keeps logs and finished work. Pruned every 10 minutes.',
		knobs: [
			{ key: 'eventsRetentionHours', label: 'Events feed age', unit: 'hours', min: 0, max: 87600, integer: true, description: '0 keeps by row count only.' },
			{ key: 'eventsMaxRows', label: 'Events feed rows', min: 1000, max: 100000000, integer: true, description: 'Most rows kept in the events feed.' },
			{ key: 'logMaxRows', label: 'Model call log rows', min: 100, max: 10000000, integer: true, description: 'Most calls kept on the Logs page.' },
			{ key: 'logRetentionDays', label: 'Model call log age', unit: 'days', min: 1, max: 3650, integer: false, description: 'Calls older than this are removed.' },
			{ key: 'logBodyHours', label: 'Full prompts kept', unit: 'hours', min: 0, max: 8760, integer: false, description: 'The whole request and response of a model call (about 0.5 MB each) are kept this long for debugging; older calls keep tokens, cost and timing only.' },
			{ key: 'mediaRetentionDays', label: 'Screenshots and tool media', unit: 'days', min: 0, max: 36500, integer: true, description: '0 keeps them. A chat that still shows a removed one shows "expired".' },
			{ key: 'routineRunsRetentionDays', label: 'Finished routine runs', unit: 'days', min: 0, max: 36500, integer: true, description: '0 keeps them.' },
			{ key: 'tasksRetentionDays', label: 'Finished tasks', unit: 'days', min: 0, max: 36500, integer: true, description: '0 keeps them.' },
			{ key: 'libraryHistoryRetentionDays', label: 'Library history', unit: 'days', min: 0, max: 36500, integer: true, description: '0 keeps it.' }
		]
	}
];

/** Knobs the General section shows next to their related field (not in a group). */
export const GENERAL_KNOBS: Knob[] = [
	{ key: 'toolWarmDays', label: 'Load tools used recently up front', unit: 'days', min: 0, max: 365, integer: true, description: 'A tool an agent called in the last few days is in its tool list from the start of a chat, instead of being found with tool search. Finding a tool changes the tool list and makes the model re-read the whole chat at full price. 0 turns this off.' }
];

export const ALL_KNOBS: Knob[] = [...GENERAL_KNOBS, ...KNOB_GROUPS.flatMap((g) => g.knobs)];

/** The text a field shows for a stored value. */
export function knobText(k: Knob, value: number | null): string {
	if (value === null) return '';
	return String(k.scale ? value / k.scale : value);
}

/** Parse what was typed: the API value, or an error text. */
export function parseKnob(k: Knob, raw: string | number | null): { ok: true; value: number | null } | { ok: false; error: string } {
	const text = String(raw ?? '').trim();
	if (text === '') return k.nullable ? { ok: true, value: null } : { ok: false, error: 'Enter a number' };
	const n = Number(text);
	const range = `from ${k.min} to ${k.max}`;
	if (!Number.isFinite(n) || n < k.min || n > k.max) return { ok: false, error: `Enter a number ${range}` };
	if (k.integer && !Number.isInteger(n)) return { ok: false, error: `Enter a whole number ${range}` };
	const value = k.scale ? Math.round(n * k.scale) : n;
	return { ok: true, value };
}

/** The changed knobs as an API patch, or the errors keyed by field. `current` holds the stored values. */
export function knobPatch(texts: Record<string, string | number | null>, current: Record<string, number | null>): { ok: true; patch: Record<string, number | null> } | { ok: false; errors: Record<string, string> } {
	const patch: Record<string, number | null> = {};
	const errors: Record<string, string> = {};
	for (const k of ALL_KNOBS) {
		if (!(k.key in current)) continue;
		const r = parseKnob(k, texts[k.key] ?? null);
		if (!r.ok) errors[k.key] = r.error;
		else if (r.value !== current[k.key]) patch[k.key] = r.value;
	}
	return Object.keys(errors).length ? { ok: false, errors } : { ok: true, patch };
}
