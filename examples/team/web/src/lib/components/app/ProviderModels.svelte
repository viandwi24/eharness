<script lang="ts">
	import ArrowsClockwiseIcon from 'phosphor-svelte/lib/ArrowsClockwise';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { filterModels, formatContext, formatPricing, type ProviderModel } from '#lib/providers/models.js';
	import { providersStore } from '#lib/providers/store.svelte.js';

	/** The models of one provider profile: searchable, with context window, price and capability badges. */
	let { profileId }: { profileId: string } = $props();

	let models = $state<ProviderModel[]>([]);
	let loading = $state(true);
	let error = $state('');
	let query = $state('');
	let limit = $state(40);

	let seq = 0;
	async function load(refresh = false): Promise<void> {
		const mine = ++seq;
		loading = true;
		error = '';
		try {
			const list = await providersStore.models(profileId, refresh);
			if (mine === seq) models = list;
		} catch (e) {
			if (mine === seq) {
				models = [];
				error = e instanceof Error ? e.message : 'Could not load the models';
			}
		} finally {
			if (mine === seq) loading = false;
		}
	}
	$effect(() => {
		void profileId;
		query = '';
		limit = 40;
		void load();
	});

	const matches = $derived(filterModels(models, query, limit));
</script>

<section class="flex flex-col gap-3">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h3 class="text-sm font-medium">Models {#if !loading && !error}<span class="font-normal text-muted-foreground">{models.length}</span>{/if}</h3>
		<Button size="xs" variant="ghost" disabled={loading} onclick={() => load(true)}><ArrowsClockwiseIcon class="size-3.5" />Refresh</Button>
	</div>
	{#if models.length > 8 || query}
		<div class="relative">
			<MagnifyingGlassIcon class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
			<Input bind:value={query} placeholder="Search models" aria-label="Search models" class="pl-8" oninput={() => (limit = 40)} />
		</div>
	{/if}
	{#if loading}
		<div class="flex flex-col gap-2"><Skeleton class="h-11 rounded-lg" /><Skeleton class="h-11 rounded-lg" /><Skeleton class="h-11 rounded-lg" /></div>
	{:else if error}
		<p class="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive-text" role="alert">{error}</p>
	{:else if models.length === 0}
		<p class="rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">This provider lists no models. Type a model id when you pick one for an agent.</p>
	{:else if matches.total === 0}
		<p class="px-1 py-3 text-sm text-muted-foreground">No model matches “{query.trim()}”.</p>
	{:else}
		<ul class="divide-y divide-border overflow-hidden rounded-xl border border-border">
			{#each matches.items as m (m.id)}
				<li class="flex flex-col gap-1.5 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
					<div class="min-w-0">
						<p class="truncate text-sm font-medium">{m.name}</p>
						<p class="truncate font-mono text-[11px] text-muted-foreground">{m.id}</p>
					</div>
					<div class="flex shrink-0 flex-wrap items-center gap-1.5">
						{#if m.tools}<Badge variant="secondary">Tools</Badge>{/if}
						{#if m.reasoning}<Badge variant="info">Reasoning</Badge>{/if}
						{#if m.contextWindow}<Badge variant="outline">{formatContext(m.contextWindow)} context</Badge>{/if}
						{#if m.pricing}<span class="text-[11px] text-muted-foreground tabular-nums">{formatPricing(m.pricing)}</span>{/if}
					</div>
				</li>
			{/each}
		</ul>
		{#if matches.total > matches.items.length}
			<Button size="sm" variant="ghost" class="self-center" onclick={() => (limit += 60)}>Show more ({matches.total - matches.items.length} left)</Button>
		{/if}
	{/if}
</section>
