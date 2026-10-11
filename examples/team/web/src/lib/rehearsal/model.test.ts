import { describe, expect, test } from 'bun:test';
import {
	activationWarning,
	attachedPath,
	emptySampleForm,
	expectFromForm,
	expectLines,
	fileBytes,
	formFromExpect,
	formFromSample,
	parseBudget,
	rehearsalBadge,
	sampleFromForm,
	summaryText,
	testBadge,
	toolCounts,
	validateSampleForm,
	type TestResult,
	type TestSummary
} from './model';

describe('the sample form', () => {
	test('lines become paths; a worker program always gets a task; "only the sample" is reads: sample', () => {
		const f = { ...emptySampleForm(), copy: '/library/data/\n/library/data/\n  /library/x.md ', onlySample: true };
		expect(sampleFromForm(f, false)).toEqual({ copy: ['/library/data/', '/library/x.md'], files: [], task: null, reads: 'sample' });
		const w = { ...emptySampleForm(), taskTitle: 'Episode 7', taskBrief: 'Short.', taskInputs: '/library/a.md' };
		expect(sampleFromForm(w, true).task).toEqual({ title: 'Episode 7', brief: 'Short.', inputs: ['/library/a.md'] });
		expect(formFromSample(sampleFromForm(w, true))).toMatchObject({ taskTitle: 'Episode 7', taskInputs: '/library/a.md', onlySample: false });
	});

	test('validation names the problem; attached files get a library path', () => {
		expect(validateSampleForm({ ...emptySampleForm(), copy: 'data/x' }, false).copy).toContain('not a library path');
		expect(validateSampleForm({ ...emptySampleForm(), files: [{ path: '', content: 'x' }] }, false).files).toContain('library path');
		expect(validateSampleForm(emptySampleForm(), true).taskTitle).toContain('title');
		expect(validateSampleForm(emptySampleForm(), false)).toEqual({});
		expect(attachedPath('My notes (1).md')).toBe('/library/rehearsal-input/My-notes-1-.md');
	});

	test('budget: empty is the default, above 5 or not a number is refused', () => {
		expect(parseBudget('')).toBeUndefined();
		expect(parseBudget('0.25')).toBe(0.25);
		expect(parseBudget('6')).toBeNull();
		expect(parseBudget('abc')).toBeNull();
	});
});

describe('expectations and results', () => {
	test('the expectation form round-trips and reads as lines', () => {
		const e = { deliverablesPass: true, mustNotCall: ['github_*', 'docs_create_note'], reportStatus: 'done' as const };
		expect(expectFromForm(formFromExpect(e))).toEqual(e);
		expect(expectLines(e)).toEqual(['deliverables must pass', 'must not call github_*', 'must not call docs_create_note', 'report must say done']);
		expect(expectFromForm({ deliverablesPass: false, mustNotCall: '', reportStatus: '' }).reportStatus).toBeNull();
	});

	test('badges: a rehearsal, and a test result that an edit made stale', () => {
		expect(rehearsalBadge({ status: 'running', report: null }).label).toBe('running');
		expect(rehearsalBadge({ status: 'failed', report: null }).variant).toBe('destructive');
		expect(rehearsalBadge({ status: 'done', report: { status: 'partial', summary: '', outputs: [] } }).label).toBe('partial');
		const pass: TestResult = { status: 'pass', rehearsalId: 'r', programFingerprint: 'abc', failures: [], at: 1 };
		expect(testBadge(null, false).label).toBe('not run');
		expect(testBadge(pass, false)).toEqual({ label: 'pass', variant: 'success' });
		expect(testBadge(pass, true).label).toContain('stale');
		expect(testBadge({ ...pass, status: 'fail' }, false).variant).toBe('destructive');
	});

	test('the activation warning appears only for failing cases and never blocks', () => {
		const s = (over: Partial<TestSummary>): TestSummary => ({ total: 3, passing: 3, failing: 0, stale: 0, running: 0, ...over });
		expect(activationWarning(s({}))).toBeNull();
		expect(activationWarning(s({ passing: 0, stale: 3 }))).toBeNull();
		const w = activationWarning(s({ passing: 1, failing: 2, stale: 0 }));
		expect(w).toContain('2 of 3 test cases fail');
		expect(w).toContain('still activate');
		expect(summaryText(s({ passing: 1, failing: 1, stale: 1 }))).toBe('1 of 3 passing, 1 failing, 1 not run since the last edit');
		expect(summaryText(s({ total: 0, passing: 0 }))).toBe('No test cases yet');
	});

	test('tool counts and file bytes', () => {
		expect(toolCounts(['write_file', 'read_file', 'write_file'])).toEqual([{ name: 'write_file', count: 2 }, { name: 'read_file', count: 1 }]);
		expect(fileBytes({ text: 'héllo', base64: null })).toEqual(new TextEncoder().encode('héllo'));
		expect(fileBytes({ text: null, base64: btoa('ab') })).toEqual(new Uint8Array([97, 98]));
		expect(fileBytes({ text: null, base64: null })).toBeNull();
	});
});
