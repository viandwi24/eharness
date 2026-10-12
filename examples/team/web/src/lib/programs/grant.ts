// The effective grant of an authority (what the server resolved it to), as lines for the editor and
// the decision card. Pure.
import type { components } from '../api/schema';

export type EffectiveGrant = NonNullable<components['schemas']['EffectiveGrant']>;
type GrantedTool = EffectiveGrant['tools'][number];

export type GrantLine = { text: string; tone: 'ok' | 'warn' | 'bad'; detail: string };

const KIND_WORD: Record<GrantedTool['kind'], string> = { read: 'read', write: 'write', destructive: 'delete', external: 'external', unknown: '' };

/** `read` / `write` summary of a tool list: "3 read, 1 write". */
export function kindSummary(tools: readonly GrantedTool[]): string {
	const counts = new Map<string, number>();
	for (const t of tools) {
		if (t.status !== 'granted') continue;
		const k = KIND_WORD[t.kind] || 'other';
		counts.set(k, (counts.get(k) ?? 0) + 1);
	}
	return [...counts].map(([k, n]) => `${n} ${k}`).join(', ');
}

/** One line per connector and per named tool: what the run can really call, and what is refused. */
export function grantLines(grant: EffectiveGrant | null | undefined, skip: ReadonlySet<string> = new Set()): GrantLine[] {
	if (!grant) return [];
	const out: GrantLine[] = [];
	for (const c of grant.connectors) {
		if (c.id === null) {
			if (skip.has(c.requested)) continue;
			out.push({ text: `Connector "${c.requested}" matches nothing`, tone: 'bad', detail: 'No such connector for this agent: it grants no tool.' });
			continue;
		}
		const gated = c.tools.filter((t) => t.status === 'gate');
		const off = c.tools.filter((t) => t.status === 'off');
		const summary = kindSummary(c.tools) || 'no tools';
		const notes: string[] = [];
		if (gated.length) notes.push(`${gated.map((t) => t.name).join(', ')} still ask you (changes of a third-party service)`);
		if (off.length) notes.push(`${off.map((t) => t.name).join(', ')} are switched off`);
		out.push({
			text: `${c.label}: ${summary}`,
			tone: c.tools.some((t) => t.status === 'granted') ? 'ok' : 'warn',
			detail: [c.tools.filter((t) => t.status === 'granted').map((t) => `${t.name} (${KIND_WORD[t.kind] || 'tool'})`).join(', '), ...notes].filter(Boolean).join('. ')
		});
	}
	for (const t of grant.tools) {
		if (t.status !== 'granted' && skip.has(t.name)) continue;
		if (t.status === 'granted') out.push({ text: t.name, tone: 'ok', detail: KIND_WORD[t.kind] ? `${KIND_WORD[t.kind]} tool` : 'tool' });
		else if (t.status === 'off') out.push({ text: t.name, tone: 'warn', detail: 'its connector mode is Off: every call is refused' });
		else if (t.status === 'gate') out.push({ text: t.name, tone: 'warn', detail: 'a change of a third-party service: asks you' });
		else out.push({ text: t.name, tone: 'bad', detail: 'this agent has no such tool' });
	}
	return out;
}

/** The names an error or warning already talks about: warnings start with `<name>:`, errors quote `"<name>"`. */
export function problemNames(warnings: readonly { message: string }[], errors: readonly string[]): { all: Set<string>; fromErrors: Set<string> } {
	const fromErrors = new Set<string>();
	for (const e of errors) for (const m of e.matchAll(/"([^"]+)"/g)) fromErrors.add(m[1] as string);
	const all = new Set(fromErrors);
	for (const w of warnings) {
		const name = w.message.split(':')[0]?.trim();
		if (name && !/\s/.test(name)) all.add(name);
	}
	return { all, fromErrors };
}

/** The warnings an error does not already say (an unknown tool is an error with a suggestion AND a warning). */
export function uniqueWarnings<T extends { message: string }>(warnings: readonly T[], errors: readonly string[]): T[] {
	const { fromErrors } = problemNames([], errors);
	return warnings.filter((w) => !fromErrors.has(w.message.split(':')[0]?.trim() ?? ''));
}
