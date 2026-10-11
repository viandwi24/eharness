import { describe, expect, test } from 'bun:test';
import { hasSubSidebar, sectionOf } from './sections';

describe('sections', () => {
	test('paths map to their section; chats and home are agents', () => {
		expect(sectionOf('/')).toBe('agents');
		expect(sectionOf('/a/123')).toBe('agents');
		expect(sectionOf('/agents/new')).toBe('agents');
		expect(sectionOf('/tasks')).toBe('tasks');
		expect(sectionOf('/tasks/abc')).toBe('tasks');
		expect(sectionOf('/decisions')).toBe('decisions');
		expect(sectionOf('/briefings')).toBe('briefings');
		expect(sectionOf('/programs')).toBe('programs');
		expect(sectionOf('/channels')).toBe('channels');
		expect(sectionOf('/connectors')).toBe('connectors');
		expect(sectionOf('/logs')).toBe('logs');
		expect(sectionOf('/settings')).toBe('settings');
		expect(sectionOf('/filesystem')).toBe('agents');
	});
	test('only the agents section has the agent list column', () => {
		expect(hasSubSidebar('/a/1')).toBe(true);
		expect(hasSubSidebar('/files')).toBe(false);
	});
});
