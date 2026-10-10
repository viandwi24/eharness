<script lang="ts">
	import BellIcon from 'phosphor-svelte/lib/Bell';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import * as Sidebar from '#lib/components/ui/sidebar/index.js';
	import { openTask } from '#lib/stores/drawer.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';
	import PendingCard from './PendingCard.svelte';

	/** Inbox: everything waiting for a person (approvals, questions), as a sidebar nav row. */
	const count = $derived(live.state.approvals.length);
	let open = $state(false);
</script>

<Sidebar.MenuItem>
	<Popover.Root bind:open>
		<Popover.Trigger>
			{#snippet child({ props })}
				<Sidebar.MenuButton {...props} isActive={open} aria-label="Inbox ({count} waiting)">
					<BellIcon />
					<span>Inbox</span>
				</Sidebar.MenuButton>
			{/snippet}
		</Popover.Trigger>
		<Popover.Content side="right" align="start" sideOffset={8} class="flex max-h-[70svh] w-[min(92vw,24rem)] flex-col gap-2 overflow-y-auto p-2">
			<div class="flex items-center justify-between px-1 pt-1">
				<span class="text-sm font-medium">Inbox</span>
				<span class="text-xs text-muted-foreground">{count === 0 ? 'All clear' : `${count} waiting for you`}</span>
			</div>
			{#each live.state.approvals as a (a.sessionId + a.id)}
				<PendingCard
					approval={a}
					onOpenTask={(id) => {
						open = false;
						openTask(id);
					}}
				/>
			{:else}
				<p class="px-1 py-6 text-center text-sm text-muted-foreground">Nothing is waiting for your approval.</p>
			{/each}
		</Popover.Content>
	</Popover.Root>
	{#if count > 0}<Sidebar.MenuBadge class="bg-warning-soft text-warning-text" aria-hidden="true">{count}</Sidebar.MenuBadge>{/if}
</Sidebar.MenuItem>
