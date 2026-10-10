// Pure derivations for the agent session panel (progress, outputs, sources), from the chat messages.
// No Svelte, no DOM: unit-tested with bun test.
import type { UIMessage } from 'ai';
import { viewModel, type PartView } from '../parts/map.js';
import { writtenFiles, type ToolView } from '../parts/activity.js';

export type TodoState = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export type TodoRow = { content: string; status: TodoState; activeForm?: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const STATES: readonly string[] = ['pending', 'in_progress', 'completed', 'cancelled'];

/** The latest `data-todos.list` of the chat (the whole list after the last `todo_write`). */
export function latestTodoList(messages: readonly UIMessage[]): TodoRow[] {
	for (let i = messages.length - 1; i >= 0; i--) {
		const parts = messages[i]!.parts as unknown as { type: string; data?: unknown }[];
		for (let j = parts.length - 1; j >= 0; j--) {
			const p = parts[j]!;
			if (p.type !== 'data-todos.list' || !isRecord(p.data) || !Array.isArray(p.data.todos)) continue;
			return p.data.todos.filter(isRecord).map((t) => ({
				content: String(t.content ?? ''),
				status: (STATES.includes(String(t.status)) ? t.status : 'pending') as TodoState,
				activeForm: typeof t.activeForm === 'string' ? t.activeForm : undefined
			}));
		}
	}
	return [];
}

/** 0-100: finished items over all (cancelled items do not count). */
export function todoPercent(todos: readonly TodoRow[]): number {
	const live = todos.filter((t) => t.status !== 'cancelled');
	if (!live.length) return 0;
	return Math.round((live.filter((t) => t.status === 'completed').length / live.length) * 100);
}

export function toolViews(messages: readonly UIMessage[]): ToolView[] {
	const out: ToolView[] = [];
	for (const m of messages) for (const v of viewModel(m)) if (v.kind === 'tool') out.push(v);
	return out;
}

function sourceViews(messages: readonly UIMessage[]): Extract<PartView, { kind: 'source' }>[] {
	const out: Extract<PartView, { kind: 'source' }>[] = [];
	for (const m of messages) for (const v of viewModel(m)) if (v.kind === 'source') out.push(v);
	return out;
}

/** Files written in this chat, newest first. */
export function chatOutputs(views: readonly ToolView[]): string[] {
	return writtenFiles(views)
		.map((f) => f.path)
		.reverse();
}

export function hostOf(url: string): string | null {
	try {
		return new URL(url).hostname.replace(/^www\./, '') || null;
	} catch {
		return null;
	}
}

const PATH_KEYS = ['path', 'file_path', 'filePath', 'file', 'name'];
function pathOf(input: unknown): string | undefined {
	if (!isRecord(input)) return undefined;
	for (const k of PATH_KEYS) if (typeof input[k] === 'string' && input[k]) return input[k] as string;
	return undefined;
}
const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

export type UsedSummary = {
	web: { hosts: string[]; calls: number };
	filesRead: { names: string[]; count: number };
	memory: { read: string[]; write: string[]; calls: number };
	tools: { names: string[]; calls: number };
};

const HIDDEN_TOOLS = new Set(['todo_write', 'agent', 'agent_output', 'agent_stop', 'send_message', 'ask_user_question', 'tool_search']);
const FILE_TOOLS = new Set(['write_file', 'edit_file', 'read_file', 'list_files', 'grep', 'glob']);

/** What the agent used in this chat: web hosts, files read, memory and other tools. */
export function usedSummary(messages: readonly UIMessage[]): UsedSummary {
	const views = toolViews(messages);
	const hosts: string[] = [];
	let webCalls = 0;
	for (const s of sourceViews(messages)) {
		const h = s.url ? hostOf(s.url) : null;
		if (h) hosts.push(h);
	}
	const read: string[] = [];
	const memRead: string[] = [];
	const memWrite: string[] = [];
	let memCalls = 0;
	const other: string[] = [];
	for (const v of views) {
		if (v.state === 'output-error' || v.state === 'output-denied') continue;
		const n = v.toolName;
		if (n === 'web_search' || n === 'web_fetch') {
			webCalls++;
			const fromInput = isRecord(v.input) && typeof v.input.url === 'string' ? hostOf(v.input.url) : null;
			if (fromInput) hosts.push(fromInput);
			const text = typeof v.output === 'string' ? v.output : v.output ? JSON.stringify(v.output) : '';
			for (const m of text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
				const h = hostOf(m[0]);
				if (h) hosts.push(h);
			}
		} else if (n === 'read_file') {
			const p = pathOf(v.input);
			if (p) read.push(base(p));
		} else if (n.startsWith('memory')) {
			memCalls++;
			const p = pathOf(v.input);
			const label = p ? base(p).replace(/\.[a-z0-9]+$/i, '') : undefined;
			const isRead = /read|view|list|search/.test(n);
			if (label) (isRead ? memRead : memWrite).push(label);
			else (isRead ? memRead : memWrite).push('memory');
		} else if (!HIDDEN_TOOLS.has(n) && !FILE_TOOLS.has(n)) {
			other.push(n.replaceAll('_', ' '));
		}
	}
	const rank = (xs: string[]): string[] => {
		const c = new Map<string, number>();
		for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
		return [...c].sort((a, b) => b[1] - a[1]).map(([k]) => k);
	};
	return {
		web: { hosts: rank(hosts), calls: webCalls },
		filesRead: { names: rank(read), count: uniq(read).length },
		memory: { read: uniq(memRead), write: uniq(memWrite), calls: memCalls },
		tools: { names: rank(other), calls: other.length }
	};
}

/** First `# heading` of a markdown text, else undefined. */
export function markdownTitle(text: string): string | undefined {
	const m = /^#{1,3}\s+(.+?)\s*#*\s*$/m.exec(text);
	return m?.[1]?.replace(/[*_`]/g, '').trim() || undefined;
}

/** Short format badge from the extension (`.md` -> MD). */
export function formatBadge(path: string): string {
	const b = path.slice(path.lastIndexOf('/') + 1);
	const i = b.lastIndexOf('.');
	return i > 0 ? b.slice(i + 1).toUpperCase().slice(0, 5) : 'FILE';
}
