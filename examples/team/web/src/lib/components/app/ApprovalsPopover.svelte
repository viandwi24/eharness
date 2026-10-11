<script lang="ts">
	import BellIcon from 'phosphor-svelte/lib/Bell';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { goto } from '$app/navigation';
	import type { Approval } from '#lib/api/client.js';
	import { decisionText } from '#lib/decisions/model.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { openTask } from '#lib/stores/drawer.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';

	/** Where the list opens from the bell (the rail opens it to the right). */
	let { side = 'top', align = 'end' }: { side?: 'top' | 'right' | 'bottom' | 'left'; align?: 'start' | 'center' | 'end' } = $props();
	const count = $derived(live.state.approvals.length + live.state.decisions.length);
	let open = $state(false);

	/** Where the request is answered: the task view of a task, the agent's DM chat otherwise. */
	const place = (a: Approval): string => (a.taskId ? (live.state.tasks.find((t) => t.id === a.taskId)?.title ?? 'a task') : 'the chat');
	const text = (a: Approval): string =>
		a.kind === 'question' ? `${a.agentName} asked you a question in ${place(a)}` : `${a.agentName} is waiting for your approval in ${place(a)}`;
	/** A general line for each open decision; it only links to the Decision Center, where it is decided. */
	const agentName = (id: string): string => agentsStore.find(id)?.name ?? 'An agent';
	function goDecisions(): void {
		open = false;
		void goto('/decisions');
	}
	/** Notifications only link: the answer is given inline in the session's chat. */
	function go(a: Approval): void {
		open = false;
		if (a.taskId) openTask(a.taskId);
		else void goto(`/a/${a.agentId}`);
	}
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
	<Popover.Content elevation="floating" {side} {align} class="flex max-h-[70svh] w-[min(92vw,24rem)] flex-col gap-2 overflow-y-auto p-2">
		<div class="px-1 pt-1 text-sm font-medium">Notifications</div>
		{#each live.state.decisions as d (d.id)}
			<button type="button" class="rounded-md px-2 py-2 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" data-testid="notification-decision" onclick={goDecisions}>
				{decisionText(d, agentName(d.agentId))}
			</button>
		{/each}
		{#each live.state.approvals as a (a.sessionId + a.id)}
			<button type="button" class="rounded-md px-2 py-2 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" data-testid="notification" onclick={() => go(a)}>
				{text(a)}
			</button>
		{/each}
		{#if live.state.approvals.length + live.state.decisions.length === 0}
			<p class="px-1 py-4 text-center text-sm text-muted-foreground">Nothing waiting.</p>
		{/if}
	</Popover.Content>
</Popover.Root>
