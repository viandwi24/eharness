<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '#lib/api/index.js';
	import ConfirmDialog from '#lib/components/app/ConfirmDialog.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { needsALookCount, attentionKind, attentionReason, RETRY_WARNING, type OutboxAttention } from '#lib/channels/model.js';
	import { formatTime } from '#lib/format.js';

	// Messages whose delivery is uncertain (being checked after a restart) or that failed and nobody
	// looked at yet. "Send again" re-queues one (it may appear twice); "Dismiss" only marks it reviewed.
	let { connectionId, onChanged }: { connectionId: string; onChanged?: () => void | Promise<void> } = $props();

	const PAGE = 10;
	let items = $state<OutboxAttention[]>([]);
	let next = $state<string | undefined>(undefined);
	let loaded = $state(false);
	let busy = $state<string | null>(null);
	let again = $state<OutboxAttention | null>(null);

	async function load(more = false): Promise<void> {
		try {
			const r = await api.get('/channels/connections/{id}/outbox/attention', { params: { id: connectionId }, query: { limit: PAGE, ...(more && next !== undefined ? { before: next } : {}) } });
			items = more ? [...items, ...r.items] : r.items;
			next = r.next;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not load the messages that need a look');
		} finally {
			loaded = true;
		}
	}

	async function act(item: OutboxAttention, what: 'retry' | 'dismiss'): Promise<void> {
		busy = item.id;
		try {
			await (what === 'retry' ? api.post('/channels/connections/{id}/outbox/{rowId}/retry', { params: { id: connectionId, rowId: item.id } }) : api.post('/channels/connections/{id}/outbox/{rowId}/dismiss', { params: { id: connectionId, rowId: item.id } }));
			toast.success(what === 'retry' ? 'Queued to send again' : 'Dismissed');
			await Promise.all([load(), onChanged?.()]);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : `Could not ${what === 'retry' ? 'send it again' : 'dismiss it'}`);
			await load();
		} finally {
			busy = null;
		}
	}

	onMount(() => {
		void load().then(() => {
			// the bell links here (#needs-a-look): scroll once the list is in
			if (location.hash === '#needs-a-look') document.getElementById('needs-a-look')?.scrollIntoView({ block: 'start' });
		});
	});
</script>

{#if !loaded || items.length > 0}
	<section id="needs-a-look" class="flex scroll-mt-4 flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-label="Needs a look" data-testid="needs-a-look">
		<div class="flex flex-col gap-1">
			<h2 class="flex items-center gap-2 text-sm font-medium">Needs a look {#if loaded}<Badge variant="secondary">{needsALookCount(items.length, next !== undefined)}</Badge>{/if}</h2>
			<p class="text-xs text-muted-foreground">Messages that may not have arrived or could not be sent. Send one again if it is missing in the chat; dismiss it once you have looked. Nothing is deleted.</p>
		</div>
		{#if !loaded}
			<p class="text-xs text-muted-foreground">Loading…</p>
		{:else}
			<ul class="flex flex-col divide-y divide-border">
				{#each items as item (item.id)}
					<li class="flex flex-col gap-2 py-3 first:pt-0 last:pb-0" data-testid="attention-row">
						<div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
							<span class="font-medium">{item.chat}</span>
							<Badge variant={item.status === 'held' ? 'secondary' : 'outline'}>{item.status === 'held' ? 'Being checked' : item.uncertain ? 'May not have arrived' : 'Not sent'}</Badge>
							<span class="text-muted-foreground">{attentionKind(item.kind)} · {formatTime(item.createdAt)}</span>
						</div>
						{#if item.preview}<p class="break-words rounded-md bg-muted/50 px-2 py-1.5 text-xs">{item.preview}</p>{/if}
						<p class="text-xs text-muted-foreground">{attentionReason(item)}</p>
						{#if item.retryable || item.dismissable}
							<div class="flex flex-wrap gap-2">
								{#if item.retryable}<Button size="sm" variant="outline" disabled={busy !== null} onclick={() => (again = item)} data-testid="send-again">Send again</Button>{/if}
								{#if item.dismissable}<Button size="sm" variant="ghost" disabled={busy !== null} onclick={() => void act(item, 'dismiss')} data-testid="dismiss">Dismiss</Button>{/if}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
			{#if next !== undefined}
				<div><Button size="sm" variant="ghost" onclick={() => void load(true)}>Show older</Button></div>
			{/if}
		{/if}
	</section>
{/if}

{#if again}
	<ConfirmDialog
		open={true}
		title="Send this message again?"
		description={`${RETRY_WARNING} It goes to ${again.chat}.`}
		confirmLabel="Send again"
		confirmVariant="default"
		onConfirm={() => {
			const item = again;
			again = null;
			if (item) void act(item, 'retry');
		}}
	/>
{/if}
