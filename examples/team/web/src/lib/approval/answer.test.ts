import { describe, expect, test } from 'bun:test';
import { buildAnswer } from './answer.js';

describe('buildAnswer', () => {
	test('approve: plain, or with a note', () => {
		expect(buildAnswer('approve')).toEqual({ approved: true });
		expect(buildAnswer('approve', '  use the staging db ')).toEqual({ approved: true, note: 'use the staging db' });
	});
	test('deny: the text is the reason', () => {
		expect(buildAnswer('deny')).toEqual({ approved: false });
		expect(buildAnswer('deny', ' search docs instead ')).toEqual({ approved: false, reason: 'search docs instead' });
	});
	test('always allow remembers for the session and ignores text', () => {
		expect(buildAnswer('remember', 'ignored')).toEqual({ approved: true, remember: 'session' });
	});
	test('always allow carries the scope when one is picked', () => {
		expect(buildAnswer('remember', '', 'agent')).toEqual({ approved: true, remember: 'session', scope: 'agent' });
		expect(buildAnswer('remember', '', 'all')).toEqual({ approved: true, remember: 'session', scope: 'all' });
	});
});
