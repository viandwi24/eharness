export type GeneralInput = { budget: string; spawnCap: string };
export type GeneralParsed = { budgetUsd: number | null; spawnCap: number };

/** Validate the General form's text inputs. Errors are keyed by the API field name. */
export function validateGeneral(input: GeneralInput): { ok: true; value: GeneralParsed } | { ok: false; errors: Record<string, string> } {
	const errors: Record<string, string> = {};
	const b = input.budget.trim();
	const budgetUsd = b === '' ? null : Number(b);
	if (budgetUsd !== null && (!Number.isFinite(budgetUsd) || budgetUsd < 0)) {
		errors.budgetUsd = 'Enter a positive amount, or leave empty for no limit';
	}
	const c = input.spawnCap.trim();
	const spawnCap = Number(c);
	if (c === '' || !Number.isInteger(spawnCap) || spawnCap < 1 || spawnCap > 32) {
		errors.spawnCap = 'Enter a whole number from 1 to 32';
	}
	return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { budgetUsd, spawnCap } };
}
