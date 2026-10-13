import { describe, expect, test } from 'bun:test';
import { isAuthRequired, isLoginPath, loginRedirect, mustSignIn, parseSession, safeNext } from './auth';

describe('login redirect', () => {
	test('keeps the current path as next, never loops on the login page', () => {
		expect(loginRedirect('/tasks?x=1')).toBe('/login?next=%2Ftasks%3Fx%3D1');
		expect(loginRedirect('/')).toBe('/login');
		expect(loginRedirect('/login')).toBeNull();
		expect(loginRedirect('/login?next=%2Ftasks')).toBeNull();
		expect(isLoginPath('/loginx')).toBe(false);
	});

	test('next is only ever a same-origin path', () => {
		expect(safeNext('/a/lead?t=1')).toBe('/a/lead?t=1');
		expect(safeNext('https://evil.example')).toBe('/');
		expect(safeNext('//evil.example')).toBe('/');
		expect(safeNext('/\\evil.example')).toBe('/');
		expect(safeNext('/login')).toBe('/');
		expect(safeNext(null)).toBe('/');
	});
});

describe('AUTH_REQUIRED', () => {
	test('only a 401 with that code is a sign-in problem, not a bad token', () => {
		expect(isAuthRequired(401, { error: { code: 'AUTH_REQUIRED', message: 'x' } })).toBe(true);
		expect(isAuthRequired(401, { error: { code: 'UNAUTHORIZED', message: 'x' } })).toBe(false);
		expect(isAuthRequired(403, { error: { code: 'AUTH_REQUIRED' } })).toBe(false);
		expect(isAuthRequired(401, undefined)).toBe(false);
	});
});

describe('session probe', () => {
	test('parses the answer; garbage means no login', () => {
		expect(mustSignIn(parseSession({ required: true, authenticated: false }))).toBe(true);
		expect(mustSignIn(parseSession({ required: true, authenticated: true }))).toBe(false);
		expect(mustSignIn(parseSession({ required: false, authenticated: true }))).toBe(false);
		expect(mustSignIn(parseSession('<html>'))).toBe(false);
	});
});
