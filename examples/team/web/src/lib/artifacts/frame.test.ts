import { describe, expect, test } from 'bun:test';
import { parseFrameMessage, svgDocument, withBridge } from './frame';

describe('parseFrameMessage', () => {
	test('ready, resize and error in both spellings', () => {
		expect(parseFrameMessage({ type: 'artifact:ready' })).toEqual({ event: 'ready' });
		expect(parseFrameMessage({ event: 'resize', height: 400.2 })).toEqual({ event: 'resize', height: 401 });
		expect(parseFrameMessage({ type: 'eh-artifact:error', message: 'boom' })).toEqual({ event: 'error', message: 'boom' });
	});
	test('ignores anything else and absurd heights', () => {
		expect(parseFrameMessage('x')).toBeUndefined();
		expect(parseFrameMessage({ type: 'webpackOk' })).toBeUndefined();
		expect(parseFrameMessage({ type: 'resize', height: -4 })).toBeUndefined();
		expect(parseFrameMessage({ type: 'resize', height: 1e9 })).toEqual({ event: 'resize', height: 20000 });
	});
});

describe('bridge', () => {
	test('is inserted before the closing body', () => {
		const out = withBridge('<body>a</body>');
		expect(out.indexOf('<script>')).toBeLessThan(out.indexOf('</body>'));
	});
	test('is appended to a fragment; svg documents carry no script', () => {
		expect(withBridge('<p>x</p>').endsWith('</script>')).toBe(true);
		expect(svgDocument('<svg/>')).not.toContain('<script');
	});
});
