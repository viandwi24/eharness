<script lang="ts">
	import ApprovalsPopover from './ApprovalsPopover.svelte';
	import SidebarToggle from './SidebarToggle.svelte';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { openNewAgent } from '#lib/stores/dialogs.svelte.js';
	import { formatTime } from '#lib/format.js';

	let query = $state('');
	let searchEl = $state<HTMLInputElement | null>(null);
	let searchFocused = $state(false);

	// Most recent conversation first (stable for agents without messages).
	const shown = $derived(
		agentsStore.state.agents
			.filter((a) => `${a.name} ${a.description}`.toLowerCase().includes(query.trim().toLowerCase()))
			.map((a, i) => ({ a, i, t: agentsStore.state.activity[a.id]?.lastMessageAt ?? 0 }))
			.sort((x, y) => y.t - x.t || x.i - y.i)
			.map((x) => x.a)
	);
	const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

	onMount(() => void agentsStore.load());


	function onKeydown(e: KeyboardEvent): void {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			searchEl?.focus();
			searchEl?.select();
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="flex h-full min-h-0 flex-col">
	<div class="flex flex-col gap-3 px-3 pt-3 pb-2">
		<div class="flex items-center gap-1">
			<h2 class="mr-auto px-1 text-base font-semibold">Agents</h2>
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="ghost" size="icon-sm" aria-label="New agent" onclick={openNewAgent}>
							<PlusIcon class="size-4" />
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content>New agent</Tooltip.Content>
			</Tooltip.Root>
			<!-- mobile has no rail: notifications live in this header there -->
			<span class="md:hidden"><ApprovalsPopover side="bottom" align="end" /></span>
			<SidebarToggle />
		</div>
		<div class="relative">
			<MagnifyingGlassIcon class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
			<Input
				bind:ref={searchEl}
				bind:value={query}
				onfocus={() => (searchFocused = true)}
				onblur={() => (searchFocused = false)}
				placeholder="Search agents"
				aria-label="Search agents"
				aria-keyshortcuts="Control+K Meta+K"
				class="pr-14 pl-8"
			/>
			{#if !searchFocused && !query}
				<Kbd class="absolute top-1/2 right-2 -translate-y-1/2" aria-hidden="true">{isMac ? '⌘' : 'Ctrl'} K</Kbd>
			{/if}
		</div>
	</div>

	<nav class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pb-2" aria-label="Agents">
		{#each shown as a (a.id)}
			{@const active = page.params.agentId === a.id || page.params.agentId === a.slug}
			{@const act = agentsStore.state.activity[a.id]}
			<a
				href="/a/{a.id}"
				aria-current={active ? 'page' : undefined}
				class="flex items-center gap-3 rounded-lg px-2 py-2 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring aria-[current=page]:bg-accent"
			>
				<AgentAvatar seed={a.id} color={a.color} size={36} label={a.name} />
				<span class="min-w-0 flex-1">
					<span class="flex items-baseline justify-between gap-2">
						<span class="truncate text-sm font-medium">{a.name}</span>
						<span class="shrink-0 text-xs text-muted-foreground">{formatTime(act?.lastMessageAt)}</span>
					</span>
					<span class="flex items-center justify-between gap-2">
						<span class="truncate text-xs text-muted-foreground">{act?.preview || a.description}</span>
						{#if act?.unread}<span class="size-2 shrink-0 rounded-full bg-brand" aria-label="{act.unread} unread"></span>{/if}
					</span>
				</span>
			</a>
		{:else}
			<p class="px-2 py-6 text-center text-sm text-muted-foreground">
				{#if agentsStore.state.error}
					{agentsStore.state.error}
					<button class="underline underline-offset-4" onclick={() => agentsStore.load()}>Retry</button>
				{:else if !agentsStore.state.loaded}
					Loading…
				{:else if query}
					No agents match.
				{:else}
					No agents yet.
				{/if}
			</p>
		{/each}
	</nav>

</div>
