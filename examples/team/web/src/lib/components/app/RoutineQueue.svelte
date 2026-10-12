<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { api } from '#lib/api/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { live } from '#lib/stores/live.svelte.js';
	import type { components } from '#lib/api/schema.js';

	type Routine = components['schemas']['Routine'];

	/**
	 * A routine in the agent chat is skipped while an input of that chat is still queued ("overlap: an
	 * input of the session is still queued"). Shows what is queued and lets the owner clear it.
	 */
	let { routine }: { routine: Routine } = $props();

	let items = $state<{ id: string; kind: string; preview: string; claimed: boolean }[]>([]);
	let busy = $state(false);
	let seq = 0;

	async function load(): Promise<void> {
		const mine = ++seq;
		try {
			const r = await api.get('/routines/{id}/queue', { params: { id: routine.id } });
			if (mine === seq) items = r.items;
		} catch {
			if (mine === seq) items = [];
		}
	}
	$effect(() => {
		void routine.id;
		void routine.lastFireAt;
		void routine.lastStatus;
		void live.state.revs.routines;
		if (routine.sessionMode === 'dm') void load();
	});

	async function clear(): Promise<void> {
		busy = true;
		try {
			const r = await api.post('/routines/{id}/queue/clear', { params: { id: routine.id } });
			items = r.items;
			toast.success(`Cleared ${r.removed ?? 0} queued input${r.removed === 1 ? '' : 's'}; the next run goes ahead`);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not clear the queue');
		} finally {
			busy = false;
		}
	}
</script>

{#if items.length}
	<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
	<div class="mt-1 flex flex-col gap-1 rounded-md border border-warning/40 bg-warning-soft px-2 py-1.5 text-xs text-warning-text" data-testid="routine-queue" onclick={(e) => e.stopPropagation()}>
		<div class="flex items-center gap-2">
			<span class="min-w-0 flex-1">{items.length} input{items.length === 1 ? '' : 's'} still queued in the agent chat: this routine is skipped until {items.length === 1 ? 'it is' : 'they are'} handled.</span>
			<Button size="xs" variant="outline" disabled={busy} onclick={() => void clear()}>Clear queued input</Button>
		</div>
		<ul class="text-muted-foreground">
			{#each items.slice(0, 3) as it (it.id)}
				<li class="truncate">{it.claimed ? 'being handled: ' : ''}{it.preview || it.kind}</li>
			{/each}
		</ul>
	</div>
{/if}
