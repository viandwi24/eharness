<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { ago, EVENT_LABEL, EVENT_TYPES, eventText, eventTone, type ActivityType, type ChannelActivity, type ChannelConnection, type InboxConversation } from '#lib/channels/model.js';
	import { formatTime } from '#lib/format.js';

	// Activity of one connection, newest first: what was received and what happened to it
	// (woke the agent, observed, dropped and why), replies, approvals, the breaker. Metadata only.
	// It looks again every few seconds while the tab is open and visible.
	let { conn }: { conn: ChannelConnection } = $props();

	let items = $state<ChannelActivity[] | null>(null);
	let next = $state<string | undefined>();
	let type = $state<'' | ActivityType>('');
	let conversationId = $state('');
	let conversations = $state<InboxConversation[]>([]);
	let error = $state('');
	let busy = $state(false);
	let seq = 0;

	const query = (before?: string) => ({
		limit: 50,
		...(type === '' ? {} : { type }),
		...(conversationId === '' ? {} : { conversationId }),
		...(before === undefined ? {} : { before })
	});

	/** `poll`: merge new events at the top and keep what was loaded further down. */
	async function load(poll = false): Promise<void> {
		const mine = ++seq;
		try {
			const r = await api.get('/channels/connections/{id}/activity', { params: { id: conn.id }, query: query() });
			if (mine !== seq) return;
			const oldest = r.items.at(-1)?.id;
			if (poll && items !== null && oldest !== undefined) {
				const tail = items.filter((e) => e.id < oldest);
				items = [...r.items, ...tail];
				next = tail.length > 0 ? next : r.next;
			} else {
				items = r.items;
				next = r.next;
			}
			error = '';
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not load the activity';
		}
	}
	async function more(): Promise<void> {
		if (next === undefined) return;
		busy = true;
		try {
			const r = await api.get('/channels/connections/{id}/activity', { params: { id: conn.id }, query: query(next) });
			items = [...(items ?? []), ...r.items];
			next = r.next;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not load more';
		} finally {
			busy = false;
		}
	}
	function refilter(): void {
		items = null;
		next = undefined;
		void load();
	}

	onMount(() => {
		void load();
		void api
			.get('/channels/connections/{id}/inbox', { params: { id: conn.id }, query: { limit: 100 } })
			.then((r) => (conversations = r.items))
			.catch(() => undefined);
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') void load(true);
		}, 5000);
		return () => clearInterval(timer);
	});
</script>

<div class="flex flex-col gap-3" data-testid="activity-tab">
	<div class="flex flex-wrap items-end gap-2">
		<label class="flex min-w-40 flex-1 flex-col gap-1">
			<span class="text-xs font-medium">Type</span>
			<NativeSelect bind:value={type} onchange={refilter} aria-label="Filter by type">
				<NativeSelectOption value="">All events</NativeSelectOption>
				{#each EVENT_TYPES as t (t)}<NativeSelectOption value={t}>{EVENT_LABEL[t]}</NativeSelectOption>{/each}
			</NativeSelect>
		</label>
		<label class="flex min-w-40 flex-1 flex-col gap-1">
			<span class="text-xs font-medium">Conversation</span>
			<NativeSelect bind:value={conversationId} onchange={refilter} aria-label="Filter by conversation">
				<NativeSelectOption value="">All conversations</NativeSelectOption>
				{#each conversations as c (c.conversationId)}<NativeSelectOption value={c.conversationId}>{c.title}</NativeSelectOption>{/each}
			</NativeSelect>
		</label>
	</div>
	{#if error}
		<p class="text-sm text-destructive-text" role="alert">{error}</p>
	{:else if items === null}
		<div class="flex flex-col gap-2" aria-busy="true">{#each [0, 1, 2] as i (i)}<Skeleton class="h-10 w-full rounded-lg" />{/each}</div>
	{:else if items.length === 0}
		<p class="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid="activity-empty">Nothing yet{type !== '' || conversationId !== '' ? ' for this filter' : ''}. Events appear when somebody writes to this connection or the agent sends something.</p>
	{:else}
		<ul class="flex flex-col divide-y divide-border rounded-lg border border-border" data-testid="activity-list">
			{#each items as e (e.id)}
				<li class="flex flex-col gap-1 p-3" data-testid="activity-event">
					<div class="flex min-w-0 flex-wrap items-center gap-2">
						<Badge variant={eventTone(e.type)}>{EVENT_LABEL[e.type]}</Badge>
						<span class="ml-auto shrink-0 text-xs text-muted-foreground" title={formatTime(e.at)}>{ago(e.at, Date.now())}</span>
					</div>
					{#if eventText(e)}<p class="break-words text-xs text-muted-foreground">{eventText(e)}</p>{/if}
				</li>
			{/each}
		</ul>
		{#if next !== undefined}
			<div class="flex justify-center"><Button size="sm" variant="outline" onclick={() => void more()} disabled={busy}>Load older events</Button></div>
		{/if}
	{/if}
</div>
