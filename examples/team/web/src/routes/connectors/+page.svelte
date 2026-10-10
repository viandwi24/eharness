<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import { untrack } from 'svelte';
	import type { Connector } from '#lib/api/index.js';
	import ConnectFlowDialog from '#lib/components/app/ConnectFlowDialog.svelte';
	import ConnectorDetail from '#lib/components/app/ConnectorDetail.svelte';
	import ConnectorIcon from '#lib/components/app/ConnectorIcon.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { connectorsStore } from '#lib/connectors/connectors.svelte.js';
	import { categoriesOf, categoryLabel, directorySections } from '#lib/connectors/core.js';
	import StatusBadge from '#lib/components/app/config/StatusBadge.svelte';
	import { OAUTH_CLIENT_NEEDS_SETUP } from '#lib/connectors/view.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';
	import { cn } from '#lib/utils.js';

	const store = connectorsStore.state;

	let query = $state('');
	let category = $state<string | null>(null);
	let selectedId = $state<string | null>(null);
	let detailOpen = $state(false);

	const sections = $derived(directorySections(store.connectors, store.connections, { query, category }));
	const categories = $derived(categoriesOf(store.connectors));
	const total = $derived(sections.connected.length + sections.available.length + sections.included.length);
	const accountOf = (c: Connector): string | undefined => store.connections.find((x) => x.definitionId === c.id && x.accountLabel)?.accountLabel;
	const countOf = (c: Connector): number => store.connections.filter((x) => x.definitionId === c.id).length;

	// first load, and a refetch when another tab or instance changes a connection
	$effect(() => {
		void live.state.revs.connectors;
		untrack(() => {
			void connectorsStore.load();
			if (!agentsStore.state.loaded) void agentsStore.load();
		});
	});

	// the Connect button of a card starts the flow right away (like Claude); a connector whose
	// OAuth app is not set up yet opens its details, where the admin sets it up
	let connectId = $state<string | undefined>(undefined);
	let connectOpen = $state(false);
	function connect(c: Connector): void {
		if (OAUTH_CLIENT_NEEDS_SETUP(c)) return openDetail(c);
		connectId = c.id;
		connectOpen = true;
	}

	function openDetail(c: Connector): void {
		selectedId = c.id;
		detailOpen = true;
	}

	// --- resume after an OAuth redirect: /connectors?flow=<id> or ?oauth_error=<message> -------
	let flowId = $state<string | undefined>(undefined);
	let flowOpen = $state(false);
	let handledFlow = '';
	$effect(() => {
		const f = page.url.searchParams.get('flow');
		const err = page.url.searchParams.get('oauth_error');
		untrack(() => {
			if (f && f !== handledFlow) {
				handledFlow = f;
				flowId = f;
				flowOpen = true;
			}
			if (err) {
				toast.error(err);
				void goto('/connectors', { replaceState: true });
			}
		});
	});
	$effect(() => {
		if (!flowOpen && flowId) {
			flowId = undefined;
			handledFlow = '';
			if (page.url.searchParams.has('flow')) void goto('/connectors', { replaceState: true });
		}
	});
</script>

{#snippet card(c: Connector)}
	{@const account = accountOf(c)}
	{@const n = countOf(c)}
	<div class="flex h-full flex-col rounded-xl border border-border bg-card transition-colors hover:bg-accent/50">
		<button
			type="button"
			onclick={() => openDetail(c)}
			class="flex flex-1 flex-col gap-3 rounded-t-xl p-4 pb-2 text-left outline-none focus-visible:outline-2 focus-visible:outline-ring"
		>
			<div class="flex items-start gap-3">
				<ConnectorIcon icon={c.icon} />
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm font-medium">{c.name}</p>
					<Badge variant="secondary" class="mt-1">{categoryLabel(c.category)}</Badge>
				</div>
			</div>
			<p class="line-clamp-2 text-[13px] text-muted-foreground">{c.description}</p>
		</button>
		<div class="flex items-center gap-2 px-4 pt-1 pb-4">
			{#if c.builtin}
				<StatusBadge status="included" />
			{:else if n > 0}
				<StatusBadge status="connected" />
				{#if account}<span class="min-w-0 truncate text-xs text-muted-foreground">{account}</span>{/if}
			{:else}
				<Button size="sm" variant="outline" onclick={() => connect(c)}>Connect</Button>
			{/if}
		</div>
	</div>
{/snippet}

{#snippet group(title: string, items: Connector[])}
	{#if items.length}
		<section class="flex flex-col gap-3">
			<h2 class="text-sm font-medium">{title} <span class="font-normal text-muted-foreground">{items.length}</span></h2>
			<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
				{#each items as c (c.id)}{@render card(c)}{/each}
			</div>
		</section>
	{/if}
{/snippet}

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title="Connectors" description="Connect tools and services your agents can use" />

	<div class="min-h-0 flex-1 overflow-y-auto">
		<div class="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-6">
			<div class="flex flex-col gap-3">
				<div class="relative max-w-sm">
					<MagnifyingGlassIcon class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input bind:value={query} placeholder="Search connectors" aria-label="Search connectors" class="pl-8" />
				</div>
				{#if categories.length > 1}
					<div class="flex flex-wrap gap-1.5" role="group" aria-label="Category">
						{#each [null, ...categories] as c (c ?? 'all')}
							<button
								type="button"
								aria-pressed={category === c}
								onclick={() => (category = c)}
								class={cn(
									'h-7 rounded-full border px-3 text-xs font-medium transition-colors outline-none focus-visible:outline-2 focus-visible:outline-ring',
									category === c ? 'border-transparent bg-foreground text-background' : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'
								)}>{c === null ? 'All' : categoryLabel(c)}</button
							>
						{/each}
					</div>
				{/if}
			</div>

			{#if store.error && !store.loaded}
				<Empty.Root class="border p-8">
					<Empty.Header>
						<Empty.Title class="text-sm">Could not load connectors</Empty.Title>
						<Empty.Description>{store.error}</Empty.Description>
					</Empty.Header>
					<Button size="sm" variant="outline" onclick={() => connectorsStore.load()}>Try again</Button>
				</Empty.Root>
			{:else if !store.loaded}
				<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
					{#each [0, 1, 2, 3, 4, 5] as n (n)}<Skeleton class="h-36 rounded-xl" />{/each}
				</div>
			{:else if total === 0}
				<Empty.Root class="border p-8">
					<Empty.Header>
						<Empty.Title class="text-sm">{query || category ? 'No connectors match' : 'No connectors yet'}</Empty.Title>
						<Empty.Description>{query || category ? 'Try a different search or category.' : 'Connectors the server offers show up here.'}</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{:else}
				{@render group('Connected', sections.connected)}
				{@render group('Available', sections.available)}
				{@render group('Included', sections.included)}
			{/if}
		</div>
	</div>
</div>

<ConnectorDetail bind:open={detailOpen} connectorId={selectedId} />
<ConnectFlowDialog bind:open={flowOpen} {flowId} onDone={() => void connectorsStore.load()} />
<ConnectFlowDialog bind:open={connectOpen} definitionId={connectId} scope="workspace" onDone={() => void connectorsStore.load()} />
