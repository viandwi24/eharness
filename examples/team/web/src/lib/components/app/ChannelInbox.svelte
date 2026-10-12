<script lang="ts">
	import { onMount } from 'svelte';
	import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeft';
	import ArrowsClockwiseIcon from 'phosphor-svelte/lib/ArrowsClockwise';
	import ArrowSquareOutIcon from 'phosphor-svelte/lib/ArrowSquareOut';
	import { api } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import {
		ago,
		allowlistLabel,
		approvalOutcome,
		inboxCounts,
		KIND_LABEL,
		messageMarks,
		messageSender,
		previewLine,
		threadHref,
		type ChannelConnection,
		type InboxConversation,
		type LogMessage
	} from '#lib/channels/model.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { formatTime } from '#lib/format.js';

	// Inbox of one connection: the conversations (groups, topics, direct messages) with counters,
	// and a conversation view of the channel log in order. The log is decrypted on the server for
	// whoever holds the web token.
	let { conn }: { conn: ChannelConnection } = $props();

	let items = $state<InboxConversation[] | null>(null);
	let next = $state<string | undefined>();
	let error = $state('');
	let loadingMore = $state(false);
	let open = $state<InboxConversation | null>(null);
	let log = $state<LogMessage[]>([]);
	let older = $state<string | undefined>();
	let logError = $state('');
	let logBusy = $state(false);
	let seq = 0;

	const agentName = (id: string): string => agentsStore.state.agents.find((a) => a.id === id)?.name ?? id;

	async function load(): Promise<void> {
		const mine = ++seq;
		try {
			const r = await api.get('/channels/connections/{id}/inbox', { params: { id: conn.id }, query: { limit: 30 } });
			if (mine !== seq) return;
			items = r.items;
			next = r.next;
			error = '';
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not load the conversations';
		}
	}
	async function more(): Promise<void> {
		if (next === undefined) return;
		loadingMore = true;
		try {
			const r = await api.get('/channels/connections/{id}/inbox', { params: { id: conn.id }, query: { limit: 30, cursor: next } });
			items = [...(items ?? []), ...r.items];
			next = r.next;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not load more';
		} finally {
			loadingMore = false;
		}
	}

	async function openLog(c: InboxConversation): Promise<void> {
		open = c;
		log = [];
		older = undefined;
		logError = '';
		await loadLog(undefined);
	}
	async function loadLog(before: string | undefined): Promise<void> {
		if (open === null) return;
		const conversationId = open.conversationId;
		logBusy = true;
		try {
			const r = await api.get('/channels/connections/{id}/inbox/messages', { params: { id: conn.id }, query: { conversationId, limit: 40, ...(before === undefined ? {} : { before }) } });
			if (open?.conversationId !== conversationId) return;
			log = before === undefined ? r.items : [...r.items, ...log];
			older = r.next;
			open = r.conversation;
		} catch (e) {
			logError = e instanceof Error ? e.message : 'Could not load the messages';
		} finally {
			logBusy = false;
		}
	}

	onMount(() => {
		void load();
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible' && open === null) void load();
		}, 5000);
		return () => clearInterval(timer);
	});
</script>

<div class="flex flex-col gap-3" data-testid="inbox-tab">
	{#if open === null}
		<div class="flex flex-wrap items-center justify-between gap-2">
			<p class="min-w-0 flex-1 text-xs text-muted-foreground">Every conversation this connection has seen: what woke the agent, what was only read, and what was dropped. Open one to read its log.</p>
			<Button size="sm" variant="outline" onclick={() => void load()}><ArrowsClockwiseIcon class="size-4" /> Refresh</Button>
		</div>
		{#if error}
			<p class="text-sm text-destructive-text" role="alert">{error}</p>
		{:else if items === null}
			<div class="flex flex-col gap-2" aria-busy="true">{#each [0, 1, 2] as i (i)}<Skeleton class="h-16 w-full rounded-lg" />{/each}</div>
		{:else if items.length === 0}
			<p class="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid="inbox-empty">No conversations yet. They appear when somebody writes in a chat this connection is in.</p>
		{:else}
			<ul class="flex flex-col divide-y divide-border rounded-lg border border-border">
				{#each items as c (c.conversationId)}
					<li>
						<button type="button" class="flex w-full flex-col gap-1 p-3 text-left hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none" onclick={() => void openLog(c)} data-testid="inbox-row">
							<div class="flex min-w-0 flex-wrap items-center gap-2">
								<span class="truncate text-sm font-medium">{c.parentTitle ? `${c.parentTitle} / ${c.title}` : c.title}</span>
								<Badge variant="secondary">{KIND_LABEL[c.kind]}{c.topic ? ' · topic' : ''}</Badge>
								<Badge variant={c.allowed ? 'success' : 'warning'}>{allowlistLabel(c)}</Badge>
								<span class="ml-auto shrink-0 text-xs text-muted-foreground">{ago(c.lastAt, Date.now())}</span>
							</div>
							<p class="truncate text-xs text-muted-foreground">{previewLine(c)}</p>
							<p class="text-xs text-muted-foreground">{agentName(c.agentId)} · {inboxCounts(c)}</p>
						</button>
					</li>
				{/each}
			</ul>
			{#if next !== undefined}
				<div class="flex justify-center"><Button size="sm" variant="outline" onclick={() => void more()} disabled={loadingMore}>Load more</Button></div>
			{/if}
		{/if}
	{:else}
		{@const href = threadHref(open)}
		<div class="flex flex-wrap items-center gap-2">
			<Button size="sm" variant="ghost" onclick={() => (open = null)} data-testid="inbox-back"><ArrowLeftIcon class="size-4" /> All conversations</Button>
			<Button size="sm" variant="ghost" onclick={() => void loadLog(undefined)} disabled={logBusy}><ArrowsClockwiseIcon class="size-4" /> Refresh</Button>
			{#if href}<Button size="sm" variant="outline" class="ml-auto" {href} data-testid="open-thread"><ArrowSquareOutIcon class="size-4" /> Open in the agent's thread</Button>{/if}
		</div>
		<div class="flex flex-col gap-1">
			<div class="flex min-w-0 flex-wrap items-center gap-2"><h3 class="truncate text-sm font-medium">{open.title}</h3><Badge variant="secondary">{KIND_LABEL[open.kind]}</Badge><Badge variant={open.allowed ? 'success' : 'warning'}>{allowlistLabel(open)}</Badge></div>
			<p class="text-xs text-muted-foreground">{agentName(open.agentId)} · {inboxCounts(open)}{#if !href} · the agent has no thread here yet{/if}</p>
		</div>
		{#if logError}<p class="text-sm text-destructive-text" role="alert">{logError}</p>{/if}
		{#if older !== undefined}
			<div class="flex justify-center"><Button size="sm" variant="outline" onclick={() => void loadLog(older)} disabled={logBusy} data-testid="load-older">Load older messages</Button></div>
		{/if}
		{#if log.length === 0 && !logBusy && !logError}
			<p class="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">Nothing stored for this conversation (the log is kept for a limited time, or messages were only counted).</p>
		{/if}
		<ol class="flex flex-col gap-2" data-testid="log-list">
			{#each log as m (m.id)}
				<li class="flex flex-col gap-1 rounded-lg border border-border p-3 {m.self ? 'bg-muted/40' : ''}" data-testid="log-message">
					<div class="flex min-w-0 flex-wrap items-center gap-2 text-xs">
						<span class="truncate font-medium">{messageSender(m)}</span>
						{#each messageMarks(m) as mark (mark)}<Badge variant={mark === 'Deleted' ? 'destructive' : mark === 'Woke the agent' ? 'success' : 'secondary'}>{mark}</Badge>{/each}
						<span class="ml-auto shrink-0 text-muted-foreground">{formatTime(m.at)}</span>
					</div>
					{#if m.replyTo}<p class="border-l-2 border-border pl-2 text-xs text-muted-foreground">In reply to {m.replyTo.senderName ?? 'a message'}{m.replyTo.text ? `: ${m.replyTo.text}` : ''}</p>{/if}
					<p class="whitespace-pre-wrap break-words text-sm {m.deletedAt ? 'text-muted-foreground line-through' : ''}">{m.text || (m.attachments.length ? '' : '(no text)')}</p>
					{#if m.attachments.length > 0}<p class="text-xs text-muted-foreground">{m.attachments.length} attachment{m.attachments.length === 1 ? '' : 's'}: {m.attachments.map((a) => a.name ?? a.mediaType ?? 'file').join(', ')}</p>{/if}
					{#if m.approval}<p class="text-xs text-muted-foreground" data-testid="approval-outcome">{m.approval.toolName}: {approvalOutcome(m.approval)}</p>{/if}
					{#if m.edits && m.edits.length > 0}
						<details class="text-xs text-muted-foreground"><summary class="cursor-pointer">Earlier versions ({m.edits.length})</summary><ul class="mt-1 flex flex-col gap-1">{#each m.edits as edit (edit.at)}<li class="whitespace-pre-wrap break-words">{formatTime(edit.at)}: {edit.text}</li>{/each}</ul></details>
					{/if}
				</li>
			{/each}
		</ol>
	{/if}
</div>
