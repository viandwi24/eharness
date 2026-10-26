// A new row typed straight into the grid before it exists on the server: which required fields
// it still lacks, and which cells a server error is about. Pure.
import type { TableRecord, TableSchema } from './tables.js';

/** The id of the draft row in the grid (never a real row id: those are UUIDv7). */
export const DRAFT_ID = '__draft__';

export const isDraft = (row: { id: string }): boolean => row.id === DRAFT_ID;

/** A draft as a record the grid can show. */
export function draftRecord(data: Record<string, unknown>): TableRecord {
	return { id: DRAFT_ID, data, version: 0, createdAt: 0, updatedAt: 0, createdBy: '', updatedBy: '' };
}

const empty = (v: unknown): boolean => v === undefined || v === null || v === '';

/** Required columns without a default that the draft has no value for, in schema order. */
export function missingRequired(schema: TableSchema | undefined, data: Record<string, unknown>): string[] {
	return (schema?.columns ?? []).filter((c) => c.required && c.default === undefined && empty(data[c.name])).map((c) => c.name);
}

/** The first field to type into: the first required one still empty, else the first visible field. */
export function firstDraftField(schema: TableSchema | undefined, visible: readonly string[], data: Record<string, unknown> = {}): string | undefined {
	return missingRequired(schema, data).find((n) => visible.includes(n)) ?? visible[0];
}

/** One message per missing required field, for the cells' outline and tooltip. */
export function requiredErrors(missing: readonly string[]): Record<string, string> {
	return Object.fromEntries(missing.map((n) => [n, `${n} is required: type a value to save the new row`]));
}

/**
 * A server error about a row ("\"title\" is required; \"points\" must be a number") split onto
 * the fields it names. Text naming no known field lands on `fallback`.
 */
export function errorsByField(message: string, fields: readonly string[], fallback?: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of message.split(/;\s*|\n/)) {
		const named = [...part.matchAll(/"([A-Za-z_][A-Za-z0-9_.]*)"/g)].map((m) => m[1] as string).filter((f) => fields.includes(f));
		if (named.length) for (const f of named) out[f] = out[f] ? `${out[f]}; ${part.trim()}` : part.trim();
		else if (fallback && part.trim()) out[fallback] = out[fallback] ? `${out[fallback]}; ${part.trim()}` : part.trim();
	}
	return out;
}

/** Fields whose value changed between what was sent to create the row and the draft now. */
export function changedSince(sent: Record<string, unknown>, now: Record<string, unknown>): { set: Record<string, unknown>; unset: string[] } {
	const set: Record<string, unknown> = {};
	const unset: string[] = [];
	for (const [k, v] of Object.entries(now)) if (JSON.stringify(v) !== JSON.stringify(sent[k])) set[k] = v;
	for (const k of Object.keys(sent)) if (!(k in now)) unset.push(k);
	return { set, unset };
}
