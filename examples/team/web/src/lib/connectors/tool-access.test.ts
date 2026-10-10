import { describe, expect, test } from 'bun:test';
import type { AgentConnector } from '../api/client';
import { AUTO_THRESHOLD, effectiveToolAccess, isOnDemand, thirdPartyToolCount, toolAccessHint } from './tool-access';

const conn = (source: 'builtin' | 'custom', enabled: boolean, modes: Array<'allow' | 'ask' | 'off'>): AgentConnector =>
	({ source, enabled, capabilities: [{ toolModes: modes.map((mode, i) => ({ name: `t${i}`, mode })) }] }) as unknown as AgentConnector;

describe('tool access', () => {
	test('the agent setting wins over the workspace default', () => {
		expect(effectiveToolAccess(null, undefined)).toBe('auto');
		expect(effectiveToolAccess(null, 'on-demand')).toBe('on-demand');
		expect(effectiveToolAccess('auto', 'on-demand')).toBe('auto');
	});
	test('counts enabled third-party tools that are not off', () => {
		const list = [conn('builtin', true, ['allow', 'allow']), conn('custom', true, ['allow', 'off', 'ask']), conn('custom', false, ['allow'])];
		expect(thirdPartyToolCount(list)).toBe(2);
	});
	test('on demand when asked or at the threshold', () => {
		expect(isOnDemand('auto', AUTO_THRESHOLD - 1)).toBe(false);
		expect(isOnDemand('auto', AUTO_THRESHOLD)).toBe(true);
		expect(isOnDemand('on-demand', 0)).toBe(true);
	});
	test('hints name the mode', () => {
		expect(toolAccessHint('auto', 3)).toContain('load up front');
		expect(toolAccessHint('auto', 25)).toContain('25');
		expect(toolAccessHint('on-demand')).toContain('searches');
	});
});
