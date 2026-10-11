import { describe, expect, test } from 'bun:test';
import { uploadErrorText } from './http.ts';

describe('uploadErrorText', () => {
	test('names the file for size and type problems', () => {
		expect(uploadErrorText(413, undefined, 'big.pdf')).toContain('big.pdf is too large');
		expect(uploadErrorText(400, { error: { message: 'type not allowed' } }, 'a.exe')).toBe('a.exe was rejected: type not allowed');
		expect(uploadErrorText(500, undefined, 'x.txt')).toBe('Could not upload x.txt');
	});
});
