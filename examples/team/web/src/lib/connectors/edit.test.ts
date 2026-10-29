import { describe, expect, test } from 'bun:test';
import type { FormField, RecordRow } from '../providers/form';
import { editPatch, editValues } from './edit';

const f = (over: Partial<FormField> & { path: string }): FormField => ({
	kind: 'string',
	label: over.path,
	required: false,
	secret: false,
	secretValues: false,
	group: 'endpoint',
	...over
});

// the fields of the custom MCP connector, as GET /connectors lists them
const fields: FormField[] = [
	f({ path: 'url', label: 'Server URL', required: true }),
	f({
		path: 'authMode',
		kind: 'enum',
		widget: 'radio',
		group: 'auth',
		default: 'none',
		options: [
			{ value: 'none', label: 'No authentication' },
			{ value: 'headers', label: 'API key or headers' },
			{ value: 'oauth', label: 'OAuth (sign in)' }
		]
	}),
	f({ path: 'headers', label: 'Headers', kind: 'record', widget: 'keyvalue', secretValues: true, group: 'auth', showWhen: { field: 'authMode', equals: 'headers' } }),
	f({ path: 'reviewToolChanges', label: 'Review tool changes', kind: 'boolean', group: 'advanced', default: false }),
	f({ path: 'oauthClientSecret', label: 'OAuth client secret', secret: true, group: 'auth', showWhen: { field: 'authMode', in: [] } })
];

const stored = {
	url: 'https://mcp.example.com/mcp',
	authMode: 'headers',
	headers: { Authorization: { set: true, hint: '…en-1' } },
	reviewToolChanges: false,
	oauthClientSecret: { set: true }
};

describe('edit a custom connector', () => {
	test('values come from the stored settings; a stored header shows as kept, never its value', () => {
		const v = editValues(fields, stored);
		expect(v.url).toBe('https://mcp.example.com/mcp');
		expect(v.authMode).toBe('headers');
		expect(v.headers).toEqual([{ key: 'Authorization', value: '', stored: true }]);
		expect(v.reviewToolChanges).toBe(false);
	});

	test('a blank stored header is kept (sent as an empty value), new headers are sent, hidden fields are left out', () => {
		const v = editValues(fields, stored);
		v.headers = [...(v.headers as RecordRow[]), { key: 'X-Team', value: 'abc', stored: false }];
		v.reviewToolChanges = true;
		const r = editPatch(fields, v, stored);
		expect(r).toEqual({
			ok: true,
			settings: { url: 'https://mcp.example.com/mcp', authMode: 'headers', headers: { Authorization: '', 'X-Team': 'abc' }, reviewToolChanges: true }
		});
	});

	test('a new URL asks for the stored header values again', () => {
		const v = editValues(fields, stored);
		v.url = 'https://other.example.com/mcp';
		const r = editPatch(fields, v, stored);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.headers).toBe('Type Authorization again: a new URL never receives the stored values.');
		v.headers = [{ key: 'Authorization', value: 'Bearer new', stored: true }];
		expect(editPatch(fields, v, stored)).toMatchObject({ ok: true, settings: { url: 'https://other.example.com/mcp', headers: { Authorization: 'Bearer new' } } });
	});

	test('switching to OAuth sends no headers; the URL can not be emptied', () => {
		const v = editValues(fields, stored);
		v.authMode = 'oauth';
		expect(editPatch(fields, v, stored)).toEqual({ ok: true, settings: { url: 'https://mcp.example.com/mcp', authMode: 'oauth', reviewToolChanges: false } });
		v.url = '  ';
		const r = editPatch(fields, v, stored);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.errors.url).toBe('Enter the server URL');
	});
});
