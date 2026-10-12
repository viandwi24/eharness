import { describe, expect, test } from 'bun:test';
import { scrollFades } from './fades.js';

describe('scrollFades', () => {
	test('only the side with more content fades', () => {
		expect(scrollFades(0, 375, 760)).toEqual({ left: false, right: true });
		expect(scrollFades(200, 375, 760)).toEqual({ left: true, right: true });
		expect(scrollFades(385, 375, 760)).toEqual({ left: true, right: false });
		expect(scrollFades(0, 375, 375)).toEqual({ left: false, right: false });
	});
});
