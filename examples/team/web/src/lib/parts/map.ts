// Pure mapping UIMessage -> PartView[] (P32 §7.3). No Svelte, no DOM: unit-tested with bun test.
// Renderers (*.svelte) switch on `PartView.kind`; transient parts never reach a stored message.
import type { UIMessage } from 'ai';
import { isClipped } from '../chat/clip.js';

export type ToolViewState =
	| 'input-streaming'
	| 'input-available'
	| 'approval-requested'
	| 'approval-responded'
	| 'output-available'
	| 'output-error'
	| 'output-denied';

/** `auto`: the server let the call through without asking (`metadata.app.autoAllowed`): a saved grant, a permission rule or the mode. */
export type ToolApproval = { id: string; approved?: boolean; reason?: string; auto?: 'grant' | 'rule' | 'mode' };

/** Preliminary output of the `agent` tool (spec 20 §2). */
export type SubagentProgress = {
	status: 'running' | 'completed' | 'failed' | 'stopped';
	agent: string;
	description?: string;
	sessionId?: string;
	steps: number;
	lastTool?: string;
	text: string;
};

/** Card status words: the stored marker says `running`; the task row says what it is now. */
export type SubagentStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'stopped' | 'interrupted' | 'timed_out' | 'not_started';

/** Data of `data-subagent.run`. */
export type SubagentRun = {
	toolCallId: string;
	sessionId: string;
	agent: string;
	status: SubagentStatus;
	name?: string;
	taskId?: string;
};

export type InputSource = 'user' | 'event' | `plugin:${string}`;

export type PartView =
	| { kind: 'text'; key: string; text: string; streaming: boolean }
	| { kind: 'reasoning'; key: string; text: string; streaming: boolean; durationMs?: number }
	| {
			kind: 'tool';
			key: string;
			toolCallId: string;
			/** The message this call is in (for loading its clipped output in full). */
			messageId?: string;
			/** The server cut the output (a page of history clips big outputs); "Load full output" fetches it. */
			clipped?: boolean;
			toolName: string;
			title: string;
			state: ToolViewState;
			input: unknown;
			output?: unknown;
			errorText?: string;
			approval?: ToolApproval;
			isSubagent: boolean;
			/** Latest SubagentProgress while the `agent` tool runs. */
			progress?: SubagentProgress;
			/** The matching `data-subagent.run` (agent tool only). */
			run?: SubagentRun;
			/** True when the output is a preliminary (still streaming) one. */
			preliminary?: boolean;
	  }
	| { kind: 'subagentRun'; key: string; run: SubagentRun }
	| {
			kind: 'input';
			key: string;
			source: InputSource;
			text: string;
			files: { url: string; mediaType: string; filename?: string }[];
			approvalNote?: { toolCallId: string; toolName: string; text: string };
	  }
	| { kind: 'event'; key: string; name: string; text: string; data?: unknown }
	| { kind: 'notice'; key: string; level: 'info' | 'warning' | 'error'; code?: string; text: string }
	| { kind: 'compaction'; key: string; summary: string; tokens?: unknown; trigger?: string; partial?: boolean }
	| { kind: 'file'; key: string; url: string; mediaType: string; filename?: string }
	| { kind: 'source'; key: string; sourceType: 'url' | 'document'; url?: string; title: string; mediaType?: string }
	| { kind: 'artifact'; key: string; id: string; artifactKind: string; title: string; version?: number }
	| { kind: 'unknown'; key: string; type: string; data?: unknown };

type AnyPart = { type: string; [k: string]: unknown };

/** Same wording the library stores for it (`APPROVED_THEN_DENIED`). */
const APPROVED_THEN_DENIED = 'Approved, but denied when the call was re-validated by the approval policy.';

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

function firstString(input: unknown, keys: string[]): string | undefined {
	if (!isRecord(input)) return undefined;
	for (const k of keys) {
		const v = str(input[k]);
		if (v) return v;
	}
	return undefined;
}

function short(s: string, max = 60): string {
	const one = s.replace(/\s+/g, ' ').trim();
	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

const PATH_KEYS = ['path', 'file_path', 'filePath', 'file'];

/** Friendly title for a tool call; falls back to the raw tool name. */
export function toolTitle(name: string, input?: unknown): string {
	const path = firstString(input, PATH_KEYS);
	const withArg = (label: string, arg?: string): string => (arg ? `${label} ${short(arg)}` : label);
	switch (name) {
		case 'read_file':
			return withArg('Read', path);
		case 'edit_file':
			return withArg('Edit', path);
		case 'write_file':
			return withArg('Write', path);
		case 'list_files':
			return withArg('List', path ?? firstString(input, ['dir', 'directory']));
		case 'grep':
			return withArg('Search for', firstString(input, ['pattern', 'query']));
		case 'glob':
			return withArg('Find files', firstString(input, ['pattern']));
		case 'bash':
			return withArg('Run', firstString(input, ['command', 'cmd']));
		case 'web_fetch':
			return withArg('Fetch', firstString(input, ['url']));
		case 'web_search':
			return withArg('Search the web for', firstString(input, ['query']));
		case 'todo_write':
			return 'Update todos';
		case 'memory_read':
		case 'memory_view':
			return 'Read memory';
		case 'memory_write':
		case 'memory_update':
		case 'memory_save':
			return 'Update memory';
		case 'ask_user_question':
			return 'Ask a question';
		case 'agent':
			return withArg('Delegate to', firstString(input, ['subagent_type']) ?? firstString(input, ['description']));
		case 'send_message':
			return withArg('Message', firstString(input, ['to', 'name']));
		case 'agent_output':
			return 'Read agent output';
		case 'agent_stop':
			return 'Stop agent';
		case 'tool_search':
			return 'Loaded tools';
		default:
			if (name.startsWith('memory')) return name.replace(/_/g, ' ');
			return name;
	}
}

function isProgress(v: unknown): v is SubagentProgress {
	return isRecord(v) && typeof v.status === 'string' && typeof v.steps === 'number' && typeof v.agent === 'string';
}

function isRun(v: unknown): v is SubagentRun {
	return isRecord(v) && typeof v.toolCallId === 'string' && typeof v.sessionId === 'string' && typeof v.agent === 'string';
}

function toolName(part: AnyPart): string {
	return part.type === 'dynamic-tool' ? String(part.toolName ?? 'tool') : part.type.slice('tool-'.length);
}

/**
 * Map one stored or streaming UIMessage to renderable views, in part order. `live` is false for a
 * message nothing is streaming into: an aborted turn stores parts still marked `state: 'streaming'`,
 * which must not shimmer "Thinking…" forever.
 */
export function viewModel(message: UIMessage, live = true): PartView[] {
	const parts = message.parts as unknown as AnyPart[];
	const out: PartView[] = [];

	const autoAllowed = (message.metadata as { app?: { autoAllowed?: Record<string, unknown> } } | undefined)?.app?.autoAllowed;
	const runs = new Map<string, SubagentRun>();
	const toolCallIds = new Set<string>();
	for (const p of parts) {
		if (!isRecord(p) || typeof p.type !== 'string') continue;
		if (p.type === 'data-subagent.run' && isRun(p.data)) runs.set(p.data.toolCallId, p.data);
		if (p.type === 'dynamic-tool' || p.type.startsWith('tool-')) {
			if (typeof p.toolCallId === 'string') toolCallIds.add(p.toolCallId);
		}
	}

	parts.forEach((part, i) => {
		const key = `${message.id}:${i}`;
		if (!isRecord(part) || typeof part.type !== 'string') {
			out.push({ kind: 'unknown', key, type: 'invalid' }); // a malformed part never crashes the list
			return;
		}
		const type = part.type;

		if (type === 'text') {
			out.push({ kind: 'text', key, text: String(part.text ?? ''), streaming: live && part.state === 'streaming' });
		} else if (type === 'reasoning') {
			const meta = isRecord(part.providerMetadata) ? part.providerMetadata : undefined;
			const eh = meta && isRecord(meta.eharness) ? meta.eharness : undefined;
			const durationMs = eh && typeof eh.durationMs === 'number' ? eh.durationMs : undefined;
			out.push({ kind: 'reasoning', key, text: String(part.text ?? ''), streaming: live && part.state === 'streaming', durationMs });
		} else if (type === 'dynamic-tool' || type.startsWith('tool-')) {
			const name = toolName(part);
			const state = part.state as ToolViewState;
			let approval = isRecord(part.approval) && typeof part.approval.id === 'string' ? (part.approval as ToolApproval) : undefined;
			// A call a person approved can still be denied when a continuation re-validates it; the live
			// stream keeps `approved: true` on that part (storage repairs it). Show what happened.
			if (approval && state === 'output-denied' && approval.approved !== false) {
				approval = { ...approval, approved: false, reason: approval.reason || APPROVED_THEN_DENIED };
			}
			const isSubagent = name === 'agent';
			const toolCallId = String(part.toolCallId ?? key);
			const via = autoAllowed?.[toolCallId];
			if (approval && (via === 'grant' || via === 'rule' || via === 'mode')) approval = { ...approval, auto: via };
			const progress = isSubagent && isProgress(part.output) ? part.output : undefined;
			const title = toolTitle(name, part.input);
			out.push({
				kind: 'tool',
				key,
				toolCallId,
				messageId: message.id,
				clipped: isClipped(part) ? true : undefined,
				toolName: name,
				title,
				state,
				input: part.input,
				// A progress object is shown by the run card, not as a result.
				output: progress ? undefined : part.output,
				errorText: str(part.errorText) ?? (state === 'output-denied' ? str(approval?.reason) : undefined),
				approval,
				isSubagent,
				progress,
				run: isSubagent ? runs.get(toolCallId) : undefined,
				preliminary: part.preliminary === true ? true : undefined
			});
		} else if (type === 'data-subagent.run') {
			// Merged into the `agent` tool view when its tool part is in the same message.
			if (isRun(part.data) && !toolCallIds.has(part.data.toolCallId)) out.push({ kind: 'subagentRun', key, run: part.data });
		} else if (type === 'data-eh.input') {
			const d = isRecord(part.data) ? part.data : {};
			const files = Array.isArray(d.files)
				? (d.files as unknown[]).filter(isRecord).map((f) => ({
						url: String(f.url ?? ''),
						mediaType: String(f.mediaType ?? 'application/octet-stream'),
						filename: str(f.filename)
					}))
				: [];
			const note = isRecord(d.approvalNote) ? d.approvalNote : undefined;
			out.push({
				kind: 'input',
				key,
				source: (str(d.source) ?? 'user') as InputSource,
				text: String(d.text ?? ''),
				files,
				approvalNote: note
					? { toolCallId: String(note.toolCallId ?? ''), toolName: String(note.toolName ?? ''), text: String(note.text ?? '') }
					: undefined
			});
		} else if (type === 'data-eh.event') {
			const d = isRecord(part.data) ? part.data : {};
			out.push({ kind: 'event', key, name: String(d.name ?? 'event'), text: String(d.text ?? ''), data: d.data });
		} else if (type === 'data-eh.notice') {
			const d = isRecord(part.data) ? part.data : {};
			const level = d.level === 'error' || d.level === 'warning' ? d.level : 'info';
			out.push({ kind: 'notice', key, level, code: str(d.code), text: String(d.message ?? '') });
		} else if (type === 'data-eh.compaction') {
			const d = isRecord(part.data) ? part.data : {};
			out.push({
				kind: 'compaction',
				key,
				summary: String(d.summary ?? ''),
				tokens: d.tokens,
				trigger: str(d.trigger),
				partial: d.partial === true ? true : undefined
			});
		} else if (type === 'file') {
			// the same stored file twice in one message (a re-delivered attachment) is one chip
			const url = String(part.url ?? '');
			if (url !== '' && out.some((v) => v.kind === 'file' && v.url === url)) return;
			out.push({ kind: 'file', key, url: String(part.url ?? ''), mediaType: String(part.mediaType ?? 'application/octet-stream'), filename: str(part.filename) });
		} else if (type === 'source-url') {
			out.push({ kind: 'source', key, sourceType: 'url', url: str(part.url), title: str(part.title) ?? String(part.url ?? 'source') });
		} else if (type === 'source-document') {
			out.push({ kind: 'source', key, sourceType: 'document', title: str(part.title) ?? 'document', mediaType: str(part.mediaType) });
		} else if (type === 'data-artifacts.artifact') {
			// written by `artifact_create` (plan P45): the card, and the panel opens on it
			const d = isRecord(part.data) ? part.data : {};
			const id = str(d.id);
			if (id) out.push({ kind: 'artifact', key, id, artifactKind: str(d.kind) ?? 'file', title: str(d.title) ?? 'Artifact', version: typeof d.version === 'number' ? d.version : undefined });
		} else if (type === 'step-start') {
			// layout marker only
		} else {
			out.push({ kind: 'unknown', key, type, data: part.data });
		}
	});

	return out;
}

/** True when the message has something a person can see (skips empty streaming shells). */
export function hasVisibleParts(views: PartView[]): boolean {
	return views.some((v) => !(v.kind === 'text' && v.text === '') && v.kind !== 'unknown');
}

/**
 * A user message the system wrote (task, program, routine or rehearsal prompt): the server flags it
 * `metadata.app.instruction`. `fallback` is the old positional guess (the first message of a task
 * session) for history stored before the flag existed; a message the server did flag always wins.
 */
export function isInstructionMessage(message: UIMessage, fallback = false): boolean {
	if (message.role !== 'user') return false;
	const app = (message.metadata as { app?: { instruction?: unknown } } | undefined)?.app;
	return app?.instruction === true || (app?.instruction === undefined && fallback);
}

/** Kind of a kind message (`metadata.eharness.kind`), if any. */
export function messageKind(message: UIMessage): string | undefined {
	const meta = message.metadata as { eharness?: { kind?: unknown } } | undefined;
	return typeof meta?.eharness?.kind === 'string' ? meta.eharness.kind : undefined;
}

/** Whether the turn that wrote this assistant message was stopped (Stop button, shutdown): the text may end mid-sentence. */
export function wasStopped(message: UIMessage): boolean {
	if (message.role !== 'assistant') return false;
	const meta = message.metadata as { eharness?: { stop?: unknown } } | undefined;
	return meta?.eharness?.stop === 'aborted';
}

/**
 * Whether message `i` starts a new author run, so its avatar + name header shows: the first
 * message, or one whose previous message was written by someone else (a user turn or a divider).
 */
export function startsAuthorRun(messages: readonly UIMessage[], i: number): boolean {
	const m = messages[i];
	if (!m || m.role === 'user') return false;
	const prev = messages[i - 1];
	if (!prev) return true;
	return prev.role !== m.role || messageKind(prev) !== undefined;
}
