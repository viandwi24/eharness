<script lang="ts">
	import Surface from '#lib/components/app/Surface.svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount, untrack } from 'svelte';
	import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwise';
	import BellRingingIcon from 'phosphor-svelte/lib/BellRinging';
	import FunnelIcon from 'phosphor-svelte/lib/Funnel';
	import LightningIcon from 'phosphor-svelte/lib/Lightning';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import WarningCircleIcon from 'phosphor-svelte/lib/WarningCircle';
	import XIcon from 'phosphor-svelte/lib/X';
	import { api } from '#lib/api/index.js';
	import FilterChips from '#lib/components/app/FilterChips.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import EventDetailSheet from '#lib/components/events/EventDetailSheet.svelte';
	import EventTypePicker from '#lib/components/events/EventTypePicker.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import {
		RANGES,
		type EventCatalog,
		type EventFilters,
		type StreamEvent,
		activeFilterCount,
		actorHandle,
		actorName,
		actorRole,
		chatText,
		eventTime,
		filtersFromParams,
		mergeFresh,
		paramsFromFilters,
		queryOf,
		sourceText,
		typeLabel
	} from '#lib/events/events.js';

	const SIZE = 50;
	const REFRESH_MS = 10_000;

	const filters = $derived(filtersFromParams(page.url.searchParams));
	const filterKey = $derived(paramsFromFilters(filters).toString());
	const nFilters = $derived(activeFilterCount(filters));
	const selectedId = $derived(page.url.searchParams.get('e'));

	let rows = $state<StreamEvent[]>([]);
	let next = $state<string | null>(null);
	let loading = $state(true);
	let loadingMore = $state(false);
	let error = $state<string | null>(null);
	let filterOpen = $state(false);
	let catalog = $state<EventCatalog>({ types: [], connections: [] });
	let extra = $state<StreamEvent | null>(null);
	let chatInput = $state(page.url.searchParams.get('chat') ?? '');
	let actorInput = $state(page.url.searchParams.get('actor') ?? '');
	let timer: ReturnType<typeof setTimeout> | undefined;
	let req = 0;

	const selectedIndex = $derived(selectedId === null ? -1 : rows.findIndex((r) => r.id === selectedId));
	const selected = $derived(selectedIndex >= 0 ? (rows[selectedIndex] ?? null) : extra && extra.id === selectedId ? extra : null);
	const filtering = $derived(nFilters > 0);

	function go(nextFilters: EventFilters, openId: string | null = null): void {
		const qs = paramsFromFilters(nextFilters, openId).toString();
		void goto(qs ? `?${qs}` : page.url.pathname, { replace: true, reset: false });
	}
	const setFilter = (patch: Partial<EventFilters>): void => go({ ...filters, ...patch });
	const select = (id: string | null): void => go(filters, id);
	function setText(key: 'chat' | 'actor', value: string): void {
		if (key === 'chat') chatInput = value;
		else actorInput = value;
		clearTimeout(timer);
		timer = setTimeout(() => setFilter({ [key]: value.trim() }), 300);
	}
	function clearFilters(): void {
		chatInput = '';
		actorInput = '';
		go({ ...filters, source: '', types: [], connectionId: '', chat: '', actor: '' });
	}

	async function load(): Promise<void> {
		const mine = ++req;
		loading = true;
		error = null;
		try {
			const res = await api.get('/events', { query: { ...queryOf(filters, Date.now()), limit: SIZE } as never });
			if (mine !== req) return;
			rows = res.items;
			next = res.next ?? null;
		} catch (e) {
			if (mine === req) error = e instanceof Error ? e.message : String(e);
		} finally {
			if (mine === req) loading = false;
		}
	}

	/** A quiet refresh: new events on top without the skeleton. */
	async function refreshQuiet(): Promise<void> {
		if (loading || loadingMore || document.hidden) return;
		const mine = req;
		try {
			const res = await api.get('/events', { query: { ...queryOf(filters, Date.now()), limit: SIZE } as never });
			if (mine !== req || loading) return;
			rows = mergeFresh(res.items, rows);
			if (rows.length === res.items.length) next = res.next ?? null;
		} catch {
			// a missed refresh is not worth a message
		}
	}

	async function loadMore(): Promise<void> {
		if (!next || loadingMore || loading) return;
		const mine = req;
		loadingMore = true;
		try {
			const res = await api.get('/events', { query: { ...queryOf(filters, Date.now()), limit: SIZE, cursor: next } as never });
			if (mine !== req) return;
			const seen = new Set(rows.map((r) => r.id));
			rows = [...rows, ...res.items.filter((r) => !seen.has(r.id))];
			next = res.next ?? null;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loadingMore = false;
		}
	}

	$effect(() => {
		void filterKey;
		untrack(() => void load());
	});

	// `?e=<id>` opens an event that is not in the list (a bell notification links here)
	$effect(() => {
		const id = selectedId;
		if (!id) return;
		untrack(() => {
			if (rows.some((r) => r.id === id) || extra?.id === id) return;
			void api
				.get('/events/{id}', { params: { id } })
				.then((e) => {
					if (selectedId === id) extra = e;
				})
				.catch(() => {
					if (selectedId === id) error = 'That event no longer exists.';
				});
		});
	});

	onMount(() => {
		void api
			.get('/events/catalog')
			.then((c) => (catalog = c))
			.catch(() => undefined);
		const tick = setInterval(() => void refreshQuiet(), REFRESH_MS);
		return () => {
			clearInterval(tick);
			clearTimeout(timer);
		};
	});

	const connectionName = (id: string): string => catalog.connections.find((c) => c.id === id)?.label ?? id;
	const chips = $derived(
		[
			filters.source && { key: 'source', label: filters.source === 'channel' ? 'Chat events' : 'App events' },
			filters.types.length > 0 && { key: 'types', label: filters.types.length <= 2 ? filters.types.map((t) => typeLabel(catalog.types, t)).join(', ') : `${filters.types.length} event types` },
			filters.connectionId && { key: 'connectionId', label: `Connection: ${connectionName(filters.connectionId)}` },
			filters.chat && { key: 'chat', label: `Chat: ${filters.chat}` },
			filters.actor && { key: 'actor', label: `Person: ${filters.actor}` }
		].filter((c): c is { key: 'source' | 'types' | 'connectionId' | 'chat' | 'actor'; label: string } => !!c)
	);
	function removeChip(key: 'source' | 'types' | 'connectionId' | 'chat' | 'actor'): void {
		if (key === 'chat') chatInput = '';
		if (key === 'actor') actorInput = '';
		setFilter({ [key]: key === 'types' ? [] : '' } as Partial<EventFilters>);
	}
	const description = $derived(loading && rows.length === 0 ? 'What happens in your chats and in the app.' : `${rows.length}${next ? '+' : ''} event${rows.length === 1 ? '' : 's'}${filtering ? ' match the filters' : ''}. Updates every few seconds.`);
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title="Events" {description}>
		{#snippet actions()}
			<Popover.Root bind:open={filterOpen}>
				<Popover.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="outline" size="sm" aria-label="Filters">
							<FunnelIcon /><span class="hidden sm:inline">Filters</span>
							{#if nFilters > 0}<Badge shape="number" variant="brand" class="h-4 min-w-4 px-1 text-[10px]">{nFilters}</Badge>{/if}
						</Button>
					{/snippet}
				</Popover.Trigger>
				<Popover.Content elevation="floating" align="end" class="flex max-h-[80vh] w-[min(92vw,24rem)] flex-col gap-3 overflow-y-auto p-3">
					<label class="flex flex-col gap-1 text-xs text-muted-foreground">Source
						<NativeSelect value={filters.source} onchange={(e: Event) => setFilter({ source: (e.currentTarget as HTMLSelectElement).value as EventFilters['source'] })} size="sm" class="w-full text-foreground">
							<NativeSelectOption value="">Chats and the app</NativeSelectOption>
							<NativeSelectOption value="channel">Chat events</NativeSelectOption>
							<NativeSelectOption value="app">App events</NativeSelectOption>
						</NativeSelect>
					</label>
					<label class="flex flex-col gap-1 text-xs text-muted-foreground">Connection
						<NativeSelect value={filters.connectionId} onchange={(e: Event) => setFilter({ connectionId: (e.currentTarget as HTMLSelectElement).value })} size="sm" class="w-full text-foreground">
							<NativeSelectOption value="">All connections</NativeSelectOption>
							{#each catalog.connections as c (c.id)}<NativeSelectOption value={c.id}>{c.label}</NativeSelectOption>{/each}
						</NativeSelect>
					</label>
					<label class="flex flex-col gap-1 text-xs text-muted-foreground">Chat
						<Input value={chatInput} oninput={(e: Event) => setText('chat', (e.currentTarget as HTMLInputElement).value)} placeholder="Part of the chat name" class="h-8 text-[13px] text-foreground" />
					</label>
					<label class="flex flex-col gap-1 text-xs text-muted-foreground">Person
						<Input value={actorInput} oninput={(e: Event) => setText('actor', (e.currentTarget as HTMLInputElement).value)} placeholder="Name, @username or id" class="h-8 text-[13px] text-foreground" />
					</label>
					<div class="flex flex-col gap-1 text-xs text-muted-foreground">
						<span>Event types{filters.types.length > 0 ? ` (${filters.types.length})` : ''}</span>
						<div class="max-h-64 overflow-y-auto rounded-md border border-border p-1.5 text-foreground">
							<EventTypePicker types={catalog.types} selected={filters.types} id="filter-type" onchange={(v) => setFilter({ types: v })} />
						</div>
					</div>
					<Button variant="ghost" size="sm" disabled={!filtering} onclick={clearFilters}>Clear filters</Button>
				</Popover.Content>
			</Popover.Root>
			<Button variant="outline" size="icon-sm" aria-label="Refresh" title="Refresh" disabled={loading} onclick={() => void load()}>
				{#if loading}<Spinner class="size-4" />{:else}<ArrowClockwiseIcon class="size-4" />{/if}
			</Button>
			<Button size="sm" variant="outline" href="/triggers" aria-label="Triggers"><BellRingingIcon class="size-4" /><span class="hidden sm:inline">Triggers</span></Button>
		{/snippet}
	</PageHeader>

	<div class="relative min-h-0 flex-1 overflow-y-auto">
		<div class="flex flex-col gap-3 p-3 md:p-4">
			<div class="flex flex-wrap items-center gap-2">
				<FilterChips label="Time range" options={RANGES.filter((r) => r.id !== 'custom').map((r) => ({ value: r.id, label: r.label }))} value={filters.range === 'custom' ? '' : filters.range} onChange={(v) => setFilter({ range: v as EventFilters['range'], from: '', to: '' })} />
				<span class="flex items-center gap-1.5 text-xs text-muted-foreground">
					<Input type="date" value={filters.from} aria-label="From date" class="h-7 w-36 text-xs" onchange={(e: Event) => setFilter({ range: 'custom', from: (e.currentTarget as HTMLInputElement).value })} />
					to
					<Input type="date" value={filters.to} aria-label="To date" class="h-7 w-36 text-xs" onchange={(e: Event) => setFilter({ range: 'custom', to: (e.currentTarget as HTMLInputElement).value })} />
				</span>
			</div>
			{#if chips.length > 0}
				<div class="flex flex-wrap items-center gap-2">
					{#each chips as c (c.key)}
						<Badge variant="secondary" class="gap-1 pr-1">
							<span class="max-w-56 truncate">{c.label}</span>
							<button type="button" class="rounded-sm p-0.5 hover:bg-accent" aria-label="Remove filter {c.label}" onclick={() => removeChip(c.key)}><XIcon class="size-3" /></button>
						</Badge>
					{/each}
					<Button variant="ghost" size="sm" class="h-6 text-xs" onclick={clearFilters}>Clear filters</Button>
				</div>
			{/if}

			{#if error && rows.length === 0}
				<Empty.Root class="border">
					<Empty.Header>
						<Empty.Media variant="icon"><WarningCircleIcon /></Empty.Media>
						<Empty.Title>Could not load the events</Empty.Title>
						<Empty.Description>{error}</Empty.Description>
					</Empty.Header>
					<Empty.Content><Button size="sm" variant="outline" onclick={() => void load()}>Try again</Button></Empty.Content>
				</Empty.Root>
			{:else if loading && rows.length === 0}
				<div class="flex flex-col gap-2" data-testid="events-loading">{#each [0, 1, 2, 3, 4, 5] as n (n)}<Skeleton class="h-10 w-full" />{/each}</div>
			{:else if rows.length === 0}
				<Empty.Root class="border" data-testid="events-empty">
					<Empty.Header>
						<Empty.Media variant="icon">{#if filtering}<MagnifyingGlassIcon />{:else}<LightningIcon />{/if}</Empty.Media>
						<Empty.Title>{filtering ? 'No matching events' : 'No events yet'}</Empty.Title>
						<Empty.Description>
							{filtering ? 'Nothing in this time range matches the filters.' : 'Messages, reactions and member changes from your chats, and alarms, tasks and programs from the app, appear here as they happen.'}
						</Empty.Description>
					</Empty.Header>
					{#if filtering}<Empty.Content><Button size="sm" variant="outline" onclick={clearFilters}>Clear filters</Button></Empty.Content>{/if}
				</Empty.Root>
			{:else}
				<Surface class="overflow-hidden {loading ? 'opacity-60' : ''}">
					<Table.Root class="min-w-[1100px]" data-testid="events-table">
						<Table.Header>
							<Table.Row class="hover:bg-transparent">
								<Table.Head>Time</Table.Head>
								<Table.Head>Source</Table.Head>
								<Table.Head>Type</Table.Head>
								<Table.Head>Chat</Table.Head>
								<Table.Head>Actor</Table.Head>
								<Table.Head>Summary</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each rows as r (r.id)}
								<Table.Row
									role="button"
									tabindex={0}
									aria-label="Open {typeLabel(catalog.types, r.type)} {eventTime(r.at)}"
									data-state={r.id === selectedId ? 'selected' : undefined}
									class="cursor-pointer outline-none focus-visible:bg-accent"
									onclick={() => select(r.id)}
									onkeydown={(e: KeyboardEvent) => {
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault();
											select(r.id);
										}
									}}
								>
									<Table.Cell class="font-mono text-xs whitespace-nowrap text-muted-foreground">{eventTime(r.at)}</Table.Cell>
									<Table.Cell class="text-xs whitespace-nowrap">{sourceText(r)}</Table.Cell>
									<Table.Cell class="whitespace-nowrap" title={r.type}>
										{typeLabel(catalog.types, r.type)}
										{#if r.agentCaused}<Badge variant="warning" class="ml-1" title="The agent itself caused this event">agent</Badge>{/if}
									</Table.Cell>
									<Table.Cell class="max-w-48 truncate text-xs" title={chatText(r)}>{chatText(r) || '—'}</Table.Cell>
									<Table.Cell class="text-xs whitespace-nowrap">
										{#if r.actor}
											{actorName(r) || '—'}{#if actorHandle(r)}<span class="text-muted-foreground"> {actorHandle(r)}</span>{/if}
											{#if actorRole(r)}<Badge variant="outline" class="ml-1">{actorRole(r)}</Badge>{/if}
										{:else}—{/if}
									</Table.Cell>
									<Table.Cell class="max-w-96 truncate text-xs" title={r.summary}>{r.summary}</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</Surface>
				<div class="flex min-h-10 items-center justify-center">
					{#if next}
						<Button variant="ghost" size="sm" class="text-muted-foreground" disabled={loadingMore} onclick={() => void loadMore()}>
							{#if loadingMore}<Spinner />{/if}Load more
						</Button>
					{:else}
						<span class="text-xs text-muted-foreground">End of the events</span>
					{/if}
				</div>
				{#if error}<p class="text-center text-xs text-destructive-text" role="alert">{error}</p>{/if}
			{/if}
		</div>
	</div>
</div>

<EventDetailSheet
	event={selected}
	types={catalog.types}
	onPrev={selectedIndex > 0 ? () => select(rows[selectedIndex - 1]?.id ?? selectedId) : undefined}
	onNext={selectedIndex >= 0 && selectedIndex < rows.length - 1 ? () => select(rows[selectedIndex + 1]?.id ?? selectedId) : undefined}
	onClose={() => select(null)}
/>
