/** Pure state machine of the stepped question card (`ask_user_question`), no Svelte. */

export interface QuestionDef {
	question: string;
	header?: string;
	options: { label: string; description?: string }[];
	multiSelect?: boolean;
}

export interface QuestionAnswerBody {
	selected?: string[];
	other?: string;
	notes?: string;
}

export interface QState {
	questions: QuestionDef[];
	/** Active step: a question index, or `questions.length` for the review step. */
	step: number;
	/** Chosen option indexes per question. */
	picked: number[][];
	other: string[];
	notes: string[];
}

export function initState(questions: QuestionDef[]): QState {
	return {
		questions,
		step: 0,
		picked: questions.map(() => []),
		other: questions.map(() => ''),
		notes: questions.map(() => '')
	};
}

const setAt = <T>(list: T[], i: number, v: T): T[] => list.map((x, j) => (j === i ? v : x));

export const isReview = (s: QState): boolean => s.step >= s.questions.length;
export const isLast = (s: QState): boolean => s.step === s.questions.length - 1;

export function isAnswered(s: QState, i: number): boolean {
	return (s.picked[i]?.length ?? 0) > 0 || (s.other[i]?.trim() ?? '') !== '';
}

/** A single-choice question needs an answer; a multi-select one may stay empty. */
export function isRequired(s: QState, i: number): boolean {
	return !s.questions[i]?.multiSelect;
}

/** Indexes that still need an answer. */
export function missing(s: QState): number[] {
	return s.questions.flatMap((_, i) => (isRequired(s, i) && !isAnswered(s, i) ? [i] : []));
}

export function canNext(s: QState): boolean {
	if (isReview(s)) return false;
	return !isRequired(s, s.step) || isAnswered(s, s.step);
}

export function canSubmit(s: QState): boolean {
	return missing(s).length === 0;
}

/** Pick option `n` of the active question (single: replace and clear Other; multi: toggle). */
export function pick(s: QState, n: number, i: number = s.step): QState {
	const q = s.questions[i];
	if (!q || n < 0 || n >= q.options.length) return s;
	const cur = s.picked[i] ?? [];
	if (q.multiSelect) {
		const next = cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n].sort((a, b) => a - b);
		return { ...s, picked: setAt(s.picked, i, next) };
	}
	return { ...s, picked: setAt(s.picked, i, [n]), other: setAt(s.other, i, '') };
}

/** Set the Other text. Typing replaces a single-choice pick. */
export function setOther(s: QState, text: string, i: number = s.step): QState {
	const q = s.questions[i];
	if (!q) return s;
	return {
		...s,
		other: setAt(s.other, i, text),
		picked: !q.multiSelect && text.trim() !== '' ? setAt(s.picked, i, []) : s.picked
	};
}

export function setNotes(s: QState, text: string, i: number = s.step): QState {
	return s.questions[i] ? { ...s, notes: setAt(s.notes, i, text) } : s;
}

/** Go to a step (question or review). Moving forward past an unanswered required question is refused. */
export function goTo(s: QState, step: number): QState {
	const target = Math.max(0, Math.min(step, s.questions.length));
	if (target > s.step) {
		for (let i = s.step; i < target; i++) if (isRequired(s, i) && !isAnswered(s, i)) return s;
	}
	return { ...s, step: target };
}

export const next = (s: QState): QState => (isReview(s) ? s : canNext(s) ? { ...s, step: s.step + 1 } : s);
export const back = (s: QState): QState => (s.step > 0 ? { ...s, step: s.step - 1 } : s);

/** Human text of one answer. */
export function answerText(s: QState, i: number): string {
	const q = s.questions[i];
	if (!q) return '';
	const labels = (s.picked[i] ?? []).map((n) => q.options[n]?.label ?? '');
	const other = s.other[i]?.trim() ?? '';
	return [...labels, ...(other ? [other] : [])].join(', ');
}

/** Request body of `POST /approvals/{id}` (same shape the old card sent, plus `notes`). */
export function toAnswers(s: QState): { answers: QuestionAnswerBody[] } {
	return {
		answers: s.questions.map((q, i) => {
			const selected = (s.picked[i] ?? []).map((n) => q.options[n]?.label ?? '');
			const other = s.other[i]?.trim() ?? '';
			const notes = s.notes[i]?.trim() ?? '';
			return {
				...(selected.length ? { selected } : {}),
				...(other ? { other } : {}),
				...(notes ? { notes } : {})
			};
		})
	};
}
