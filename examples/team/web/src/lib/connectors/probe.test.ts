import { describe, expect, test } from 'bun:test';
import { connectionsToProbe } from './core';

describe('connectionsToProbe', () => {
	test('only connections that claim to be connected and are on', () => {
		const list = [
			{ id: 'a', enabled: true, status: 'connected' },
			{ id: 'b', enabled: true, status: 'error' },
			{ id: 'c', enabled: false, status: 'connected' },
			{ id: 'd', enabled: true, status: 'needs-auth' },
			{ id: 'e', enabled: true, status: undefined }
		] as never;
		expect(connectionsToProbe(list)).toEqual(['a', 'e']);
	});
});
