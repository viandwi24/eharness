/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { notificationLink } from './notifications-model.ts';

describe('notification model', () => {
	test('notification links are app paths only', () => {
		expect(notificationLink({ link: '/tasks/1' })).toBe('/tasks/1');
		expect(notificationLink({ link: 'https://x' })).toBeNull();
		expect(notificationLink({ link: null })).toBeNull();
	});
});
