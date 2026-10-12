<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import ChatCircleDotsIcon from 'phosphor-svelte/lib/ChatCircleDots';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import StatusBadges from '#lib/components/app/channels/StatusBadges.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { channelHref, connectionHandle, sectionOfPath, sectionsOf, type SectionId } from '#lib/channels/model.js';
	import { ConnectionState, provideConnection } from '#lib/channels/connection.svelte.js';
	import { IsMobile } from '#lib/hooks/is-mobile.svelte.js';
	import { pollWhileVisible } from '#lib/hooks/poll.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';

	// The shell of one channel: a menu of its sections (a left column on a desktop, a row you scroll
	// on a phone) and the section itself. The connection is loaded here once and looked at again
	// while the page is visible (there is no push for transport state); the pages read it from the context.
	let { children }: { children: Snippet } = $props();

	const id = $derived(page.params.id ?? '');
	const cs = new ConnectionState(() => id);
	provideConnection(cs);
	const mobile = new IsMobile();
	const conn = $derived(cs.conn);
	const sections = $derived(sectionsOf(conn));
	const current = $derived<SectionId>(sectionOfPath(page.url.pathname, id));

	$effect(() => {
		void id;
		cs.reset();
		void cs.load();
	});
	// a channel without an agent has only the overview and the settings: other addresses go to the overview
	$effect(() => {
		if (conn && !sections.some((s) => s.id === current)) void goto(channelHref(id, 'overview'), { replace: true });
	});
	onMount(() => {
		if (!agentsStore.state.loaded) void agentsStore.load();
		return pollWhileVisible(() => void cs.load());
	});

	/** A small count next to a section: what is there, or what waits for a person. */
	function badge(s: SectionId): { text: number; tone: 'secondary' | 'warning' | 'destructive' } | undefined {
		if (!conn) return undefined;
		if (s === 'chats' && conn.counts.chats > 0) return { text: conn.counts.chats, tone: 'secondary' };
		if (s === 'people' && conn.counts.unlinked > 0) return { text: conn.counts.unlinked, tone: 'warning' };
		if (s === 'delivery' && conn.counts.outboxFailed > 0) return { text: conn.counts.outboxFailed, tone: 'destructive' };
		return undefined;
	}
</script>

{#if cs.notFound}
	<div class="flex min-h-0 min-w-0 flex-1 flex-col">
		<PageHeader title="Channel not found" breadcrumb={[{ label: 'Channels', href: '/channels' }]} backHref="/channels" />
		<PageBody size="narrow">
			<Empty.Root class="border border-dashed border-border" data-testid="channel-not-found">
				<Empty.Header>
					<Empty.Media variant="icon"><ChatCircleDotsIcon /></Empty.Media>
					<Empty.Title>This channel does not exist</Empty.Title>
					<Empty.Description>It may have been removed on the Connectors page.</Empty.Description>
				</Empty.Header>
				<Button size="sm" href="/channels">All channels</Button>
			</Empty.Root>
		</PageBody>
	</div>
{:else if !conn}
	<div class="flex min-h-0 min-w-0 flex-1 flex-col">
		<PageHeader title="Channel" breadcrumb={[{ label: 'Channels', href: '/channels' }]} backHref="/channels" />
		<PageBody size="narrow">
			{#if cs.error && cs.loaded}
				<p class="text-sm text-destructive-text" role="alert">{cs.error} <button class="underline underline-offset-4" onclick={() => void cs.load()}>Try again</button></p>
			{:else}
				<div class="flex flex-col gap-3" aria-busy="true">{#each [0, 1, 2] as i (i)}<Skeleton class="h-16 w-full rounded-xl" />{/each}</div>
			{/if}
		</PageBody>
	</div>
{:else}
	<div class="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
		{#if mobile.current}
			<nav class="shrink-0 border-b border-border" aria-label="{conn.label} sections" data-testid="channel-menu">
				<ul class="flex gap-1 overflow-x-auto px-3 py-2">
					{#each sections as s (s.id)}
						{@const b = badge(s.id)}
						<li class="shrink-0">
							<a
								href={channelHref(id, s.id)}
								aria-current={current === s.id ? 'page' : undefined}
								class="flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:outline-ring {current === s.id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-muted/60'}"
							>
								{s.label}{#if b}<Badge shape="number" variant={b.tone}>{b.text}</Badge>{/if}
							</a>
						</li>
					{/each}
				</ul>
			</nav>
		{:else}
			<nav class="flex w-56 shrink-0 flex-col gap-3 overflow-y-auto border-r border-border p-3" aria-label="{conn.label} sections" data-testid="channel-menu">
				<div class="flex flex-col gap-1.5 px-2 pt-1">
					<span class="truncate text-sm font-medium">{conn.label}</span>
					{#if connectionHandle(conn)}<span class="truncate text-xs text-muted-foreground">{connectionHandle(conn)}</span>{/if}
					<div class="flex flex-wrap gap-1"><StatusBadges {conn} /></div>
				</div>
				<ul class="flex flex-col gap-0.5">
					{#each sections as s (s.id)}
						{@const b = badge(s.id)}
						<li>
							<a
								href={channelHref(id, s.id)}
								aria-current={current === s.id ? 'page' : undefined}
								class="flex h-8 items-center justify-between gap-2 rounded-md px-2 text-[13px] font-medium outline-none focus-visible:outline-2 focus-visible:outline-ring {current === s.id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}"
							>
								{s.label}{#if b}<Badge shape="number" variant={b.tone}>{b.text}</Badge>{/if}
							</a>
						</li>
					{/each}
				</ul>
			</nav>
		{/if}
		<div class="flex min-h-0 min-w-0 flex-1 flex-col">{@render children()}</div>
	</div>
{/if}
