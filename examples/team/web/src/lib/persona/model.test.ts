import { describe, expect, test } from 'bun:test';
import type { PersonaVersion } from '../api/client';
import { authorText, diffRows, editOf, formOf, formProblems, proposerText } from './model';

const version: PersonaVersion = {
	id: 'v1',
	agentId: 'a1',
	version: 2,
	identity: { displayName: 'Lead', about: 'Coordinates', language: '', emoji: true },
	voice: 'Warm and short.',
	operatingRules: 'Escalate to the owner.',
	source: 'web',
	authorName: 'the web app',
	authorRole: null,
	authorRef: null,
	reason: null,
	diff: '',
	revertOf: null,
	proposalId: null,
	createdAt: 1
};
const limits = { voice: 6000, operatingRules: 8000, overlay: 1000, reason: 500 };

describe('persona form', () => {
	test('an untouched form sends nothing; a change sends only that field', () => {
		const f = formOf(version);
		expect(editOf(version, f)).toBeUndefined();
		expect(editOf(version, { ...f, voice: 'Formal.' })).toEqual({ voice: 'Formal.' });
		expect(editOf(version, { ...f, displayName: ' Sari ', emoji: false, reason: 'house style' })).toEqual({ identity: { displayName: 'Sari', emoji: false }, reason: 'house style' });
		// a reason alone is not a change
		expect(editOf(version, { ...f, reason: 'x' })).toBeUndefined();
	});

	test('limits are checked on what changed, not on a long migrated text', () => {
		const long = { ...version, voice: 'x'.repeat(7000) };
		expect(formProblems(formOf(long), limits, long)).toEqual({});
		expect(formProblems({ ...formOf(long), voice: 'y'.repeat(7000) }, limits, long).voice).toContain('limit is 6000');
		expect(formProblems({ ...formOf(version), displayName: 'a<b' }, limits, version).displayName).toContain('plain line');
	});

	test('the server diff becomes rows', () => {
		expect(diffRows('Display name:\n- Lead\n+ Sari\n\nVoice and preferences:\n+ Formal.')).toEqual([
			{ kind: 'head', text: 'Display name' },
			{ kind: 'del', text: 'Lead' },
			{ kind: 'add', text: 'Sari' },
			{ kind: 'head', text: 'Voice and preferences' },
			{ kind: 'add', text: 'Formal.' }
		]);
	});

	test('who and from where', () => {
		expect(authorText({ authorName: 'Vian', authorRole: 'admin', source: 'chat' })).toBe('Vian (admin)');
		expect(authorText({ authorName: null, authorRole: null, source: 'migration' })).toBe('Made from the old instructions');
		expect(proposerText({ proposerName: 'Eve', proposerRole: 'member', source: 'chat' })).toBe('Eve (member) · in a chat');
	});
});
