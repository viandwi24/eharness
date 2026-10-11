<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import NewspaperIcon from 'phosphor-svelte/lib/Newspaper';
	import ChatCircleIcon from 'phosphor-svelte/lib/ChatCircle';
	import { toast } from 'svelte-sonner';
	import { api } from '#lib/api/index.js';
	import type { Briefing } from '#lib/api/client.js';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { groupItems, pickBriefing } from '#lib/briefings/model.js';
	import { live } from '#lib/stores/live.svelte.js';
	import { threadsStore } from '#lib/stores/threads.svelte.js';
	import { threadHref } from '#lib/threads/model.js';

	let list = $state<Briefing[] | null>(null);
	let error = $state('');
	let seq = 0;
	const wanted = $derived(page.url.searchParams.get('id'));
	const current = $derived(pickBriefing(list ?? [], wanted));
	const groups = $derived(current ? groupItems(current.items) : []);

	async function load(): Promise<void> {
		const mine = ++seq;
		try {
			const r = await api.get('/briefings', { query: { limit: 60 } });
			if (mine !== seq) return;
			list = r.briefings;
			error = '';
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not load the briefings';
		}
	}
	$effect(() => {
		void live.state.revs.briefings;
		void load();
	});
	// opening a briefing clears its "ready" notification
	let seen: string | undefined;
	$effect(() => {
		const id = current?.id;
		if (!id || id === seen) return;
		seen = id;
		void api.post('/briefings/{id}/seen', { params: { id } }).catch(() => {});
	});

	/** A NEW chat with the lead, seeded with the briefing (or one item of it). */
	async function discuss(item?: number): Promise<void> {
		if (!current) return;
		try {
			const t = await threadsStore.discuss({ kind: 'briefing', ref: current.id, ...(item === undefined ? {} : { item }) });
			await goto(threadHref(t.agentId, t.id));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not open a chat');
		}
	}
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title="Briefing" description="What ran, what waits for you and what the team noticed, once a day. Quiet days have none.">
		{#if current}
			<Button size="sm" variant="outline" onclick={() => void discuss()} data-testid="discuss-briefing"><ChatCircleIcon class="size-4" /> Discuss in chat</Button>
		{/if}
	</PageHeader>
	<PageBody size="narrow" class="gap-6">
		{#if error}
			<p class="text-sm text-destructive-text" role="alert">{error} <button class="underline underline-offset-4" onclick={() => void load()}>Retry</button></p>
		{:else if !list}
			<div class="flex flex-col gap-2">{#each [0, 1, 2] as i (i)}<Skeleton class="h-20 w-full" />{/each}</div>
		{:else if !current}
			<Empty.Root class="border border-dashed border-border">
				<Empty.Header>
					<Empty.Media variant="icon"><NewspaperIcon /></Empty.Media>
					<Empty.Title>No briefing yet</Empty.Title>
					<Empty.Description>The daily briefing appears here after the first day with something to report. You also get one notification in the bell.</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{:else}
			{#if list.length > 1}
				<nav class="flex flex-wrap gap-1.5" aria-label="Days">
					{#each list as b (b.id)}
						<Button size="sm" variant={b.id === current.id ? 'secondary' : 'ghost'} aria-pressed={b.id === current.id} href="/briefings?id={b.id}">{b.day}</Button>
					{/each}
				</nav>
			{/if}
			<h2 class="text-lg font-semibold" data-testid="briefing-title">{current.title}</h2>
			{#each groups as g (g.kind)}
				<section class="flex flex-col gap-2" aria-label={g.label}>
					<h3 class="text-sm font-medium text-muted-foreground">{g.label}</h3>
					{#each g.items as { item, index } (index)}
						<div class="flex items-start gap-3 rounded-lg border border-border p-3" data-testid="briefing-item">
							<div class="min-w-0 flex-1">
								<div class="text-sm font-medium">{item.title}</div>
								{#if item.detail}<div class="text-sm text-muted-foreground">{item.detail}</div>{/if}
								{#if item.link?.startsWith('/')}<a href={item.link} class="text-xs underline underline-offset-4">Open</a>{/if}
							</div>
							<Button size="xs" variant="ghost" onclick={() => void discuss(index)}>Discuss in chat</Button>
						</div>
					{/each}
				</section>
			{/each}
		{/if}
	</PageBody>
</div>
