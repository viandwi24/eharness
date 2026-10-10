<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import GearIcon from 'phosphor-svelte/lib/Gear';
	import ListChecksIcon from 'phosphor-svelte/lib/ListChecks';
	import ClockIcon from 'phosphor-svelte/lib/Clock';
	import FolderOpenIcon from 'phosphor-svelte/lib/FolderOpen';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import * as Sidebar from '#lib/components/ui/sidebar/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { openNewAgent } from '#lib/stores/dialogs.svelte.js';
	import { formatTime } from '#lib/format.js';
	import { live } from '#lib/stores/live.svelte.js';
	import ThemeToggle from './ThemeToggle.svelte';

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
	const pendingCount = $derived(live.state.approvals.length);
	const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

	onMount(() => void agentsStore.load());

	const nav = [
		{ href: '/tasks', label: 'Tasks', icon: ListChecksIcon },
		{ href: '/routines', label: 'Routines', icon: ClockIcon },
		{ href: '/files', label: 'Files', icon: FolderOpenIcon }
	];

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
		<div class="flex items-center justify-between">
			<a href="/" class="px-1 font-brand text-base">Team</a>
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

	<Sidebar.Menu class="gap-0.5 px-2" aria-label="Workspace">
		{#each nav as n (n.href)}
			<Sidebar.MenuItem>
				<Sidebar.MenuButton isActive={page.url.pathname.startsWith(n.href)}>
					{#snippet child({ props })}
						<a href={n.href} {...props}>
							<n.icon />
							<span>{n.label}</span>
						</a>
					{/snippet}
				</Sidebar.MenuButton>
				{#if n.href === '/tasks' && pendingCount > 0}
					<Sidebar.MenuBadge aria-label="{pendingCount} waiting for approval">{pendingCount}</Sidebar.MenuBadge>
				{/if}
			</Sidebar.MenuItem>
		{/each}
	</Sidebar.Menu>

	<div class="mt-2 flex items-center justify-between px-3">
		<span class="px-1 text-xs font-semibold text-sidebar-foreground/70">Agents</span>
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="ghost" size="icon-xs" aria-label="New agent" onclick={openNewAgent}>
						<PlusIcon class="size-3.5" />
					</Button>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content>New agent</Tooltip.Content>
		</Tooltip.Root>
	</div>

	<nav class="mt-1 min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="Agents">
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

	<div class="flex items-center gap-1 border-t border-border p-2">
		<Sidebar.Menu class="flex-1">
			<Sidebar.MenuItem>
				<Sidebar.MenuButton isActive={page.url.pathname.startsWith('/settings')}>
					{#snippet child({ props })}
						<a href="/settings" {...props}>
							<GearIcon />
							<span>Settings</span>
						</a>
					{/snippet}
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
		<ThemeToggle />
	</div>
</div>
