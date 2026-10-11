import { expect, test } from 'bun:test';
import { validateGeneral } from './validate';

test('validateGeneral accepts an empty budget and a cap in range', () => {
	expect(validateGeneral({ budget: '', spawnCap: '4' })).toEqual({ ok: true, value: { budgetUsd: null, spawnCap: 4 } });
	expect(validateGeneral({ budget: '12.5', spawnCap: '32' })).toEqual({ ok: true, value: { budgetUsd: 12.5, spawnCap: 32 } });
});

test('validateGeneral reports field errors', () => {
	const r = validateGeneral({ budget: '-1', spawnCap: '0' });
	expect(r.ok).toBe(false);
	if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['budgetUsd', 'spawnCap']);
	expect(validateGeneral({ budget: 'abc', spawnCap: '2.5' }).ok).toBe(false);
});

test('validateGeneral checks the team timezone only when given', () => {
	expect(validateGeneral({ budget: '', spawnCap: '4', timezone: ' Asia/Jakarta ' })).toEqual({ ok: true, value: { budgetUsd: null, spawnCap: 4, timezone: 'Asia/Jakarta' } });
	for (const timezone of ['Mars/Base', '']) {
		const r = validateGeneral({ budget: '', spawnCap: '4', timezone });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(Object.keys(r.errors)).toEqual(['timezone']);
	}
});

test('validateGeneral accepts the numbers a bound number input produces', () => {
	expect(validateGeneral({ budget: 8, spawnCap: 4 })).toEqual({ ok: true, value: { budgetUsd: 8, spawnCap: 4 } });
	expect(validateGeneral({ budget: null, spawnCap: 4 })).toEqual({ ok: true, value: { budgetUsd: null, spawnCap: 4 } });
});
