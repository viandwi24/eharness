<script lang="ts">
	import CopyIcon from 'phosphor-svelte/lib/Copy';
	import PaperPlaneRightIcon from 'phosphor-svelte/lib/PaperPlaneRight';
	import { apiBase } from '#lib/api/index.js';
	import { copyText } from '#lib/clipboard.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { curlSnippet, fetchSnippet, type ApiAgent, type SnippetKind, useChatSnippet } from '#lib/developers/model.js';
	import { readStreamText } from '#lib/developers/sse.js';

	/**
	 * The "Try it" console: calls the real `/v1` API with a key you paste (kept in this page only,
	 * never stored) and shows ready-to-copy curl and JavaScript for the same call.
	 */
	let { agents }: { agents: ApiAgent[] } = $props();

	let agent = $state('');
	let kind = $state<SnippetKind>('run');
	let key = $state('');
	let input = $state('Hello! What can you help me with?');
	let busy = $state(false);
	let answer = $state('');
	let meta = $state('');
	let error = $state('');
	let conversationId = $state('');
	let snippetTab = $state<'curl' | 'fetch' | 'usechat'>('curl');

	$effect(() => {
		if (agent === '' && agents[0]) agent = agents[0].slug;
	});

	const baseUrl = $derived(new URL(apiBase, typeof location === 'undefined' ? 'http://localhost' : location.origin).toString().replace(/\/$/, ''));
	const snippetInput = $derived({ baseUrl, agent: agent || 'my-agent', input });
	const snippet = $derived(snippetTab === 'curl' ? curlSnippet(kind, snippetInput) : snippetTab === 'fetch' ? fetchSnippet(kind, snippetInput) : useChatSnippet(snippetInput));

	const headers = (): Record<string, string> => ({ authorization: `Bearer ${key.trim()}`, 'content-type': 'application/json' });

	async function failure(res: Response): Promise<string> {
		const body = (await res.json().catch(() => undefined)) as { error?: { code?: string; message?: string } } | undefined;
		const msg = body?.error?.message ?? `HTTP ${res.status}`;
		return res.status === 403 && body?.error?.code === 'ORIGIN_NOT_ALLOWED' ? `${msg} (This page is ${location.origin}.)` : `${res.status} ${body?.error?.code ?? ''}: ${msg}`;
	}

	async function send(): Promise<void> {
		if (!key.trim() || !agent || !input.trim()) return;
		busy = true;
		answer = '';
		meta = '';
		error = '';
		const started = Date.now();
		try {
			if (kind === 'run') {
				const res = await fetch(`${baseUrl}/v1/agents/${encodeURIComponent(agent)}/run`, { method: 'POST', headers: headers(), body: JSON.stringify({ input }) });
				if (!res.ok) throw new Error(await failure(res));
				const out = (await res.json()) as { output: unknown; usage: { inputTokens: number; outputTokens: number }; costUsd: number };
				answer = typeof out.output === 'string' ? out.output : JSON.stringify(out.output, null, 2);
				meta = `${out.usage.inputTokens} in · ${out.usage.outputTokens} out · $${out.costUsd.toFixed(4)} · ${Date.now() - started} ms`;
			} else {
				if (conversationId === '') {
					const open = await fetch(`${baseUrl}/v1/conversations`, { method: 'POST', headers: headers(), body: JSON.stringify({ agent, endUserId: 'try-it' }) });
					if (!open.ok) throw new Error(await failure(open));
					conversationId = ((await open.json()) as { id: string }).id;
				}
				const res = await fetch(`${baseUrl}/v1/conversations/${conversationId}/messages`, { method: 'POST', headers: headers(), body: JSON.stringify({ text: input }) });
				if (!res.ok) throw new Error(await failure(res));
				await readStreamText(res, (t) => (answer = t));
				meta = `conversation ${conversationId.slice(0, 8)} · ${Date.now() - started} ms`;
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'The request failed';
		} finally {
			busy = false;
		}
	}
</script>

<div class="grid gap-4 lg:grid-cols-2" data-testid="try-it">
	<div class="flex min-w-0 flex-col gap-3 text-sm">
		<label class="flex flex-col gap-1">
			<span class="font-medium">API key</span>
			<Input type="password" bind:value={key} placeholder="ehk_…" autocomplete="off" class="font-mono" data-testid="try-key" />
			<span class="text-xs text-muted-foreground">Used only for these requests from this page; never saved.</span>
		</label>
		<div class="grid grid-cols-2 gap-3">
			<label class="flex flex-col gap-1">
				<span class="font-medium">Agent</span>
				<NativeSelect bind:value={agent} aria-label="Agent">
					{#each agents as a (a.id)}<NativeSelectOption value={a.slug}>{a.name}</NativeSelectOption>{/each}
				</NativeSelect>
			</label>
			<label class="flex flex-col gap-1">
				<span class="font-medium">Mode</span>
				<NativeSelect bind:value={kind} aria-label="Mode" onchange={() => (conversationId = '')}>
					<NativeSelectOption value="run">One-shot (run)</NativeSelectOption>
					<NativeSelectOption value="conversation">Conversation (streams)</NativeSelectOption>
				</NativeSelect>
			</label>
		</div>
		<label class="flex flex-col gap-1">
			<span class="font-medium">{kind === 'run' ? 'Input' : 'Message'}</span>
			<Textarea bind:value={input} rows={4} />
		</label>
		<div class="flex items-center gap-2">
			<Button onclick={() => void send()} disabled={busy || !key.trim() || !agent || !input.trim()} data-testid="try-send">{#if busy}<Spinner class="size-4" />{:else}<PaperPlaneRightIcon class="size-4" />{/if} Send</Button>
			{#if kind === 'conversation' && conversationId}<Button variant="ghost" size="sm" onclick={() => ((conversationId = ''), (answer = ''), (meta = ''))}>New conversation</Button>{/if}
		</div>
		{#if error}<p class="whitespace-pre-wrap text-sm text-destructive-text" role="alert" data-testid="try-error">{error}</p>{/if}
		{#if answer}
			<div class="rounded-lg border border-border bg-muted/30 p-3" data-testid="try-answer">
				<pre class="whitespace-pre-wrap break-words font-sans text-sm">{answer}</pre>
				{#if meta}<p class="mt-2 text-xs text-muted-foreground">{meta}</p>{/if}
			</div>
		{/if}
	</div>

	<div class="flex min-w-0 flex-col gap-2">
		<Tabs.Root bind:value={snippetTab} class="gap-2">
			<Tabs.List variant="line" class="h-9 gap-4">
				<Tabs.Trigger value="curl">curl</Tabs.Trigger>
				<Tabs.Trigger value="fetch">JavaScript</Tabs.Trigger>
				<Tabs.Trigger value="usechat">useChat</Tabs.Trigger>
			</Tabs.List>
		</Tabs.Root>
		<div class="relative">
			<pre class="max-h-[28rem] overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-xs" data-testid="try-snippet"><code>{snippet}</code></pre>
			<Button size="sm" variant="outline" class="absolute right-2 top-2" onclick={() => void copyText(snippet).then(() => toast.success('Copied'))} aria-label="Copy the snippet"><CopyIcon class="size-4" /></Button>
		</div>
		{#if snippetTab === 'usechat'}<p class="text-xs text-muted-foreground">Open the conversation on your server and pass its id to the page. Put the key in browser code only with origins and a low daily limit.</p>{/if}
	</div>
</div>
