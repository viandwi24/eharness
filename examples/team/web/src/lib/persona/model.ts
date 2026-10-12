// The persona panel's view model: the form, what a save sends, the diff text of a version. Pure.
import type { PersonaProposal, PersonaState, PersonaVersion } from '../api/client';

export type PersonaForm = {
	displayName: string;
	about: string;
	language: string;
	emoji: boolean;
	voice: string;
	operatingRules: string;
	reason: string;
};

export type PersonaLimits = PersonaState['limits'];

export const formOf = (v: PersonaVersion): PersonaForm => ({
	displayName: v.identity.displayName,
	about: v.identity.about,
	language: v.identity.language,
	emoji: v.identity.emoji,
	voice: v.voice,
	operatingRules: v.operatingRules,
	reason: ''
});

/** What a save sends: only what the form changed; undefined when nothing did. */
export function editOf(v: PersonaVersion, f: PersonaForm) {
	const identity: Partial<PersonaVersion['identity']> = {};
	if (f.displayName.trim() !== v.identity.displayName) identity.displayName = f.displayName.trim();
	if (f.about.trim() !== v.identity.about) identity.about = f.about.trim();
	if (f.language.trim() !== v.identity.language) identity.language = f.language.trim();
	if (f.emoji !== v.identity.emoji) identity.emoji = f.emoji;
	const body = {
		...(Object.keys(identity).length > 0 ? { identity } : {}),
		...(f.voice !== v.voice ? { voice: f.voice } : {}),
		...(f.operatingRules !== v.operatingRules ? { operatingRules: f.operatingRules } : {}),
		...(f.reason.trim() === '' ? {} : { reason: f.reason.trim() })
	};
	return 'identity' in body || 'voice' in body || 'operatingRules' in body ? body : undefined;
}

/** Problems of a form as typed (the server checks the same limits and the injection patterns). */
export function formProblems(f: PersonaForm, limits: PersonaLimits, unchanged: Pick<PersonaVersion, 'voice' | 'operatingRules'>): Record<string, string> {
	const out: Record<string, string> = {};
	// a persona migrated from old instructions may be longer than a new one can be: only an edit is checked
	if (f.voice !== unchanged.voice && f.voice.length > limits.voice) out.voice = `The voice text is ${f.voice.length} characters; the limit is ${limits.voice}.`;
	if (f.operatingRules !== unchanged.operatingRules && f.operatingRules.length > limits.operatingRules) out.operatingRules = `The operating rules are ${f.operatingRules.length} characters; the limit is ${limits.operatingRules}.`;
	if (f.displayName.length > 60) out.displayName = 'At most 60 characters.';
	if (/[\n<>]/.test(f.displayName)) out.displayName = 'One plain line, without < or >.';
	if (f.about.length > 300) out.about = 'At most 300 characters.';
	if (f.language.length > 40) out.language = 'At most 40 characters.';
	return out;
}

export type DiffRow = { kind: 'add' | 'del' | 'head'; text: string };

/** The server's diff text as rows: `+ ` and `- ` lines, and the headings between them. */
export function diffRows(diff: string): DiffRow[] {
	return diff
		.split('\n')
		.filter((l) => l.trim() !== '')
		.map((l): DiffRow => (l.startsWith('+ ') ? { kind: 'add', text: l.slice(2) } : l.startsWith('- ') ? { kind: 'del', text: l.slice(2) } : { kind: 'head', text: l.replace(/:$/, '') }));
}

export const SOURCE_LABEL: Record<PersonaVersion['source'], string> = {
	web: 'Web',
	chat: 'Chat',
	migration: 'From the old instructions',
	revert: 'Revert'
};

/** Who made a version, in words. */
export function authorText(v: Pick<PersonaVersion, 'authorName' | 'authorRole' | 'source'>): string {
	if (v.source === 'migration') return 'Made from the old instructions';
	const name = v.authorName ?? 'Someone on the team';
	return v.authorRole ? `${name} (${v.authorRole})` : name;
}

/** Who asked for a proposal, and from where. */
export function proposerText(p: Pick<PersonaProposal, 'proposerName' | 'proposerRole' | 'source'>): string {
	const name = p.proposerName ?? 'Somebody';
	return `${name}${p.proposerRole ? ` (${p.proposerRole})` : ''} · ${p.source === 'chat' ? 'in a chat' : 'in the web app'}`;
}
