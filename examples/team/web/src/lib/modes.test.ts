import { describe, expect, test } from 'bun:test';
import { agentChoiceOf, cycleMode, settingsModeOf, storedOfChoice, teamModeOfSettings } from './modes';

describe('modes', () => {
	test('Shift+Tab cycles Manual, Auto, Bypass among the available modes', () => {
		const all = ['manual', 'auto', 'bypass'] as const;
		expect(cycleMode('manual', all)).toBe('auto');
		expect(cycleMode('auto', all)).toBe('bypass');
		expect(cycleMode('bypass', all)).toBe('manual');
		// no classifier: Auto is skipped
		expect(cycleMode('manual', ['manual', 'bypass'])).toBe('bypass');
		// pinned agent: nowhere to go
		expect(cycleMode('manual', ['manual'])).toBe('manual');
		// current mode no longer available (clamped): continue from the start of the ring
		expect(cycleMode('auto', ['manual', 'bypass'])).toBe('manual');
	});

	test('legacy stored values display as the three modes', () => {
		expect(agentChoiceOf('default')).toBe('inherit');
		expect(agentChoiceOf('acceptEdits')).toBe('manual');
		expect(agentChoiceOf('plan')).toBe('manual');
		expect(agentChoiceOf('dontAsk')).toBe('manual');
		expect(agentChoiceOf('auto')).toBe('auto');
		expect(agentChoiceOf('bypassPermissions')).toBe('bypass');
		expect(storedOfChoice('inherit')).toBe('default');
		expect(storedOfChoice('bypass')).toBe('bypassPermissions');
		expect(settingsModeOf('acceptEdits')).toBe('default');
		expect(settingsModeOf('bypassPermissions')).toBe('bypassPermissions');
		expect(teamModeOfSettings('default')).toBe('manual');
	});
});
