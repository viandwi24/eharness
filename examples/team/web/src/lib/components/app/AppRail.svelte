<script lang="ts">
	import { page } from '$app/state';
	import SignOutIcon from 'phosphor-svelte/lib/SignOut';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { NAV_ICONS } from '#lib/nav/icons.js';
	import { lastWork } from '#lib/nav/last-work.svelte.js';
	import { RAIL, railOf } from '#lib/nav/sections.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';
	import { cn } from '#lib/utils.js';
	import ApprovalsPopover from './ApprovalsPopover.svelte';
	import ThemeToggle from './ThemeToggle.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { auth, signOut } from '#lib/stores/auth.svelte.js';
	import { scrollFades } from '#lib/nav/fades.js';

	/**
	 * Main navigation as an icon rail (WhatsApp / Slack style): sections at the top, notifications,
	 * theme and settings at the bottom. `bar`: the same items as a bottom tab bar on mobile. The agent's
	 * work (tasks, briefing, decisions, programs, routines) is one item with its own menu.
	 */
	let { bar = false }: { bar?: boolean } = $props();

	const current = $derived(railOf(page.url.pathname));
	$effect(() => lastWork.visit(page.url.pathname));
	const unread = $derived(Object.values(agentsStore.state.activity).reduce((n, a) => n + (a?.unread ? 1 : 0), 0));
	const decisionCount = $derived(live.state.decisions.length);
	const briefingCount = $derived(live.state.notifications.filter((n) => n.kind === 'briefing').length);
	const main = RAIL.filter((s) => s.id !== 'settings');
	const settings = RAIL.find((s) => s.id === 'settings')!;
	const hrefOf = (s: (typeof RAIL)[number]): string => (s.id === 'work' ? lastWork.href : s.href);

	// The bottom bar scrolls sideways: it fades where more tabs are hidden.
	let strip = $state<HTMLElement | null>(null);
	let fades = $state({ left: false, right: false });
	function measure(): void {
		if (strip) fades = scrollFades(strip.scrollLeft, strip.clientWidth, strip.scrollWidth);
	}
	$effect(() => {
		if (!strip) return;
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(strip);
		return () => ro.disconnect();
	});
</script>

{#snippet item(s: (typeof RAIL)[number])}
	{@const Icon = NAV_ICONS[s.id]}
	{@const active = current === s.id}
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<a
					{...props}
					href={hrefOf(s)}
					aria-label={s.label}
					aria-current={active ? 'page' : undefined}
					class={cn(
						'relative flex items-center justify-center rounded-xl text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
						bar ? 'h-11 min-w-16 flex-1 flex-col gap-0.5 rounded-lg text-[10px]' : 'size-10',
						active && 'bg-accent text-foreground'
					)}
				>
					<Icon class="size-5" weight={active ? 'fill' : 'regular'} />
					{#if bar}<span>{s.label}</span>{/if}
					{#if s.id === 'work' && decisionCount > 0}
						<Badge shape="number" variant="warning" class="absolute top-0.5 right-0.5 h-4 min-w-4 px-1 text-[10px]" aria-label="{decisionCount} decisions waiting">{decisionCount}</Badge>
					{:else if s.id === 'work' && briefingCount > 0}
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
	<div class="relative shrink-0 border-t border-border bg-sidebar">
		<nav bind:this={strip} onscroll={measure} class="flex items-center gap-1 overflow-x-auto px-2 py-1.5" aria-label="Main">
			{#each [...main, settings] as s (s.id)}{@render item(s)}{/each}
		</nav>
		{#if fades.left}<div class="pointer-events-none absolute inset-y-0 left-0 w-8 bg-linear-to-r from-sidebar to-transparent" data-testid="bar-fade-left"></div>{/if}
		{#if fades.right}<div class="pointer-events-none absolute inset-y-0 right-0 w-8 bg-linear-to-l from-sidebar to-transparent" data-testid="bar-fade-right"></div>{/if}
	</div>
{:else}
	<nav class="flex h-full w-14 shrink-0 flex-col items-center gap-1 py-3" aria-label="Main">
		<a href="/" class="mb-2 flex size-9 items-center justify-center rounded-xl bg-foreground font-brand text-sm text-background" aria-label="Team home">T</a>
		{#each main as s (s.id)}{@render item(s)}{/each}
		<div class="mt-auto flex flex-col items-center gap-1">
			<ThemeToggle />
			{#if auth.required}
				<Button variant="ghost" size="icon-sm" aria-label="Log out" title="Log out" onclick={() => void signOut()}><SignOutIcon class="size-4" /></Button>
			{/if}
			<ApprovalsPopover side="right" align="end" />
			{@render item(settings)}
		</div>
	</nav>
{/if}
