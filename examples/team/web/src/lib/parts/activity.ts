// Pure helpers for the compact activity rows (reasoning and tool calls). Unit-tested with bun test.
import type { PartView } from './map.js';

export type ToolView = Extract<PartView, { kind: 'tool' }>;

/** A tool call that renders as a quiet activity row (not a subagent card, not awaiting a person). */
export function isActivityTool(v: PartView): v is ToolView {
	return v.kind === 'tool' && !v.isSubagent && v.state !== 'approval-requested';
}

export function isRunning(v: ToolView): boolean {
	return v.state === 'input-streaming' || v.state === 'input-available' || v.state === 'approval-responded';
}

/** Short trailing note after the title; nothing for a normal success. */
export function toolNote(v: ToolView): { text: string; tone: 'error' | 'muted' } | undefined {
	if (v.state === 'output-error') return { text: 'failed', tone: 'error' };
	if (v.state === 'output-denied') return { text: 'denied', tone: 'muted' };
	return undefined;
}

export type GroupSummary = { label: string; names: string; running: boolean; failed: number };

/** "Used 3 tools · Update todos, Read agent output ×2"; while one runs: "Running Update todos…". */
export function groupSummary(views: readonly ToolView[]): GroupSummary {
	const counts = new Map<string, number>();
	for (const v of views) counts.set(v.title, (counts.get(v.title) ?? 0) + 1);
	const names = [...counts].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(', ');
	const active = views.find(isRunning);
	const failed = views.filter((v) => v.state === 'output-error').length;
	const label = active ? `Running ${active.title}…` : `Used ${views.length} tools`;
	return { label, names: active ? '' : names, running: active !== undefined, failed };
}

export function reasoningLabel(streaming: boolean, durationMs?: number): string {
	if (streaming) return 'Thinking…';
	if (durationMs === undefined) return 'Thought for a few seconds';
	const s = Math.max(1, Math.round(durationMs / 1000));
	return `Thought for ${s} ${s === 1 ? 'second' : 'seconds'}`;
}
