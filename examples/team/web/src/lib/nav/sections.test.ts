import { describe, expect, test } from 'bun:test';
import { GROUPS, hasSubSidebar, RAIL, railOf, SECTIONS, sectionOf, sectionsOf, subSidebarOf } from './sections';

describe('sections', () => {
	test('paths map to their section; chats and home are agents', () => {
		expect(sectionOf('/')).toBe('agents');
		expect(sectionOf('/a/123')).toBe('agents');
		expect(sectionOf('/agents/new')).toBe('agents');
		expect(sectionOf('/tasks')).toBe('tasks');
		expect(sectionOf('/tasks/abc')).toBe('tasks');
		expect(sectionOf('/decisions')).toBe('decisions');
		expect(sectionOf('/programs')).toBe('programs');
		expect(sectionOf('/artifacts')).toBe('artifacts');
		expect(sectionOf('/artifacts/abc')).toBe('artifacts');
		expect(sectionOf('/tables')).toBe('tables');
		expect(sectionOf('/tables/members')).toBe('tables');
		expect(sectionOf('/scripts')).toBe('scripts');
		expect(sectionOf('/scripts/halo-forwarder')).toBe('scripts');
		expect(sectionOf('/channels')).toBe('channels');
		expect(sectionOf('/people')).toBe('people');
		expect(sectionOf('/people/abc')).toBe('people');
		expect(sectionOf('/connectors')).toBe('connectors');
		expect(sectionOf('/browser/abc')).toBe('browser');
		expect(sectionOf('/developers')).toBe('developers');
		expect(sectionOf('/logs')).toBe('logs');
		expect(sectionOf('/audit')).toBe('audit');
		expect(sectionOf('/attention')).toBe('attention');
		expect(sectionOf('/settings')).toBe('settings');
		expect(sectionOf('/filesystem')).toBe('agents');
	});
	test('the agent list and the menus of groups are the second columns', () => {
		expect(hasSubSidebar('/a/1')).toBe(true);
		expect(subSidebarOf('/a/1')).toBe('agents');
		expect(subSidebarOf('/decisions')).toBe('work');
		expect(subSidebarOf('/tasks/abc')).toBe('work');
		expect(subSidebarOf('/files')).toBe('files');
		expect(subSidebarOf('/artifacts/x')).toBe('files');
		expect(subSidebarOf('/people')).toBe('channels');
		expect(subSidebarOf('/tables')).toBe('tools');
		expect(subSidebarOf('/developers')).toBe('settings');
		expect(hasSubSidebar('/connectors')).toBe(false);
		expect(hasSubSidebar('/logs')).toBe(false);
	});
	test('the rail has eight groups; every section is in exactly one', () => {
		expect(RAIL.map((s) => s.id)).toEqual(['agents', 'work', 'files', 'connectors', 'channels', 'tools', 'logs', 'settings']);
		for (const p of ['/tasks', '/decisions/x', '/programs', '/routines', '/attention', '/audit']) expect(railOf(p)).toBe('work');
		expect(railOf('/artifacts')).toBe('files');
		expect(railOf('/people')).toBe('channels');
		expect(railOf('/scripts/x')).toBe('tools');
		expect(railOf('/browser/x')).toBe('tools');
		expect(railOf('/developers')).toBe('settings');
		expect(railOf('/')).toBe('agents');
		const all = GROUPS.flatMap((g) => g.sections);
		expect(new Set(all).size).toBe(all.length);
		expect([...all].sort()).toEqual(SECTIONS.map((s) => s.id).sort());
	});
	test('a rail item opens the home section of its group', () => {
		expect(RAIL.find((r) => r.id === 'work')?.href).toBe('/tasks');
		expect(RAIL.find((r) => r.id === 'tools')?.href).toBe('/tables');
		expect(sectionsOf('settings').map((s) => s.label)).toEqual(['Settings', 'Developers']);
	});
});
