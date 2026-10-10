import { toolTitle } from '../parts/map.js';

export type SummaryRow = { label: string; value: string; mono: boolean };
export type ApprovalSummary = { title: string; rows: SummaryRow[]; raw: string };

const MAX_VALUE = 400;
const LABELS: Record<string, string> = {
	path: 'Path',
	file_path: 'Path',
	filePath: 'Path',
	file: 'Path',
	command: 'Command',
	cmd: 'Command',
	url: 'URL',
	query: 'Query',
	pattern: 'Pattern',
	description: 'Task',
	prompt: 'Prompt',
	subagent_type: 'Agent',
	to: 'To',
	content: 'Content',
	old_string: 'Replace',
	new_string: 'With'
};
const MONO = new Set(['path', 'file_path', 'filePath', 'file', 'command', 'cmd', 'url', 'pattern']);

function clip(s: string): string {
	return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE)}…` : s;
}

function humanize(key: string): string {
	const s = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
	return s ? s[0]!.toUpperCase() + s.slice(1) : key;
}

/**
 * A readable view of a tool call for an approval card: the friendly title of the tool plus one row per
 * input field (scalars as text, nested values as compact JSON), and the full raw input for "Details".
 */
export function summarizeApproval(toolName: string, input: unknown): ApprovalSummary {
	const title = toolTitle(toolName, input);
	let raw = '';
	if (input !== undefined && input !== null) {
		try {
			raw = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
		} catch {
			raw = '';
		}
	}
	const rows: SummaryRow[] = [];
	if (typeof input === 'string' && input.trim()) {
		rows.push({ label: 'Input', value: clip(input), mono: false });
	} else if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
		for (const [key, v] of Object.entries(input as Record<string, unknown>)) {
			if (v === undefined || v === null || v === '') continue;
			let value: string;
			if (typeof v === 'string') value = v;
			else if (typeof v === 'number' || typeof v === 'boolean') value = String(v);
			else {
				try {
					value = JSON.stringify(v);
				} catch {
					continue;
				}
			}
			rows.push({ label: LABELS[key] ?? humanize(key), value: clip(value), mono: MONO.has(key) });
		}
	}
	return { title, rows, raw };
}
