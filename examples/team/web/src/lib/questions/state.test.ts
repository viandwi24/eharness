import { describe, expect, test } from 'bun:test';
import {
	back, canNext, dropDraft, saveDraft, takeDraft, canSubmit, goTo, initState, isReview, missing, next, pick, setNotes, setOther, toAnswers, type QuestionDef
} from './state';

const qs: QuestionDef[] = [
	{ question: 'Lang?', header: 'Lang', options: [{ label: 'TS' }, { label: 'Go' }] },
	{ question: 'Extras?', header: 'Extras', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] },
	{ question: 'Env?', header: 'Env', options: [{ label: 'dev' }, { label: 'prod' }] }
];

describe('question state', () => {
	test('single choice replaces, answer required to go next', () => {
		let s = initState(qs);
		expect(canNext(s)).toBe(false);
		expect(next(s).step).toBe(0);
		s = pick(s, 0);
		s = pick(s, 1);
		expect(s.picked[0]).toEqual([1]);
		expect(canNext(s)).toBe(true);
		expect(next(s).step).toBe(1);
	});

	test('multi toggles and may stay empty', () => {
		let s = goTo(pick(initState(qs), 0), 1);
		expect(canNext(s)).toBe(true);
		s = pick(pick(pick(s, 2), 0), 2);
		expect(s.picked[1]).toEqual([0]);
	});

	test('other replaces single pick and picking clears other', () => {
		let s = pick(initState(qs), 0);
		s = setOther(s, ' custom ');
		expect(s.picked[0]).toEqual([]);
		expect(toAnswers(s).answers[0]).toEqual({ other: 'custom' });
		s = pick(s, 1);
		expect(s.other[0]).toBe('');
		// multi keeps both
		let m = goTo(pick(initState(qs), 0), 1);
		m = setOther(pick(m, 1), 'x');
		expect(m.picked[1]).toEqual([1]);
		expect(toAnswers(m).answers[1]).toEqual({ selected: ['B'], other: 'x' });
	});

	test('back/forward keeps answers', () => {
		let s = next(pick(initState(qs), 1));
		s = setNotes(pick(s, 0), 'why');
		s = back(s);
		expect(s.step).toBe(0);
		expect(s.picked[0]).toEqual([1]);
		s = next(s);
		expect(s.picked[1]).toEqual([0]);
		expect(s.notes[1]).toBe('why');
	});

	test('cannot jump past an unanswered required question', () => {
		const s = initState(qs);
		expect(goTo(s, 2).step).toBe(0);
		expect(goTo(pick(s, 0), 2).step).toBe(2);
	});

	test('review and submit body', () => {
		let s = initState(qs);
		s = next(pick(s, 1));
		s = next(setNotes(pick(s, 1), 'ok'));
		expect(isReview(s)).toBe(false);
		expect(canSubmit(s)).toBe(false);
		expect(missing(s)).toEqual([2]);
		s = next(pick(s, 0));
		expect(isReview(s)).toBe(true);
		expect(canSubmit(s)).toBe(true);
		expect(toAnswers(s)).toEqual({
			answers: [{ selected: ['Go'] }, { selected: ['B'], notes: 'ok' }, { selected: ['dev'] }]
		});
	});

	test('empty multi answer sends an empty object', () => {
		expect(toAnswers(initState([qs[1]!])).answers).toEqual([{}]);
	});
});

describe('drafts of a failed submit', () => {
	const dq: QuestionDef[] = [{ question: 'A?', options: [{ label: 'x' }, { label: 'y' }] }, { question: 'B?', options: [{ label: 'z' }] }];
	test('the new card starts from what was typed, once, for the same questions', () => {
		const typed = pick(initState(dq), 1);
		saveDraft('a1', typed);
		expect(takeDraft('a1', dq)?.picked[0]).toEqual([1]);
		expect(takeDraft('a1', dq)).toBeUndefined();
	});
	test('a different question set or a dropped draft starts fresh', () => {
		saveDraft('a2', pick(initState(dq), 0));
		expect(takeDraft('a2', [{ question: 'other?', options: [] }])).toBeUndefined();
		saveDraft('a3', initState(dq));
		dropDraft('a3');
		expect(takeDraft('a3', dq)).toBeUndefined();
	});
});
