// The rehearsal (test run) forms <-> the API shapes, and what the pages say about results. Pure.
import type { components } from '../api/schema';

export type Rehearsal = components['schemas']['Rehearsal'];
export type RehearsalSample = components['schemas']['RehearsalSample'];
export type RehearsalFile = components['schemas']['RehearsalFile'];
export type TestCase = components['schemas']['TestCase'];
export type TestExpect = components['schemas']['TestExpect'];
export type TestResult = components['schemas']['TestResult'];
export type TestSummary = components['schemas']['TestSummary'];

type Variant = 'success' | 'warning' | 'destructive' | 'info' | 'secondary';
export type Label = { label: string; variant: Variant };

const splitLines = (text: string): string[] => [...new Set(text.split('\n').map((l) => l.trim()).filter(Boolean))];

// --- the sample ---------------------------------------------------------------------------------

/** The sample as the form holds it: text fields, parsed when started. */
export type SampleForm = {
	/** Library files or directories, one per line. */
	copy: string;
	/** Text files the client attached. */
	files: { path: string; content: string }[];
	taskTitle: string;
	taskBrief: string;
	/** Library paths, one per line. */
	taskInputs: string;
	onlySample: boolean;
};

export const emptySampleForm = (): SampleForm => ({ copy: '', files: [], taskTitle: '', taskBrief: '', taskInputs: '', onlySample: false });

export function formFromSample(s: RehearsalSample): SampleForm {
	return {
		copy: s.copy.join('\n'),
		files: s.files.map((f) => ({ ...f })),
		taskTitle: s.task?.title ?? '',
		taskBrief: s.task?.brief ?? '',
		taskInputs: (s.task?.inputs ?? []).join('\n'),
		onlySample: s.reads === 'sample'
	};
}

/** The API body of a sample. `worker`: the program works queued tasks, so the sample needs one. */
export function sampleFromForm(f: SampleForm, worker: boolean): RehearsalSample {
	const title = f.taskTitle.trim();
	return {
		copy: splitLines(f.copy),
		files: f.files.filter((x) => x.path.trim() !== '').map((x) => ({ path: x.path.trim(), content: x.content })),
		task: worker || title !== '' ? { title, brief: f.taskBrief, inputs: splitLines(f.taskInputs) } : null,
		reads: f.onlySample ? 'sample' : 'library'
	};
}

const libraryPathProblem = (path: string): string => (!path.startsWith('/') || path.includes('..') ? `"${path}" is not a library path (it starts with /).` : '');

/** Problems of a sample form, by field. */
export function validateSampleForm(f: SampleForm, worker: boolean): Record<string, string> {
	const errors: Record<string, string> = {};
	const bad = splitLines(f.copy).map(libraryPathProblem).find(Boolean);
	if (bad) errors.copy = bad;
	const file = f.files.find((x) => x.path.trim() !== '' && libraryPathProblem(x.path.trim()));
	if (file) errors.files = libraryPathProblem(file.path.trim());
	if (f.files.some((x) => x.path.trim() === '' && x.content !== '')) errors.files = 'Give every attached file a library path.';
	if (worker && f.taskTitle.trim() === '') errors.taskTitle = 'This program works on a task: give the sample task a title.';
	const input = splitLines(f.taskInputs).map(libraryPathProblem).find(Boolean);
	if (input) errors.taskInputs = input;
	return errors;
}

/** A path for an attached file name: `/library/rehearsal-input/<name>`. */
export function attachedPath(name: string): string {
	return `/library/rehearsal-input/${name.replace(/[^A-Za-z0-9._-]+/g, '-')}`;
}

/** Budget as typed (USD): undefined = the server default. */
export function parseBudget(text: string): number | undefined | null {
	const t = text.trim();
	if (t === '') return undefined;
	const n = Number(t);
	return Number.isFinite(n) && n > 0 && n <= 5 ? n : null;
}

// --- the expectations ---------------------------------------------------------------------------

export type ExpectForm = { deliverablesPass: boolean; mustNotCall: string; reportStatus: '' | NonNullable<TestExpect['reportStatus']> };

export const emptyExpectForm = (): ExpectForm => ({ deliverablesPass: true, mustNotCall: '', reportStatus: '' });

export const formFromExpect = (e: TestExpect): ExpectForm => ({
	deliverablesPass: e.deliverablesPass,
	mustNotCall: e.mustNotCall.join('\n'),
	reportStatus: e.reportStatus ?? ''
});

export const expectFromForm = (f: ExpectForm): TestExpect => ({
	deliverablesPass: f.deliverablesPass,
	mustNotCall: splitLines(f.mustNotCall),
	reportStatus: f.reportStatus === '' ? null : f.reportStatus
});

/** One line per expectation, for the test list. */
export function expectLines(e: TestExpect): string[] {
	return [
		...(e.deliverablesPass ? ['deliverables must pass'] : []),
		...e.mustNotCall.map((t) => `must not call ${t}`),
		...(e.reportStatus === null ? [] : [`report must say ${e.reportStatus.replace('_', ' ')}`])
	];
}

// --- what a result says -------------------------------------------------------------------------

export function rehearsalBadge(r: Pick<Rehearsal, 'status' | 'report'>): Label {
	if (r.status === 'running') return { label: 'running', variant: 'info' };
	if (r.status === 'failed') return { label: 'did not finish', variant: 'destructive' };
	switch (r.report?.status) {
		case 'done':
			return { label: 'done', variant: 'success' };
		case 'partial':
			return { label: 'partial', variant: 'warning' };
		case 'failed':
			return { label: 'reported failure', variant: 'destructive' };
		case 'needs_decision':
			return { label: 'needs a decision', variant: 'info' };
		default:
			return { label: 'no report', variant: 'warning' };
	}
}

/** A test result as the list shows it; `stale`: the program was edited (in a way that matters) since. */
export function testBadge(result: TestResult | null, stale: boolean): Label {
	if (result === null) return { label: 'not run', variant: 'secondary' };
	if (result.status === 'running') return { label: 'running', variant: 'info' };
	if (stale) return { label: 'stale: program edited', variant: 'warning' };
	if (result.status === 'pass') return { label: 'pass', variant: 'success' };
	return { label: result.status === 'error' ? 'error' : 'fail', variant: 'destructive' };
}

export function summaryText(s: TestSummary): string {
	if (s.total === 0) return 'No test cases yet';
	const parts = [`${s.passing} of ${s.total} passing`];
	if (s.failing > 0) parts.push(`${s.failing} failing`);
	if (s.stale > 0) parts.push(`${s.stale} not run since the last edit`);
	if (s.running > 0) parts.push(`${s.running} running`);
	return parts.join(', ');
}

/** The warning shown when a program with failing test cases is activated; null = nothing to say. */
export function activationWarning(s: TestSummary): string | null {
	if (s.failing === 0) return null;
	const stale = s.stale > 0 ? ` ${s.stale} more ${s.stale === 1 ? 'has' : 'have'} not been run since the last edit.` : '';
	return `${s.failing} of ${s.total} test ${s.total === 1 ? 'case fails' : 'cases fail'} for this program as it is now.${stale} You can still activate it.`;
}

/** The run is over: no need to poll any more. */
export const isFinished = (r: Pick<Rehearsal, 'status'>): boolean => r.status !== 'running';

/** The tools a run called, counted: `write_file ×3`. */
export function toolCounts(tools: readonly string[]): { name: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const t of tools) counts.set(t, (counts.get(t) ?? 0) + 1);
	return [...counts].map(([name, count]) => ({ name, count }));
}

export function fileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Short JSON of a recorded tool input. */
export function inputPreview(input: unknown, max = 160): string {
	let text: string;
	try {
		text = JSON.stringify(input) ?? String(input);
	} catch {
		text = String(input);
	}
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The bytes of a produced file for a download; null when its content was not stored. */
export function fileBytes(f: Pick<RehearsalFile, 'text' | 'base64'>): Uint8Array | null {
	if (f.text !== null) return new TextEncoder().encode(f.text);
	if (f.base64 !== null) {
		const bin = atob(f.base64);
		return Uint8Array.from(bin, (c) => c.charCodeAt(0));
	}
	return null;
}
