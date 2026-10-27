<script lang="ts">
	import { page } from '$app/state';
	import SidebarToggle from './SidebarToggle.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { browserNav, loadBrowserNav } from '#lib/browser/nav.svelte.js';
	import { NAV_ICONS } from '#lib/nav/icons.js';
	import { GROUPS, sectionOf, sectionsOf, type RailId, type SectionId } from '#lib/nav/sections.js';
	import { live } from '#lib/stores/live.svelte.js';
	import { cn } from '#lib/utils.js';

	/**
	 * The menu of a rail group (Work, Files, Channels, Tools, Settings): the second column next to
	 * the rail on a desktop, a row you scroll above the page on a phone (`row`).
	 */
	let { group, row = false }: { group: RailId; row?: boolean } = $props();

	const current = $derived(sectionOf(page.url.pathname));
	const title = $derived(GROUPS.find((g) => g.id === group)?.label ?? '');
	$effect(() => {
		if (group === 'tools') void loadBrowserNav();
	});
	// Browser shows once a browser is set up (or while you are on it)
	const items = $derived(sectionsOf(group).filter((s) => s.id !== 'browser' || browserNav.visible || current === 'browser'));

	/** What waits for a person: open decisions. */
	function badge(id: SectionId): { text: number; tone: 'warning' | 'secondary' } | undefined {
		if (id === 'decisions' && live.state.decisions.length > 0) return { text: live.state.decisions.length, tone: 'warning' };
		return undefined;
	}
</script>

{#if row}
	<nav class="shrink-0 border-b border-border" aria-label={title} data-testid="group-menu">
		<ul class="flex gap-1 overflow-x-auto px-3 py-2">
			{#each items as s (s.id)}
				{@const b = badge(s.id)}
				<li class="shrink-0">
					<a
						href={s.href}
						aria-current={current === s.id ? 'page' : undefined}
						class={cn(
							'flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:outline-ring',
							current === s.id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-muted/60'
						)}
					>
						{s.label}{#if b}<Badge shape="number" variant={b.tone}>{b.text}</Badge>{/if}
					</a>
				</li>
			{/each}
		</ul>
	</nav>
{:else}
	<div class="flex h-full min-h-0 flex-col" data-testid="group-menu">
		<div class="flex items-center gap-1 px-3 pt-3 pb-2">
			<h2 class="mr-auto px-1 text-base font-semibold">{title}</h2>
			<SidebarToggle />
		</div>
		<nav class="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3" aria-label={title}>
			<ul class="flex flex-col gap-0.5">
				{#each items as s (s.id)}
					{@const Icon = NAV_ICONS[s.id]}
					{@const active = current === s.id}
					{@const b = badge(s.id)}
					<li>
						<a
							href={s.href}
							aria-current={active ? 'page' : undefined}
							class={cn(
								'flex items-center gap-3 rounded-lg px-2.5 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring',
								active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
							)}
						>
							<Icon class="size-5 shrink-0" weight={active ? 'fill' : 'regular'} />
							<span class="flex min-w-0 flex-1 flex-col">
								<span class="truncate text-sm font-medium">{s.label}</span>
								<span class="truncate text-xs text-muted-foreground">{s.hint}</span>
							</span>
							{#if b}<Badge shape="number" variant={b.tone}>{b.text}</Badge>{/if}
						</a>
					</li>
				{/each}
			</ul>
		</nav>
	</div>
{/if}
