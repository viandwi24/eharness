// A reply with hundreds of steps renders its newest ones; earlier ones sit behind a button that
// reveals them in chunks. Pure, unit-tested.
export const TAIL_STEPS = 40;
export const STEP_CHUNK = 100;

export type StepWindow = { start: number; hidden: number; next: number };

/** `total` blocks, `revealed` extra ones already opened: where rendering starts, how many are hidden, how many the button reveals. */
export function stepWindow(total: number, revealed: number, tail = TAIL_STEPS, chunk = STEP_CHUNK): StepWindow {
	const start = Math.max(0, total - tail - Math.max(0, revealed));
	return { start, hidden: start, next: Math.min(chunk, start) };
}
