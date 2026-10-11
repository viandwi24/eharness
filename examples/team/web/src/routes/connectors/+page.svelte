<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircle';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import PlugsIcon from 'phosphor-svelte/lib/Plugs';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import { untrack } from 'svelte';
	import type { ConnectFlow, Connection, Connector } from '#lib/api/index.js';
	import AddCustomConnectorDialog from '#lib/components/app/AddCustomConnectorDialog.svelte';
	import ConnectFlowDialog from '#lib/components/app/ConnectFlowDialog.svelte';
	import AgentStack from '#lib/components/app/AgentStack.svelte';
	import ConnectorsByAgent from '#lib/components/app/ConnectorsByAgent.svelte';
	import ConnectorDetail from '#lib/components/app/ConnectorDetail.svelte';
	import ConnectorIcon from '#lib/components/app/ConnectorIcon.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { cardUsage, distinctUsers, usageText, usersOf } from '#lib/connectors/access.js';
	import { connectorsStore } from '#lib/connectors/connectors.svelte.js';
	import { categoriesOf, categoryLabel, directorySections } from '#lib/connectors/core.js';
	import { authLabel, CUSTOM_STATE_LABEL, customConnections, customState, hostOf, initialsOf, matchesCustom } from '#lib/connectors/custom.js';
	import { OAUTH_CLIENT_NEEDS_SETUP } from '#lib/connectors/view.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';
	import { cn } from '#lib/utils.js';

	const store = connectorsStore.state;

	let query = $state('');
	let category = $state<string | null>(null);
	let selectedId = $state<string | null>(null);
	let detailOpen = $state(false);
	let selectedConnectionId = $state<string | null>(null);

	const sections = $derived(directorySections(store.connectors, store.connections, { query, category }));
	// every custom connection is a card of its own, under the name its user gave it
	const customs = $derived(customConnections(store.connections).filter((c) => matchesCustom(c, query) && (!category || category === 'custom')));
	const connectedCount = $derived(sections.connected.length + customs.length);
	const categories = $derived(categoriesOf(store.connectors, store.connections));
	const total = $derived(sections.connected.length + sections.available.length + sections.included.length + customs.length);
	const agents = $derived(agentsStore.state.agents);
	let view = $state<'connectors' | 'agents'>('connectors');
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
		selectedConnectionId = null;
		detailOpen = true;
	}
	function openCustom(c: Connection): void {
		selectedId = c.definitionId;
		selectedConnectionId = c.id;
		detailOpen = true;
	}

	function openAccount(c: Connection): void {
		const connector = store.connectors.find((x) => x.id === c.definitionId);
		if (c.custom || !connector) openCustom(c);
		else openDetail(connector);
	}

	// --- add a custom connector ------------------------------------------------------------
	let addOpen = $state(false);
	let signInFlowId = $state<string | undefined>(undefined);
	let signInOpen = $state(false);
	function added(c: Connection, flow?: ConnectFlow): void {
		void connectorsStore.load();
		toast.success(`${c.label} added`);
		if (flow) {
			signInConnectionId = c.id;
			signInFlowId = flow.id;
			signInOpen = true;
		}
	}
	// "Sign in" of a card whose connector is waiting for it
	let signInConnectionId = $state<string | undefined>(undefined);
	let signInConnectionOpen = $state(false);
	function signIn(c: Connection): void {
		signInConnectionId = c.id;
		signInConnectionOpen = true;
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
	{@const n = countOf(c)}
	<div class="group relative flex h-full flex-col gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-accent/40 focus-within:outline-2 focus-within:outline-ring">
		<div class="flex items-start gap-3">
			<ConnectorIcon icon={c.icon} />
			<div class="min-w-0 flex-1">
				<h3 class="truncate text-sm font-medium">
					<button type="button" onclick={() => openDetail(c)} class="outline-none after:absolute after:inset-0 after:rounded-xl">{c.name}</button>
				</h3>
				<p class="truncate text-xs text-muted-foreground">{c.builtin ? 'Built in' : c.source === 'custom' ? 'Any remote MCP server' : categoryLabel(c.category)}</p>
			</div>
		</div>
		<p class="line-clamp-2 flex-1 text-[13px] leading-snug text-muted-foreground">{c.description}</p>
		<div class="relative z-10 flex min-h-7 items-center justify-between gap-2">
			{#if c.builtin}
				<span class="flex items-center gap-1.5 text-xs text-muted-foreground"><CheckCircleIcon class="size-3.5" />Included</span>
			{:else if n > 0}
				<span class="flex min-w-0 items-center gap-1.5 text-xs">
					<span class="size-1.5 shrink-0 rounded-full bg-success"></span>
					<span class="truncate text-muted-foreground">{cardUsage(store.connections.filter((x) => x.definitionId === c.id), agents)}</span>
					<AgentStack agents={distinctUsers(store.connections.filter((x) => x.definitionId === c.id), agents)} />
				</span>
				<Button size="sm" variant="ghost" onclick={() => openDetail(c)}>Manage</Button>
			{:else}
				<span class="text-xs text-muted-foreground">{c.capabilities.length ? `${c.capabilities.length} capabilities` : c.source === 'custom' ? 'No auth, API key or OAuth' : c.auth.type === 'oauth2' ? 'Sign in with OAuth' : ''}</span>
				<Button size="sm" variant="outline" onclick={() => connect(c)}>Connect</Button>
			{/if}
		</div>
	</div>
{/snippet}

{#snippet customCard(c: Connection)}
	{@const state = customState(c)}
	<div class="group relative flex h-full flex-col gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-accent/40 focus-within:outline-2 focus-within:outline-ring" data-testid="custom-card">
		<div class="flex items-start gap-3">
			<span aria-hidden="true" class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-xs font-semibold text-muted-foreground">{initialsOf(c.label)}</span>
			<div class="min-w-0 flex-1">
				<h3 class="truncate text-sm font-medium">
					<button type="button" onclick={() => openCustom(c)} class="outline-none after:absolute after:inset-0 after:rounded-xl">{c.label}</button>
				</h3>
				<p class="truncate text-xs text-muted-foreground">Custom · {hostOf(c) || 'remote MCP server'}</p>
			</div>
		</div>
		<p class="line-clamp-2 flex-1 text-[13px] leading-snug text-muted-foreground">{authLabel(c)}</p>
		<div class="relative z-10 flex min-h-7 items-center justify-between gap-2">
			<span class="flex min-w-0 items-center gap-1.5 text-xs">
				<span class="size-1.5 shrink-0 rounded-full {state === 'connected' ? 'bg-success' : state === 'error' ? 'bg-destructive' : 'bg-warning'}"></span>
				<span class="truncate text-muted-foreground">{CUSTOM_STATE_LABEL[state]} · {usageText(c, agents)}</span>
				<AgentStack agents={usersOf(c, agents)} />
			</span>
			{#if state === 'needs-sign-in'}
				<Button size="sm" variant="outline" onclick={() => signIn(c)}>Sign in</Button>
			{:else}
				<Button size="sm" variant="ghost" onclick={() => openCustom(c)}>Manage</Button>
			{/if}
		</div>
	</div>
{/snippet}

{#snippet addCard()}
	<button
		type="button"
		onclick={() => (addOpen = true)}
		data-testid="add-custom-card"
		class="flex h-full min-h-36 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border p-4 text-muted-foreground transition-colors outline-none hover:bg-accent/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
	>
		<span class="flex size-10 items-center justify-center rounded-xl bg-muted"><PlusIcon class="size-5" /></span>
		<span class="text-sm font-medium">Add custom connector</span>
		<span class="text-xs">Any remote MCP server</span>
	</button>
{/snippet}

{#snippet group(title: string, hint: string, items: Connector[], extra?: Connection[], withAdd?: boolean)}
	{#if items.length || extra?.length || withAdd}
		<section class="flex flex-col gap-3">
			<div class="flex items-baseline gap-2">
				<h2 class="text-sm font-medium">{title}</h2>
				<span class="text-xs text-muted-foreground">{items.length + (extra?.length ?? 0)}</span>
				<span class="hidden text-xs text-muted-foreground sm:inline">· {hint}</span>
			</div>
			<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
				{#each extra ?? [] as c (c.id)}{@render customCard(c)}{/each}
				{#each items as c (c.id)}{@render card(c)}{/each}
				{#if withAdd}{@render addCard()}{/if}
			</div>
		</section>
	{/if}
{/snippet}

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title="Connectors" description="Connect the tools and services your agents can use.">
		{#snippet actions()}
			<Button size="sm" variant="outline" onclick={() => (addOpen = true)}><PlusIcon class="size-4" /><span class="hidden sm:inline">Add custom connector</span><span class="sm:hidden">Add</span></Button>
		{/snippet}
	</PageHeader>

	<PageBody size="wide" class="gap-6">
			<div role="tablist" aria-label="View" class="inline-flex w-fit rounded-lg border border-border p-0.5">
				{#each [['connectors', 'Connectors'], ['agents', 'By agent']] as const as [v, label] (v)}
					<button type="button" role="tab" aria-selected={view === v} onclick={() => (view = v)} class={cn('h-7 rounded-md px-3 text-xs font-medium transition-colors outline-none focus-visible:outline-2 focus-visible:outline-ring', view === v ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>{label}</button>
				{/each}
			</div>

			{#if view === 'agents'}
				<ConnectorsByAgent onOpenAccount={openAccount} />
			{:else}
			<div class="flex flex-col gap-3 sm:flex-row sm:items-center">
				<div class="relative w-full sm:max-w-xs">
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
				<Empty.Root class="border p-10">
					<Empty.Header>
						<Empty.Media variant="icon"><PlugsIcon /></Empty.Media>
						<Empty.Title class="text-sm">{query || category ? 'No connectors match' : 'No connectors yet'}</Empty.Title>
						<Empty.Description>
							{query || category ? `Nothing matches ${query ? `“${query.trim()}”` : categoryLabel(category ?? '')}. Try another search, or add your own remote MCP server with “Add custom connector”.` : 'Connectors the server offers show up here.'}
						</Empty.Description>
					</Empty.Header>
					{#if query || category}
						<Button size="sm" variant="outline" onclick={() => ((query = ''), (category = null))}>Clear filters</Button>
					{/if}
				</Empty.Root>
			{:else}
				{#if connectedCount === 0 && !query && !category}
					<p class="rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">Nothing connected yet. Pick a service below and select Connect.</p>
				{/if}
				{@render group('Connected', 'Ready to use by your agents', sections.connected, customs)}
				{@render group('Available', 'Connect with your account', sections.available, undefined, !query && (!category || category === 'custom'))}
				{@render group('Included', 'Built in, nothing to connect', sections.included)}
			{/if}
			{/if}
	</PageBody>
</div>

<ConnectorDetail bind:open={detailOpen} connectorId={selectedId} connectionId={selectedConnectionId} />
<AddCustomConnectorDialog bind:open={addOpen} onAdded={added} />
<ConnectFlowDialog bind:open={signInOpen} flowId={signInFlowId} signIn label={store.connections.find((x) => x.id === signInConnectionId)?.label} onDone={() => void connectorsStore.load()} />
<ConnectFlowDialog bind:open={signInConnectionOpen} connectionId={signInConnectionId} signIn label={store.connections.find((x) => x.id === signInConnectionId)?.label} scope="workspace" onDone={() => void connectorsStore.load()} />
<ConnectFlowDialog bind:open={flowOpen} {flowId} onDone={() => void connectorsStore.load()} />
<ConnectFlowDialog bind:open={connectOpen} definitionId={connectId} scope="workspace" onDone={() => void connectorsStore.load()} />
