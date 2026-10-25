import { expect, test } from 'bun:test';
import { ALL_KNOBS, knobPatch, knobText, parseKnob } from './knobs';

const knob = (key: string) => ALL_KNOBS.find((k) => k.key === key)!;

test('parseKnob scales seconds to milliseconds and reads empty as null only when allowed', () => {
	expect(parseKnob(knob('connectorHealthTtlMs'), '60')).toEqual({ ok: true, value: 60000 });
	expect(parseKnob(knob('connectorHealthTtlMs'), '')).toEqual({ ok: true, value: null });
	expect(parseKnob(knob('connectorProbeRetryMs'), '2.5')).toEqual({ ok: true, value: 2500 });
	expect(parseKnob(knob('stuckRunMinutes'), '').ok).toBe(false);
});

test('parseKnob enforces range and whole numbers', () => {
	expect(parseKnob(knob('stuckRunMinutes'), '4').ok).toBe(false);
	expect(parseKnob(knob('stuckRunMinutes'), '45.5').ok).toBe(false);
	expect(parseKnob(knob('longRunMaxCostUsd'), '0')).toEqual({ ok: true, value: 0 });
	expect(parseKnob(knob('longRunChunkSteps'), '9').ok).toBe(false);
	expect(parseKnob(knob('contextCap'), '1000').ok).toBe(false);
	expect(parseKnob(knob('contextCap'), '')).toEqual({ ok: true, value: null });
});

test('knobText shows the scaled value and empty for null', () => {
	expect(knobText(knob('connectorHealthTtlMs'), 60000)).toBe('60');
	expect(knobText(knob('connectorHealthTtlMs'), null)).toBe('');
});

test('knobPatch holds only what changed and reports every error', () => {
	const current = { stuckRunMinutes: 45, connectorHealthTtlMs: 60000, contextCap: null as number | null };
	const same = knobPatch({ stuckRunMinutes: '45', connectorHealthTtlMs: '60', contextCap: '' }, current);
	expect(same).toEqual({ ok: true, patch: {} });
	const changed = knobPatch({ stuckRunMinutes: '60', connectorHealthTtlMs: '', contextCap: '' }, current);
	expect(changed).toEqual({ ok: true, patch: { stuckRunMinutes: 60, connectorHealthTtlMs: null } });
	const bad = knobPatch({ stuckRunMinutes: '1', connectorHealthTtlMs: 'x', contextCap: '' }, current);
	expect(bad.ok).toBe(false);
	if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(['connectorHealthTtlMs', 'stuckRunMinutes']);
});
