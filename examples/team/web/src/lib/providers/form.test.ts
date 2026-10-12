import { describe, expect, test } from 'bun:test';
import { buildSettings, controlOf, envVariables, groupFields, initialValues, isVisible, type FormField, type FormValues } from './form';

const f = (over: Partial<FormField> & { path: string }): FormField => ({
	kind: 'string',
	label: over.path,
	required: false,
	secret: false,
	secretValues: false,
	group: 'endpoint',
	...over
});

const fields: FormField[] = [
	f({ path: 'mode', kind: 'enum', widget: 'radio', group: 'auth', options: [{ value: 'key', label: 'Key' }, { value: 'oauth', label: 'OAuth' }], default: 'key' }),
	f({ path: 'apiKey', label: 'API key', required: true, secret: true, group: 'auth', showWhen: { field: 'mode', equals: 'key' } }),
	f({ path: 'baseURL', label: 'Base URL' }),
	f({ path: 'retries', kind: 'integer', label: 'Retries', min: 0, max: 5 }),
	f({ path: 'headers', kind: 'record', widget: 'keyvalue', secretValues: true, label: 'Headers', group: 'advanced' }),
	f({ path: 'nested.flag', kind: 'boolean', label: 'Flag', group: 'advanced' })
];

describe('field helpers', () => {
	test('controls follow widget and kind', () => {
		expect(controlOf(fields[0] as FormField)).toBe('radio');
		expect(controlOf(fields[1] as FormField)).toBe('password');
		expect(controlOf(fields[3] as FormField)).toBe('number');
		expect(controlOf(fields[4] as FormField)).toBe('keyvalue');
		expect(controlOf(fields[5] as FormField)).toBe('switch');
		expect(controlOf(f({ path: 'x', kind: 'enum' }))).toBe('select');
	});

	test('groups keep the display order and drop empty ones', () => {
		expect(groupFields(fields).map((g) => [g.group, g.fields.length])).toEqual([['auth', 2], ['endpoint', 2], ['advanced', 2]]);
		expect(groupFields(fields.filter((x) => x.group === 'auth')).map((g) => g.group)).toEqual(['auth']);
	});

	test('showWhen: equals, in and truthy', () => {
		const values: FormValues = { mode: 'key', on: true, empty: '' };
		expect(isVisible(fields[1] as FormField, values)).toBe(true);
		expect(isVisible(fields[1] as FormField, { mode: 'oauth' })).toBe(false);
		expect(isVisible(f({ path: 'a', showWhen: { field: 'mode', in: ['x', 'key'] } }), values)).toBe(true);
		expect(isVisible(f({ path: 'a', showWhen: { field: 'on' } }), values)).toBe(true);
		expect(isVisible(f({ path: 'a', showWhen: { field: 'empty' } }), values)).toBe(false);
	});
});

describe('initial values', () => {
	test('defaults on create; secrets never prefilled', () => {
		const v = initialValues(fields);
		expect(v).toMatchObject({ mode: 'key', apiKey: '', baseURL: '', retries: '', headers: [], 'nested.flag': false });
	});

	test('from a redacted profile: values, header rows with stored secrets', () => {
		const v = initialValues(fields, {
			apiKey: { set: true, hint: '…1234' },
			baseURL: 'https://proxy.example/v1',
			retries: 2,
			headers: { 'X-Team': { set: true, hint: '…9999' } },
			nested: { flag: true }
		});
		expect(v.apiKey).toBe('');
		expect(v.baseURL).toBe('https://proxy.example/v1');
		expect(v.retries).toBe('2');
		expect(v.headers).toEqual([{ key: 'X-Team', value: '', stored: true }]);
		expect(v['nested.flag']).toBe(true);
	});
});

describe('build settings', () => {
	test('create: requires the secret, builds nested objects, skips empty optionals', () => {
		const bad = buildSettings(fields, initialValues(fields), undefined, 'create');
		expect(bad).toEqual({ ok: false, errors: { apiKey: 'API key is required' } });
		const v = initialValues(fields);
		v.apiKey = ' sk-1 ';
		v['nested.flag'] = true;
		v.retries = '3';
		v.headers = [{ key: 'X-A', value: 'a', stored: false }, { key: '', value: '', stored: false }];
		const ok = buildSettings(fields, v, undefined, 'create');
		expect(ok).toEqual({ ok: true, settings: { mode: 'key', apiKey: ' sk-1 ', retries: 3, headers: { 'X-A': 'a' }, nested: { flag: true } } });
	});

	test('edit: untouched secrets are left out, cleared optionals become null, stored header values are kept', () => {
		const current = { apiKey: { set: true }, baseURL: 'https://x.test', headers: { A: { set: true, hint: '…1' } } };
		const v = initialValues(fields, current);
		v.baseURL = '';
		const r = buildSettings(fields, v, current, 'edit');
		expect(r).toEqual({ ok: true, settings: { mode: 'key', baseURL: null, headers: { A: '' }, 'nested': { flag: false } } });
		// removing the last header removes the field
		v.headers = [];
		const removed = buildSettings(fields, v, current, 'edit');
		expect(removed.ok && removed.settings.headers).toBeNull();
		// a new secret value replaces
		v.apiKey = 'sk-new';
		const replaced = buildSettings(fields, v, current, 'edit');
		expect(replaced.ok && replaced.settings.apiKey).toBe('sk-new');
	});

	test('hidden fields are skipped (no secret required while the mode hides it)', () => {
		const v = initialValues(fields);
		v.mode = 'oauth';
		expect(buildSettings(fields, v, undefined, 'create')).toEqual({ ok: true, settings: { mode: 'oauth', 'nested': { flag: false } } });
	});

	test('a number input holds a number (or null when empty): it is kept, not dropped', () => {
		const v = initialValues(fields);
		v.apiKey = 'k';
		v.retries = 3 as never;
		const r = buildSettings(fields, v, undefined, 'create');
		expect(r.ok && r.settings.retries).toBe(3);
		v.retries = null as never;
		const r2 = buildSettings(fields, v, undefined, 'create');
		expect(r2.ok && 'retries' in r2.settings).toBe(false);
		v.retries = 9 as never;
		const r3 = buildSettings(fields, v, undefined, 'create');
		expect(r3.ok === false && r3.errors.retries).toContain('at most 5');
	});

	test('validation: numbers, duplicates, missing header values', () => {
		const v = initialValues(fields);
		v.apiKey = 'k';
		v.retries = '9';
		v.headers = [{ key: 'A', value: '1', stored: false }, { key: 'A', value: '2', stored: false }];
		const r = buildSettings(fields, v, undefined, 'create');
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors.retries).toContain('at most 5');
		expect(r.errors.headers).toContain('twice');
		v.retries = '1.5';
		v.headers = [{ key: 'A', value: '', stored: false }];
		const r2 = buildSettings(fields, v, undefined, 'create');
		expect(r2.ok === false && r2.errors.retries).toContain('whole number');
		expect(r2.ok === false && r2.errors.headers).toContain('needs a value');
	});
});

describe('env hints', () => {
	test('lists the variables that supplied an env profile', () => {
		expect(envVariables({ apiKey: 'OPENROUTER_API_KEY', baseURL: 'OPENROUTER_BASE_URL' }, { apiKey: { set: true } })).toEqual(['OPENROUTER_API_KEY']);
	});
});
