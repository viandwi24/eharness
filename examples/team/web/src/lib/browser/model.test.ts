import { describe, expect, test } from 'bun:test';
import { controllerText, formatBytes, keyInput, letterbox, liveUrl, mapPointer, normalizeUrl, parseDomains, parseFrame, runtimeView, stateBadge } from './model';

function pack(header: object, bytes: number[]): ArrayBuffer {
	const h = new TextEncoder().encode(JSON.stringify(header));
	const out = new Uint8Array(4 + h.length + bytes.length);
	new DataView(out.buffer).setUint32(0, h.length);
	out.set(h, 4);
	out.set(bytes, 4 + h.length);
	return out.buffer;
}

describe('parseFrame', () => {
	test('reads the header and the image bytes', () => {
		const f = parseFrame(pack({ type: 'frame', seq: 3, width: 800, height: 600, mediaType: 'image/png', at: 5 }, [1, 2, 3]));
		expect(f?.header).toEqual({ type: 'frame', seq: 3, width: 800, height: 600, mediaType: 'image/png', at: 5 });
		expect([...(f?.image ?? [])]).toEqual([1, 2, 3]);
	});
	test('drops malformed messages', () => {
		expect(parseFrame(new ArrayBuffer(2))).toBeUndefined();
		expect(parseFrame(pack({ type: 'x', width: 1, height: 1 }, []))).toBeUndefined();
		expect(parseFrame(pack({ type: 'frame', width: 0, height: 1 }, []))).toBeUndefined();
		const bad = new Uint8Array([0, 0, 0, 99, 1]);
		expect(parseFrame(bad.buffer)).toBeUndefined();
	});
});

describe('pointer mapping', () => {
	test('letterboxes a wide frame in a square box', () => {
		expect(letterbox({ width: 400, height: 400 }, { width: 800, height: 400 })).toEqual({ x: 0, y: 100, width: 400, height: 200 });
	});
	test('maps to frame pixels and rejects the bars', () => {
		const box = { width: 400, height: 400 };
		const frame = { width: 800, height: 400 };
		expect(mapPointer({ x: 200, y: 200 }, box, frame)).toEqual({ x: 400, y: 200 });
		expect(mapPointer({ x: 0, y: 100 }, box, frame)).toEqual({ x: 0, y: 0 });
		expect(mapPointer({ x: 200, y: 50 }, box, frame)).toBeUndefined();
		expect(mapPointer({ x: 1, y: 1 }, { width: 0, height: 0 }, frame)).toBeUndefined();
	});
});

describe('state badge', () => {
	test('names who holds the browser', () => {
		expect(stateBadge({ state: 'missing' }).label).toBe('Missing');
		expect(stateBadge({ state: 'ready' }).variant).toBe('success');
		const lease = { holder: { kind: 'session', id: 's' }, heldBy: { agentId: 'a', name: 'Mira' }, controller: { by: 'agent', since: 1 }, viewers: 0, since: 1 } as const;
		expect(stateBadge({ state: 'in-use', lease }).label).toBe('In use by Mira');
		expect(stateBadge({ state: 'controlled', lease: { ...lease, controller: { by: 'human', holder: 'client:abcd1234', since: 1 } } }).label).toBe('Controlled by viewer abcd');
		expect(stateBadge({ state: 'error' }).variant).toBe('destructive');
	});
	test('runtime progress', () => {
		expect(runtimeView({ state: 'installing', progress: { received: 50, total: 200 } }).percent).toBe(25);
		expect(runtimeView({ state: 'installing', progress: { received: 50 } }).percent).toBeNull();
	});
});

describe('misc', () => {
	test('formatBytes', () => {
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
		expect(formatBytes(undefined)).toBe('—');
	});
	test('keys: printable chars, specials, shortcuts', () => {
		const base = { code: 'KeyA', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
		expect(keyInput({ ...base, key: 'a' }, 'down')).toEqual([{ type: 'key', event: 'char', key: 'a', code: 'KeyA', text: 'a', modifiers: 0 }]);
		expect(keyInput({ ...base, key: 'a' }, 'up')).toEqual([]);
		expect(keyInput({ ...base, key: 'Enter', code: 'Enter' }, 'down')[0]).toMatchObject({ event: 'down', key: 'Enter' });
		expect(keyInput({ ...base, key: 'a', ctrlKey: true }, 'down')[0]).toMatchObject({ event: 'down', modifiers: 2 });
	});
	test('url helpers', () => {
		expect(normalizeUrl(' example.com/x ')).toBe('https://example.com/x');
		expect(normalizeUrl('http://a.b')).toBe('http://a.b');
		expect(liveUrl('/api', 'p 1', 'https://t.example')).toBe('wss://t.example/api/browser/profiles/p%201/live');
		expect(liveUrl('http://localhost:4000/api/', 'p', 'http://x')).toBe('ws://localhost:4000/api/browser/profiles/p/live');
	});
	test('banner text', () => {
		expect(controllerText(undefined, undefined)).toBe('Connecting…');
		expect(controllerText({ by: 'human', holder: 'client:1', since: 1 }, 'client:1')).toContain('You are in control');
		expect(controllerText({ by: 'agent', since: 1, reason: 'log in' }, 'client:1')).toContain('log in');
	});
	test('domains', () => {
		expect(parseDomains('a.com, *.b.com\na.com')).toEqual(['a.com', '*.b.com']);
	});
});
