import { describe, expect, test } from 'bun:test';
import { hasSubSidebar, RAIL, railOf, sectionOf, subSidebarOf } from './sections';

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
		expect(sectionOf('/artifacts')).toBe('artifacts');
		expect(sectionOf('/artifacts/abc')).toBe('artifacts');
		expect(sectionOf('/channels')).toBe('channels');
		expect(sectionOf('/people')).toBe('people');
		expect(sectionOf('/people/abc')).toBe('people');
		expect(sectionOf('/connectors')).toBe('connectors');
		expect(sectionOf('/logs')).toBe('logs');
		expect(sectionOf('/settings')).toBe('settings');
		expect(sectionOf('/filesystem')).toBe('agents');
	});
	test('the agent list and the work menu are the second columns', () => {
		expect(hasSubSidebar('/a/1')).toBe(true);
		expect(subSidebarOf('/a/1')).toBe('agents');
		expect(subSidebarOf('/decisions')).toBe('work');
		expect(subSidebarOf('/tasks/abc')).toBe('work');
		expect(hasSubSidebar('/files')).toBe(false);
	});
	test('the work sections are one rail item', () => {
		expect(RAIL.map((s) => s.id)).toEqual(['agents', 'work', 'files', 'artifacts', 'channels', 'people', 'connectors', 'logs', 'settings']);
		for (const p of ['/tasks', '/briefings', '/decisions/x', '/programs', '/routines']) expect(railOf(p)).toBe('work');
		expect(railOf('/people')).toBe('people');
		expect(railOf('/')).toBe('agents');
	});
});
