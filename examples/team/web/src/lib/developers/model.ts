// Pure helpers of the Developers page: list parsing, library folders for the picker, status badges,
// the copyable curl / JavaScript snippets and the daily chart. No Svelte, no DOM: model.test.ts.
import type { components } from '../api/schema';

export type ApiAgent = components['schemas']['ApiAgent'];
export type ApiKeyView = components['schemas']['ApiKey'];
export type ApiRequestRow = components['schemas']['ApiRequest'];
export type ApiUsage = components['schemas']['ApiUsage'];

export type BadgeVariant = 'default' | 'secondary' | 'success' | 'warning' | 'info' | 'destructive' | 'outline';

/** Lines or comma separated items, trimmed, without empties and repeats. */
export function splitList(text: string): string[] {
	return [...new Set(text.split(/[\n,]/).map((s) => s.trim()).filter((s) => s !== ''))];
}

/**
 * The folders of the library a grant can name: every directory of `paths` below `root`, down to
 * `depth` levels, sorted. The library root itself is never offered (a grant is a folder inside it).
 */
export function foldersOf(paths: readonly string[], root = '/library', depth = 3): string[] {
	const out = new Set<string>();
	for (const path of paths) {
		if (!path.startsWith(`${root}/`)) continue;
		const parts = path.slice(root.length + 1).split('/');
		parts.pop(); // the file name
		for (let i = 1; i <= Math.min(parts.length, depth); i++) out.add(`${root}/${parts.slice(0, i).join('/')}`);
	}
	return [...out].sort();
}

export function statusVariant(status: number): BadgeVariant {
	if (status === 0) return 'info';
	if (status < 300) return 'success';
	if (status === 429) return 'warning';
	return 'destructive';
}

export const statusLabel = (status: number): string => (status === 0 ? 'running' : String(status));

/** USD with enough digits for small API costs. */
export function costText(usd: number): string {
	if (usd === 0) return '$0';
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	return `$${usd.toFixed(2)}`;
}

/** The last `n` UTC days with the days that had no traffic filled in as zero (oldest first). */
export function chartDays(days: readonly { day: number; requests: number; costUsd: number }[], n: number, now: number): { day: number; requests: number; costUsd: number }[] {
	const DAY = 86_400_000;
	const start = Math.floor(now / DAY) * DAY - (n - 1) * DAY;
	const byDay = new Map(days.map((d) => [d.day, d]));
	return Array.from({ length: n }, (_, i) => byDay.get(start + i * DAY) ?? { day: start + i * DAY, requests: 0, costUsd: 0 });
}

/** A key limit as text: "$5.00 / day", "60 / min", or "No limit". */
export function limitText(k: Pick<ApiKeyView, 'dailyCostLimitUsd' | 'rateLimitPerMin'>): string {
	const parts = [k.dailyCostLimitUsd === null ? '' : `${costText(k.dailyCostLimitUsd)} / day`, k.rateLimitPerMin === null ? '' : `${k.rateLimitPerMin} / min`].filter(Boolean);
	return parts.length === 0 ? 'No limit' : parts.join(' · ');
}

export function keyState(k: Pick<ApiKeyView, 'revokedAt' | 'expiresAt'>, now: number): { label: string; variant: BadgeVariant } {
	if (k.revokedAt !== null) return { label: 'Revoked', variant: 'secondary' };
	if (k.expiresAt !== null && k.expiresAt <= now) return { label: 'Expired', variant: 'secondary' };
	return { label: 'Active', variant: 'success' };
}

// --- snippets ---------------------------------------------------------------------------------

export type SnippetKind = 'run' | 'conversation';
export interface SnippetInput {
	/** The server address developers call, without a trailing slash (`https://team.example.com/api`). */
	baseUrl: string;
	agent: string;
	/** Shown in the snippet; a placeholder when the key is not at hand. */
	key?: string;
	input?: string;
}

const KEY_PLACEHOLDER = 'ehk_your_key_here';
const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export function curlSnippet(kind: SnippetKind, i: SnippetInput): string {
	const key = i.key || KEY_PLACEHOLDER;
	const text = i.input ?? 'Hello';
	if (kind === 'run') {
		return [`curl -X POST ${i.baseUrl}/v1/agents/${i.agent}/run \\`, `  -H "Authorization: Bearer ${key}" \\`, `  -H "content-type: application/json" \\`, `  -d ${quote(JSON.stringify({ input: text }))}`].join('\n');
	}
	return [
		`# 1. open a conversation (the same endUserId returns the open one)`,
		`curl -X POST ${i.baseUrl}/v1/conversations \\`,
		`  -H "Authorization: Bearer ${key}" -H "content-type: application/json" \\`,
		`  -d ${quote(JSON.stringify({ agent: i.agent, endUserId: 'user-42' }))}`,
		``,
		`# 2. send a message; the answer streams (add "stream": false for JSON)`,
		`curl -N -X POST ${i.baseUrl}/v1/conversations/$CONVERSATION_ID/messages \\`,
		`  -H "Authorization: Bearer ${key}" -H "content-type: application/json" \\`,
		`  -d ${quote(JSON.stringify({ text }))}`
	].join('\n');
}

export function fetchSnippet(kind: SnippetKind, i: SnippetInput): string {
	const key = i.key || KEY_PLACEHOLDER;
	const text = JSON.stringify(i.input ?? 'Hello');
	if (kind === 'run') {
		return `const res = await fetch('${i.baseUrl}/v1/agents/${i.agent}/run', {
  method: 'POST',
  headers: { authorization: 'Bearer ${key}', 'content-type': 'application/json' },
  body: JSON.stringify({ input: ${text} })
});
if (!res.ok) throw new Error((await res.json()).error.message);
const { output, costUsd } = await res.json();`;
	}
	return `const headers = { authorization: 'Bearer ${key}', 'content-type': 'application/json' };

// 1. open a conversation (the same endUserId returns the open one)
const conversation = await (await fetch('${i.baseUrl}/v1/conversations', {
  method: 'POST',
  headers,
  body: JSON.stringify({ agent: '${i.agent}', endUserId: 'user-42' })
})).json();

// 2. send a message and get the whole answer as JSON
const reply = await (await fetch(\`${i.baseUrl}/v1/conversations/\${conversation.id}/messages\`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ text: ${text}, stream: false })
})).json();
console.log(reply.text);`;
}

/** `useChat` over the stream with `eharness/client` (the key belongs on your server unless it lists your origin). */
export function useChatSnippet(i: SnippetInput): string {
	const key = i.key || KEY_PLACEHOLDER;
	return `import { useChat } from '@ai-sdk/react';
import { createHarnessClient, createHarnessTransport } from 'eharness/client';

// conversationId: from POST ${i.baseUrl}/v1/conversations (your server can open it)
const client = createHarnessClient({
  baseUrl: '${i.baseUrl}/v1',
  headers: { authorization: 'Bearer ${key}' }
});

export function Chat({ conversationId }: { conversationId: string }) {
  const { messages, sendMessage, status } = useChat({
    id: conversationId,
    transport: createHarnessTransport({ client })
  });
  // render messages[].parts, call sendMessage({ text }) from your input
}`;
}
