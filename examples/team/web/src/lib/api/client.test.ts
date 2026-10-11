import { describe, expect, test } from 'bun:test';
import { ApiError, createClient, fieldErrors, toApiError } from './client';
import { createBackoff } from './backoff';

const json = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('toApiError', () => {
	test('maps the server envelope', () => {
		const e = toApiError(409, { error: { code: 'SLUG_TAKEN', message: 'slug in use', details: [1] } });
		expect(e).toBeInstanceOf(ApiError);
		expect([e.status, e.code, e.message, e.details]).toEqual([409, 'SLUG_TAKEN', 'slug in use', [1]]);
	});
	test('falls back for unknown bodies', () => {
		expect(toApiError(500, '<html>').code).toBe('HTTP_ERROR');
		expect(toApiError(401, undefined).code).toBe('UNAUTHORIZED');
	});
});

describe('fieldErrors', () => {
	test('reads zod issues from VALIDATION_ERROR details', () => {
		const e = new ApiError(400, 'VALIDATION_ERROR', 'x', [
			{ path: ['name'], message: 'too short' },
			{ path: ['name'], message: 'ignored' },
			{ path: [], message: 'body' }
		]);
		expect(fieldErrors(e)).toEqual({ name: 'too short', _: 'body' });
		expect(fieldErrors(new Error('x'))).toEqual({});
	});
});

describe('client', () => {
	test('sends bearer token, fills path params and parses errors', async () => {
		const seen: { url: string; init: RequestInit }[] = [];
		const api = createClient({
			baseUrl: '/api/',
			getToken: () => 't0k',
			fetch: (async (url: string, init: RequestInit) => {
				seen.push({ url, init });
				return init.method === 'GET'
					? json(200, { id: 'a' })
					: json(404, { error: { code: 'NOT_FOUND', message: 'agent not found' } });
			}) as unknown as typeof fetch
		});
		await api.get('/agents/{id}', { params: { id: 'a b' } });
		expect(seen[0]?.url).toBe('/api/agents/a%20b');
		expect((seen[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer t0k');
		const err = await api.delete('/agents/{id}', { params: { id: 'x' } }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).code).toBe('NOT_FOUND');
	});
	test('network failure becomes NETWORK_ERROR', async () => {
		const api = createClient({
			baseUrl: '',
			fetch: (async () => {
				throw new TypeError('fail');
			}) as unknown as typeof fetch
		});
		expect(((await api.get('/agents').catch((e: unknown) => e)) as ApiError).code).toBe('NETWORK_ERROR');
	});
	test('an HTML answer is a bad response, and a failing GET stops going out after a few tries', async () => {
		let calls = 0;
		const reachability = createBackoff();
		const api = createClient({
			baseUrl: '',
			reachability,
			fetch: (async () => {
				calls++;
				return new Response('<!doctype html><title>x</title>', { status: 200, headers: { 'content-type': 'text/html' } });
			}) as unknown as typeof fetch
		});
		const first = (await api.get('/agents').catch((e: unknown) => e)) as ApiError;
		expect(first.code).toBe('BAD_RESPONSE');
		for (let i = 0; i < 50; i++) await api.get('/agents').catch(() => undefined);
		expect(calls).toBeLessThan(5);
		expect(reachability.down).toBe(true);
	});
});
