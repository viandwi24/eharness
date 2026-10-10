import { describe, expect, test } from 'bun:test';
import type { ApiClient } from '../api/client';
import { createModesCore, emptyModesState, type ModeState } from './modes-core';

const base: ModeState = {
	mode: 'manual',
	source: 'workspace',
	agentMode: 'inherit',
	workspaceDefault: 'manual',
	available: ['manual', 'auto', 'bypass'],
	autoAvailable: true,
	auto: { paused: false, consecutive: 0, total: 0 }
};

describe('modes store', () => {
	test('load stores the state; set is optimistic and snaps back on a refusal', async () => {
		let fail = false;
		const api = {
			get: async () => base,
			put: async (_p: string, o: { body: { mode: ModeState['mode'] } }) => {
				if (fail) throw new Error('mode auto is not available');
				return { ...base, mode: o.body.mode, source: 'chat' as const };
			}
		} as unknown as ApiClient;
		const core = createModesCore(api, emptyModesState());
		await core.load('a');
		expect(core.state.byAgent.a?.mode).toBe('manual');
		await core.set('a', 'bypass');
		expect(core.state.byAgent.a).toMatchObject({ mode: 'bypass', source: 'chat' });
		fail = true;
		await expect(core.set('a', 'auto')).rejects.toThrow();
		expect(core.state.byAgent.a?.mode).toBe('bypass');
		expect(core.state.error).toContain('not available');
	});
});
