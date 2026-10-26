// Pure helpers of the Scripts pages: status labels, manifest checks, run formatting, the starting
// template and the editor's tab key. No Svelte, no fetch.
import type { components } from '../api/schema';

export type Script = components['schemas']['Script'];
export type ScriptVersion = components['schemas']['ScriptVersion'];
export type ScriptVersionMeta = components['schemas']['ScriptVersionList']['versions'][number];
export type ScriptDetail = components['schemas']['ScriptDetail'];
export type ScriptRun = components['schemas']['ScriptRun'];
export type HostCall = components['schemas']['ScriptHostCall'];
export type ScriptTypes = components['schemas']['ScriptTypes'];
export type DryRunResult = components['schemas']['ScriptDryRunResult'];
export type Manifest = Record<string, unknown>;

export type Tone = 'success' | 'secondary' | 'warning' | 'destructive' | 'info';

/** Lowercase letters, digits and -, starting with a letter (the server's rule). */
export const SCRIPT_NAME = /^[a-z][a-z0-9-]{0,62}$/;

/** The status badge: draft, active vN, or off (with the reason it was switched off). */
export function statusLabel(s: Pick<Script, 'status' | 'activeVersion' | 'disabledReason'>): { label: string; tone: Tone; title?: string } {
	if (s.status === 'active') return { label: `active v${s.activeVersion ?? '?'}`, tone: 'success' };
	if (s.status === 'disabled') {
		const reason = s.disabledReason && s.disabledReason !== 'manual' ? s.disabledReason : '';
		return { label: reason ? `off: ${reason}` : 'off', tone: reason ? 'warning' : 'secondary', ...(reason ? { title: reason } : {}) };
	}
	return { label: 'draft', tone: 'secondary' };
}

/** The approval badge, when there is something to say. */
export function approvalLabel(s: Pick<Script, 'approval'>): { label: string; tone: Tone } | null {
	const a = s.approval;
	if (a.state === 'pending') return { label: `v${a.version ?? '?'} waits for approval`, tone: 'info' };
	if (a.state === 'rejected') return { label: `v${a.version ?? '?'} rejected`, tone: 'destructive' };
	return null;
}

/** Activating makes sense when the script is not running the latest version. */
export const canActivate = (s: Pick<Script, 'status' | 'activeVersion' | 'latestVersion'>): boolean => s.status !== 'active' || s.activeVersion !== s.latestVersion;

/** Markers of a version in the list: which one runs, which one was approved or waits. */
export function versionMarkers(version: number, s: Pick<Script, 'status' | 'activeVersion' | 'approval'>): { label: string; tone: Tone }[] {
	const out: { label: string; tone: Tone }[] = [];
	if (s.activeVersion === version) out.push({ label: s.status === 'active' ? 'active' : 'last active', tone: s.status === 'active' ? 'success' : 'secondary' });
	if (s.approval.version === version) {
		if (s.approval.state === 'pending') out.push({ label: 'waits for approval', tone: 'info' });
		else if (s.approval.state === 'approved') out.push({ label: 'approved', tone: 'secondary' });
		else if (s.approval.state === 'rejected') out.push({ label: 'rejected', tone: 'destructive' });
	}
	return out;
}

/** Badge tone of a run outcome. */
export function outcomeTone(outcome: string): Tone {
	if (outcome === 'ok') return 'success';
	if (outcome === 'skipped') return 'secondary';
	return 'destructive';
}

export function formatDuration(ms: number | null | undefined): string {
	if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
	if (ms < 1000) return `${Math.round(ms)} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
	const sec = Math.round((ms % 60_000) / 1000);
	return `${Math.floor(ms / 60_000)} min${sec ? ` ${sec} s` : ''}`;
}

/** Pretty JSON for a trace; `undefined` and unserialisable values become text. */
export function formatJson(v: unknown): string {
	if (v === undefined) return 'undefined';
	try {
		return JSON.stringify(v, null, 2) ?? String(v);
	} catch {
		return String(v);
	}
}

/** One-line JSON, cut to `max` characters. */
export function shortJson(v: unknown, max = 160): string {
	let s: string;
	try {
		s = JSON.stringify(v) ?? 'undefined';
	} catch {
		s = String(v);
	}
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** A ctx call of a trace: a dry run records side effects without doing them ("would …"). */
export function callLabel(c: Pick<HostCall, 'method' | 'dryRun'>): string {
	return c.dryRun ? `would ${c.method}` : c.method;
}

/** A per-trigger answer of a dry run, for people. */
export function triggerLabel(t: string, i: number): string {
	return `Chat trigger ${i + 1}: ${t === 'match' ? 'would start' : t}`;
}

// ------------------------------------------------------------ manifest

export type ManifestCheck = { ok: true; manifest: Manifest } | { ok: false; error: string };

const TRIGGER_KINDS = ['channel', 'schedule', 'table'];

/** Line and column of a character offset (1-based). */
function lineCol(text: string, offset: number): string {
	const before = text.slice(0, offset);
	const line = before.split('\n').length;
	const col = offset - before.lastIndexOf('\n');
	return `line ${line}, column ${col}`;
}

/**
 * Parse and roughly check the manifest editor's text. The server checks every field; this catches
 * broken JSON and the wrong top-level shape before a round trip.
 */
export function checkManifest(text: string): ManifestCheck {
	if (!text.trim()) return { ok: false, error: 'The manifest is empty. It needs at least { "triggers": [], "grants": {} }.' };
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		const at = /position (\d+)/.exec(msg);
		return { ok: false, error: `Not valid JSON${at ? ` (${lineCol(text, Number(at[1]))})` : ''}: ${msg.replace(/^JSON Parse error: /, '')}` };
	}
	if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'The manifest must be a JSON object.' };
	const m = v as Manifest;
	if (m.triggers !== undefined) {
		if (!Array.isArray(m.triggers)) return { ok: false, error: '"triggers" must be a list.' };
		for (const [i, t] of m.triggers.entries()) {
			const kind = t && typeof t === 'object' ? (t as { kind?: unknown }).kind : undefined;
			if (typeof kind !== 'string' || !TRIGGER_KINDS.includes(kind)) return { ok: false, error: `Trigger ${i + 1}: "kind" must be channel, schedule or table.` };
		}
	}
	if (m.grants !== undefined && (!m.grants || typeof m.grants !== 'object' || Array.isArray(m.grants))) return { ok: false, error: '"grants" must be an object.' };
	for (const k of ['cooldownSec', 'maxRunsPerHour'] as const) {
		if (m[k] !== undefined && (typeof m[k] !== 'number' || (m[k] as number) < 0)) return { ok: false, error: `"${k}" must be a number, 0 or more.` };
	}
	return { ok: true, manifest: m };
}

/** One short line per trigger, for headers. */
export function triggerSummary(manifest: Manifest | undefined): string[] {
	const list = Array.isArray(manifest?.triggers) ? (manifest.triggers as Record<string, unknown>[]) : [];
	return list.map((t) => {
		const arr = (k: string): string[] => (Array.isArray(t[k]) ? (t[k] as unknown[]).map(String) : []);
		if (t.kind === 'channel') {
			const events = arr('events');
			const chats = arr('chats');
			const words = arr('textContains');
			return `chat ${events.length ? events.join(', ') : 'events'}${chats.length ? ` in ${chats.join(', ')}` : ''}${words.length ? ` with "${words.join('" or "')}"` : ''}`;
		}
		if (t.kind === 'schedule') {
			const s = (t.spec ?? {}) as Record<string, unknown>;
			if (s.kind === 'cron') return `cron ${String(s.expr ?? '?')}${s.timezone ? ` (${String(s.timezone)})` : ''}`;
			if (s.kind === 'every') return `every ${formatDuration(Number(s.everyMs))}`;
			if (s.kind === 'at') return `once at ${String(s.at ?? '?')}`;
			return 'schedule';
		}
		if (t.kind === 'table') return `table ${String(t.table ?? '?')} ${arr('events').join(', ')}`.trim();
		return String(t.kind ?? '?');
	});
}

// ------------------------------------------------------------ template and samples

/** Starting source of a new script: the "halo" forwarder. */
export const TEMPLATE_SOURCE = `// Runs when a chat message matches a trigger of the manifest.
// \`event\` is the trigger event; \`ctx\` is the only way to reach the system (see API reference).
export default async function (event: any, ctx: ScriptContext) {
  const text = String(event.text ?? '');
  ctx.log('message from', event.actor?.name ?? event.actor?.id, 'in', event.chat?.title);

  // To forward it, add the target chat to grants.send in the manifest, then:
  // await ctx.channels.send({ connection: 'CONNECTION_ID', chat: 'Group B', text: \`\${event.actor?.name ?? 'someone'}: \${text}\` });

  return { seen: text.length };
}
`;

export const TEMPLATE_MANIFEST: Manifest = {
	triggers: [{ kind: 'channel', events: ['message.created'], textContains: ['halo'] }],
	grants: { send: [], reply: false, libraryRead: [], libraryWrite: [], tablesRead: [], tablesWrite: [], http: [], wake: [], programs: [] },
	cooldownSec: 0,
	maxRunsPerHour: 60
};

/** The synthetic event a dry run starts from. */
export const SAMPLE_EVENT = {
	type: 'message.created',
	connectionId: 'CONNECTION_ID',
	chat: { title: 'Ops', nativeId: '-1001234567890' },
	actor: { id: '1', name: 'Ana', role: 'member' },
	text: 'halo everyone'
};

export const toJsonText = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

// ------------------------------------------------------------ editor

export type EditResult = { value: string; start: number; end: number };

const INDENT = '  ';

/**
 * Tab and Shift+Tab in a code textarea: indent the cursor (or every selected line) by two spaces,
 * or take two spaces away.
 */
export function tabEdit(value: string, start: number, end: number, outdent: boolean): EditResult {
	const multi = value.slice(start, end).includes('\n');
	if (!outdent && !multi) {
		return { value: value.slice(0, start) + INDENT + value.slice(end), start: start + INDENT.length, end: start + INDENT.length };
	}
	const lineStart = value.lastIndexOf('\n', start - 1) + 1;
	// a selection ending right after a newline does not include the next line
	const stop = end > start && value[end - 1] === '\n' ? end - 1 : end;
	const block = value.slice(lineStart, stop);
	const lines = block.split('\n');
	let first = 0;
	let total = 0;
	const changed = lines.map((l, i) => {
		if (outdent) {
			const n = l.startsWith(INDENT) ? 2 : l.startsWith(' ') || l.startsWith('\t') ? 1 : 0;
			if (i === 0) first = -n;
			total -= n;
			return l.slice(n);
		}
		if (i === 0) first = INDENT.length;
		total += INDENT.length;
		return INDENT + l;
	});
	const next = value.slice(0, lineStart) + changed.join('\n') + value.slice(stop);
	const newStart = Math.max(lineStart, start + first);
	return { value: next, start: newStart, end: Math.max(newStart, end + total) };
}

/** Recorded channel event of the picker, as one line. */
export function eventLine(e: { summary: string; chat?: { title: string } | undefined; type: string }): string {
	return e.summary || `${e.type}${e.chat ? ` in ${e.chat.title}` : ''}`;
}
