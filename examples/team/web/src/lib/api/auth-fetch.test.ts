import { describe, expect, test } from 'bun:test';
import { createAuthFetch } from './auth-fetch';

const answer = (status: number, body: unknown) => async () => Response.json(body, { status });

describe('createAuthFetch', () => {
	test('401 AUTH_REQUIRED signs out and still returns the response', async () => {
		let out = 0;
		const f = createAuthFetch(answer(401, { error: { code: 'AUTH_REQUIRED', message: 'Sign in' } }), () => out++);
		const res = await f('/x');
		expect(res.status).toBe(401);
		expect(out).toBe(1);
		expect((await res.json()).error.code).toBe('AUTH_REQUIRED');
	});

	test('a bad bearer token (UNAUTHORIZED) and other statuses do not redirect', async () => {
		let out = 0;
		await createAuthFetch(answer(401, { error: { code: 'UNAUTHORIZED', message: 'x' } }), () => out++)('/x');
		await createAuthFetch(answer(500, { error: { code: 'AUTH_REQUIRED' } }), () => out++)('/x');
		expect(out).toBe(0);
	});

	test('sends same-origin credentials unless the caller overrides them', async () => {
		let seen: RequestInit | undefined;
		const base = (async (_: unknown, init?: RequestInit) => ((seen = init), Response.json({})));
		await createAuthFetch(base, () => {})('/x', { method: 'POST' });
		expect(seen?.credentials).toBe('same-origin');
		expect(seen?.method).toBe('POST');
	});
});
