import { describe, expect, test } from 'bun:test';
import { TABLE_NAME, COLUMN_NAME } from './tables.js';
import { columnSlug, tableSlug, TEMPLATES } from './templates.js';

describe('names', () => {
	test('table slug', () => {
		expect(tableSlug('Customer contacts')).toBe('customer_contacts');
		expect(tableSlug('  2024 Sales — Q1!! ')).toBe('sales_q1');
		expect(tableSlug('Café orders')).toBe('cafe_orders');
		expect(tableSlug('')).toBe('');
		expect(TABLE_NAME.test(tableSlug('x'.repeat(100)))).toBe(true);
	});
	test('column slug', () => {
		expect(columnSlug('First name')).toBe('first_name');
		expect(columnSlug('createdOn')).toBe('createdOn');
		expect(columnSlug(' e-mail ')).toBe('e_mail');
		expect(columnSlug('1st')).toBe('st');
	});
	test('templates use valid names', () => {
		for (const t of TEMPLATES) {
			if (t.name) expect(TABLE_NAME.test(tableSlug(t.name))).toBe(true);
			for (const c of t.columns) expect(COLUMN_NAME.test(c.name)).toBe(true);
		}
	});
});
