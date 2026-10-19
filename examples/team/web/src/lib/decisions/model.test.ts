import { describe, expect, test } from 'bun:test';
import { emptyProgramForm } from '../programs/form';
import { answerToast, authorityLines, decisionText, type Decision, editBody, grantLines, groupDecisions, changeRows, addedAuthorityLines, optionsOf, outcomeLine, statusBadge, triggerLine } from './model';

const authority = { tools: ['web_fetch'], connectors: ['github'], read: ['/library/in/**'], write: ['/library/out/**'] };
const program = {
	agentId: 'a',
	name: 'Scripts',
	brief: 'b',
	authority,
	gates: [],
	escalation: '',
	forbidden: [],
	budget: { perRunUsd: 2, perDayUsd: null },
	trigger: { kind: 'manual' as const },
	report: 'task' as const
};
const base = { id: 'd', status: 'open' as const, title: 'T', body: '', agentId: 'a', sessionId: 's', programId: null, waitId: null, decidedBy: null, decidedAt: null, decisionNote: null, outcome: null, createdAt: 1 };
const proposal = (runOnce: boolean): Decision => ({ ...base, kind: 'proposal', payload: { program, runOnce } });
const escalation = (options: string[] = []): Decision => ({ ...base, kind: 'escalation', payload: { question: 'q', options, source: 'agent' } });
const amendment: Decision = { ...base, kind: 'amendment', payload: { authority, why: 'w' } };

const change: Decision = {
	...base,
	kind: 'change',
	programId: 'p1',
	payload: {
		programId: 'p1',
		programName: 'Weekly review',
		before: { authority: { tools: ['read_file'], connectors: [], read: ['/library/**'], write: [] }, gates: [] },
		patch: { authority: { tools: ['read_file', 'web_fetch'], connectors: [], read: ['/library/**'], write: [] }, gates: ['sending email'] },
		diff: [
			{ field: 'authority', label: 'Authority', before: 'use read_file; read /library/**', after: 'use read_file; use web_fetch; read /library/**' },
			{ field: 'gates', label: 'Still asks the client', before: '(none)', after: 'sending email' }
		]
	}
};

describe('change decisions', () => {
	test('the diff is one row per field, before and after', () => {
		expect(changeRows((change as Extract<Decision, { kind: 'change' }>).payload)).toEqual([
			{ label: 'Authority', before: 'use read_file; read /library/**', after: 'use read_file; use web_fetch; read /library/**' },
			{ label: 'Still asks the client', before: '(none)', after: 'sending email' }
		]);
	});

	test('only what is added is listed as newly allowed', () => {
		expect(addedAuthorityLines((change as Extract<Decision, { kind: 'change' }>).payload)).toEqual(['Can open web pages']);
		expect(grantLines(change)).toEqual(['Can open web pages']);
	});

	test('text, grouping and outcome of a change', () => {
		expect(decisionText(change, 'Lead')).toBe('Lead proposes a change to Weekly review');
		expect(groupDecisions([proposal(false), change]).map((g) => g.kind)).toEqual(['change', 'proposal']);
		expect(outcomeLine({ ...change, status: 'approved' })).toContain('applied to the program');
		expect(outcomeLine({ ...change, status: 'rejected' })).toContain('not changed');
	});
});

describe('decision model', () => {
	test('the toast names the chosen option', () => {
		expect(answerToast('approve')).toBe('Approved');
		expect(answerToast('approve', 'Keep draft')).toBe('Answered "Keep draft"');
		expect(answerToast('reject')).toBe('Rejected');
	});

	test('groups by kind with runs waiting first, empty groups left out', () => {
		const groups = groupDecisions([proposal(false), amendment, escalation(), escalation(['x'])]);
		expect(groups.map((g) => [g.kind, g.items.length])).toEqual([['escalation', 2], ['amendment', 1], ['proposal', 1]]);
		expect(groupDecisions([proposal(true)]).map((g) => g.kind)).toEqual(['proposal']);
		expect(groupDecisions([])).toEqual([]);
	});

	test('the authority a decision grants is a clear list; an escalation grants nothing', () => {
		expect(authorityLines(authority)).toEqual(['Use web_fetch', 'Every tool of connector github', 'Read /library/in/**', 'Read and write /library/out/**']);
		expect(grantLines(proposal(false))).toHaveLength(4);
		expect(grantLines(amendment)).toHaveLength(4);
		expect(grantLines(escalation())).toEqual([]);
	});

	test('when a proposal runs, and what the cards say', () => {
		expect(triggerLine({ program, runOnce: true })).toBe('Runs once, right after you approve');
		expect(triggerLine({ program, runOnce: false })).toBe('Runs when you run it');
		const scheduled = { ...program, trigger: { kind: 'schedule' as const, spec: { kind: 'every' as const, everyMs: 3_600_000 } } };
		expect(triggerLine({ program: scheduled, runOnce: false })).toMatch(/^Runs /);
		const cron = { ...program, trigger: { kind: 'schedule' as const, spec: { kind: 'cron' as const, expr: '0 8 * * 1-5', tz: 'Asia/Jakarta' } } };
		expect(triggerLine({ program: cron, runOnce: false })).toBe('Runs every weekday at 08:00 WIB (Asia/Jakarta)');
		expect(decisionText(proposal(false), 'Lead')).toBe('Lead proposes: T');
		expect(decisionText(amendment, 'Writer')).toBe('Writer asks for more authority: T');
		expect(decisionText(escalation(), 'Writer')).toBe('Writer needs a decision: T');
	});

	test('options come from escalations only', () => {
		expect(optionsOf(escalation(['A', 'B']))).toEqual(['A', 'B']);
		expect(optionsOf(escalation())).toEqual([]);
		expect(optionsOf(amendment)).toEqual([]);
	});

	test('status badges and outcome lines', () => {
		expect(statusBadge({ status: 'open' }).label).toBe('Waiting for you');
		expect(statusBadge({ status: 'expired' }).variant).toBe('destructive');
		expect(outcomeLine(proposal(true))).toBe('');
		const approved = { ...proposal(true), status: 'approved' as const, outcome: { decision: 'approved', programId: 'p', runSessionId: 'r' } };
		expect(outcomeLine(approved)).toContain('a run started');
		expect(outcomeLine({ ...approved, outcome: { decision: 'approved', programId: 'p' } })).toBe('Approved: the program was created.');
		expect(outcomeLine({ ...escalation(['A']), status: 'approved', outcome: { decision: 'A' } })).toBe('Answered "A": the run continued.');
		expect(outcomeLine({ ...escalation(['A']), status: 'approved', outcome: { decision: 'A', effect: 'Removed order o1 from HEARTBEAT.md.' } })).toBe('Removed order o1 from HEARTBEAT.md.');
		expect(outcomeLine({ ...amendment, status: 'rejected' })).toContain('without it');
		expect(outcomeLine({ ...proposal(false), status: 'rejected' })).toContain('nothing was created');
		// closed by the server (it no longer applies) vs a run that stopped waiting
		expect(outcomeLine({ ...escalation(['A']), status: 'expired', decidedBy: 'system' })).toContain('Closed automatically');
		expect(outcomeLine({ ...escalation(['A']), status: 'expired', decidedBy: 'client' })).toBe('The run no longer waited for this.');
	});

	test('edit and approve sends the program fields of the form and the run-once switch', () => {
		const form = { ...emptyProgramForm(), name: ' N ', brief: ' B ', write: '/library/a/**\n/library/a/**' };
		const edit = editBody(form, true);
		expect(edit.runOnce).toBe(true);
		expect(edit.program).toMatchObject({ name: 'N', brief: 'B', authority: { write: ['/library/a/**'], read: [], tools: [], connectors: [] }, trigger: { kind: 'manual' } });
		expect(edit.program).not.toHaveProperty('agentId');
	});
});

describe('connection names on a decision', () => {
	test('ids read as the connection name in the diff and the grant lines', async () => {
		const { connectorNames, withConnectorNames, mayTouchLines } = await import('./model');
		const d = { kind: 'note', grant: { connectors: [{ id: 'conn_ab12', label: 'phone' }, { id: null, label: 'x' }] } } as unknown as Decision;
		const names = connectorNames(d);
		expect([...names]).toEqual([['conn_ab12', 'phone']]);
		expect(withConnectorNames('use web_fetch; every tool of connector conn_ab12', names)).toBe('use web_fetch; every tool of connector phone');
		expect(mayTouchLines({ tools: [], connectors: ['conn_ab12'], read: [], write: [] }, names)).toEqual(['Can use the phone connection']);
	});
});
