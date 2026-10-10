<script lang="ts">
	import BellIcon from 'phosphor-svelte/lib/Bell';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { openTask } from '#lib/stores/drawer.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';
	import PendingCard from './PendingCard.svelte';

	const count = $derived(live.state.approvals.length);
	let open = $state(false);
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="ghost" size="icon-sm" aria-label="Notifications ({count} waiting)" title="Notifications" class="relative">
				<BellIcon class="size-4" />
				{#if count > 0}
					<Badge shape="number" variant="warning" class="absolute -top-1.5 -right-1.5 h-4 min-w-4 px-1 text-[10px]">{count}</Badge>
				{/if}
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content side="top" align="start" class="flex max-h-[70svh] w-[min(92vw,24rem)] flex-col gap-2 overflow-y-auto p-2">
		<div class="px-1 pt-1 text-sm font-medium">Needs your approval</div>
		{#each live.state.approvals as a (a.sessionId + a.id)}
			<PendingCard
				approval={a}
				onOpenTask={(id) => {
					open = false;
					openTask(id);
				}}
			/>
		{:else}
			<p class="px-1 py-4 text-center text-sm text-muted-foreground">Nothing waiting.</p>
		{/each}
	</Popover.Content>
</Popover.Root>
