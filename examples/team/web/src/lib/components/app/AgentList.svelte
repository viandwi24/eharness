<script lang="ts">
	import { page } from '$app/state';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import GearIcon from 'phosphor-svelte/lib/Gear';
	import ListChecksIcon from 'phosphor-svelte/lib/ListChecks';
	import BooksIcon from 'phosphor-svelte/lib/Books';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { onMount } from 'svelte';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { formatTime } from '#lib/format.js';
	import { live } from '#lib/stores/live.svelte.js';
	import ThemeToggle from './ThemeToggle.svelte';

	let query = $state('');
	// Most recent conversation first (stable for agents without messages).
	const shown = $derived(
		agentsStore.state.agents
			.filter((a) => `${a.name} ${a.description}`.toLowerCase().includes(query.trim().toLowerCase()))
			.map((a, i) => ({ a, i, t: agentsStore.state.activity[a.id]?.lastMessageAt ?? 0 }))
			.sort((x, y) => y.t - x.t || x.i - y.i)
			.map((x) => x.a)
	);
	const pendingCount = $derived(live.state.approvals.length);
	onMount(() => void agentsStore.load());
	const nav = [
		{ href: '/tasks', label: 'Tasks', icon: ListChecksIcon },
		{ href: '/library', label: 'Library', icon: BooksIcon },
		{ href: '/settings', label: 'Settings', icon: GearIcon }
	];
</script>

<div class="flex h-full min-h-0 flex-col">
	<div class="flex flex-col gap-2 p-3">
		<div class="flex items-center justify-between">
			<a href="/" class="font-brand text-base">Team</a>
			<ThemeToggle />
		</div>
		<div class="relative">
			<MagnifyingGlassIcon class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
			<Input bind:value={query} placeholder="Search agents" aria-label="Search agents" class="pl-8" />
		</div>
		<Button href="/agents/new" variant="outline" class="justify-start gap-2">
			<PlusIcon class="size-4" /> New agent
		</Button>
	</div>

	<nav class="flex-1 overflow-y-auto px-2" aria-label="Agents">
		{#each shown as a (a.id)}
			{@const active = page.params.agentId === a.id || page.params.agentId === a.slug}
			{@const act = agentsStore.state.activity[a.id]}
			<a
				href="/a/{a.id}"
				aria-current={active ? 'page' : undefined}
				class="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent aria-[current=page]:bg-accent"
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
				{:else}
					No agents match.
				{/if}
			</p>
		{/each}
	</nav>

	<div class="flex items-center gap-1 border-t border-border p-2">
		{#each nav as n (n.href)}
			<Button href={n.href} variant={page.url.pathname.startsWith(n.href) ? 'secondary' : 'ghost'} size="sm" class="flex-1 gap-1.5">
				<n.icon class="size-4" />
				<span class="hidden xl:inline">{n.label}</span>
				{#if n.href === '/tasks' && pendingCount > 0}
					<Badge shape="number" variant="warning" aria-label="{pendingCount} waiting for approval" class="h-4 min-w-4 px-1 text-[10px]">{pendingCount}</Badge>
				{/if}
			</Button>
		{/each}
	</div>
</div>
