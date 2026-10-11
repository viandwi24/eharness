<script lang="ts">
	import { page } from '$app/state';
	import NewspaperIcon from 'phosphor-svelte/lib/Newspaper';
	import ChatsCircleIcon from 'phosphor-svelte/lib/ChatsCircle';
	import ClockIcon from 'phosphor-svelte/lib/Clock';
	import FolderOpenIcon from 'phosphor-svelte/lib/FolderOpen';
	import GavelIcon from 'phosphor-svelte/lib/Gavel';
	import GearIcon from 'phosphor-svelte/lib/Gear';
	import ListChecksIcon from 'phosphor-svelte/lib/ListChecks';
	import PlugsConnectedIcon from 'phosphor-svelte/lib/PlugsConnected';
	import PulseIcon from 'phosphor-svelte/lib/Pulse';
	import StrategyIcon from 'phosphor-svelte/lib/Strategy';
	import type { Component } from 'svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { SECTIONS, sectionOf, type SectionId } from '#lib/nav/sections.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';
	import { cn } from '#lib/utils.js';
	import ApprovalsPopover from './ApprovalsPopover.svelte';
	import ThemeToggle from './ThemeToggle.svelte';

	/**
	 * Main navigation as an icon rail (WhatsApp / Slack style): sections at the top, notifications,
	 * theme and settings at the bottom. `bar`: the same items as a bottom tab bar on mobile.
	 */
	let { bar = false }: { bar?: boolean } = $props();

	const ICONS: Record<SectionId, Component> = {
		agents: ChatsCircleIcon,
		tasks: ListChecksIcon,
		briefings: NewspaperIcon,
		decisions: GavelIcon,
		programs: StrategyIcon,
		routines: ClockIcon,
		files: FolderOpenIcon,
		connectors: PlugsConnectedIcon,
		logs: PulseIcon,
		settings: GearIcon
	};
	const current = $derived(sectionOf(page.url.pathname));
	const unread = $derived(Object.values(agentsStore.state.activity).reduce((n, a) => n + (a?.unread ? 1 : 0), 0));
	const decisionCount = $derived(live.state.decisions.length);
	const briefingCount = $derived(live.state.notifications.filter((n) => n.kind === 'briefing').length);
	const main = SECTIONS.filter((s) => s.id !== 'settings');
	const settings = SECTIONS.find((s) => s.id === 'settings')!;
</script>

{#snippet item(s: (typeof SECTIONS)[number])}
	{@const Icon = ICONS[s.id]}
	{@const active = current === s.id}
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<a
					{...props}
					href={s.href}
					aria-label={s.label}
					aria-current={active ? 'page' : undefined}
					class={cn(
						'relative flex items-center justify-center rounded-xl text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
						bar ? 'h-11 flex-1 flex-col gap-0.5 rounded-lg text-[10px]' : 'size-10',
						active && 'bg-accent text-foreground'
					)}
				>
					<Icon class="size-5" weight={active ? 'fill' : 'regular'} />
					{#if bar}<span>{s.label}</span>{/if}
					{#if s.id === 'decisions' && decisionCount > 0}
						<Badge shape="number" variant="warning" class="absolute top-0.5 right-0.5 h-4 min-w-4 px-1 text-[10px]" aria-label="{decisionCount} decisions waiting">{decisionCount}</Badge>
					{/if}
					{#if s.id === 'briefings' && briefingCount > 0}
						<span class="absolute top-1.5 right-1.5 size-2 rounded-full bg-brand" aria-label="New briefing"></span>
					{/if}
					{#if s.id === 'agents' && unread > 0}
						<span class="absolute top-1.5 right-1.5 size-2 rounded-full bg-brand" aria-label="{unread} unread chats"></span>
					{/if}
				</a>
			{/snippet}
		</Tooltip.Trigger>
		{#if !bar}<Tooltip.Content side="right">{s.label}</Tooltip.Content>{/if}
	</Tooltip.Root>
{/snippet}

{#if bar}
	<nav class="flex shrink-0 items-center gap-1 border-t border-border bg-sidebar px-2 py-1.5" aria-label="Main">
		{#each [...main, settings] as s (s.id)}{@render item(s)}{/each}
	</nav>
{:else}
	<nav class="flex h-full w-14 shrink-0 flex-col items-center gap-1 py-3" aria-label="Main">
		<a href="/" class="mb-2 flex size-9 items-center justify-center rounded-xl bg-foreground font-brand text-sm text-background" aria-label="Team home">T</a>
		{#each main as s (s.id)}{@render item(s)}{/each}
		<div class="mt-auto flex flex-col items-center gap-1">
			<ThemeToggle />
			<ApprovalsPopover side="right" align="end" />
			{@render item(settings)}
		</div>
	</nav>
{/if}
