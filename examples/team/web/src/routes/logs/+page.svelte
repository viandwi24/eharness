<script lang="ts">
	import Surface from '#lib/components/app/Surface.svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount, untrack } from 'svelte';
	import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwise';
	import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUp';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDown';
	import FunnelIcon from 'phosphor-svelte/lib/Funnel';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import PulseIcon from 'phosphor-svelte/lib/Pulse';
	import WarningCircleIcon from 'phosphor-svelte/lib/WarningCircle';
	import XIcon from 'phosphor-svelte/lib/X';
	import { api } from '#lib/api/index.js';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import LogDetailSheet from '#lib/components/logs/LogDetailSheet.svelte';
	import LogHistogram from '#lib/components/logs/LogHistogram.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { formatTokens } from '#lib/context.js';
	import { createLogsCore, emptyLogsState } from '#lib/logs/core.js';
	import {
		KINDS,
		RANGES,
		STATUSES,
		type LogFilters,
		activeFilterCount,
		filtersFromParams,
		formatDateTime,
		formatDuration,
		formatSpeed,
		kindLabel,
		paramsFromFilters,
		statusVariant,
		tokensPerSecond
	} from '#lib/logs/logs.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';
	import { readPref, writePref } from '#lib/stores/prefs.js';
	import { formatUsd, timeAgo } from '#lib/time.js';

	const CHART_KEY = 'team.logs.chart';

	const logs = $state(emptyLogsState());
	const core = createLogsCore(api, logs);

	const filters = $derived(filtersFromParams(page.url.searchParams));
	const filterKey = $derived(paramsFromFilters(filters).toString());
	const selectedId = $derived(page.url.searchParams.get('id'));
	const nFilters = $derived(activeFilterCount(filters));
	const stats = $derived(logs.stats);

	let chartOpen = $state(true);
	let now = $state(Date.now());
	let scroller = $state<HTMLDivElement | null>(null);
	let sentinel = $state<HTMLDivElement | null>(null);
	let filterOpen = $state(false);
	let search = $state(page.url.searchParams.get('q') ?? '');
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	const agentName = (id: string | null): string => (id ? (agentsStore.find(id)?.name ?? id.slice(0, 8)) : '—');

	// --- URL is the single source of truth of filters and of the open call -------------------------
	function go(next: LogFilters, id: string | null = selectedId, replace = true): void {
		const qs = paramsFromFilters(next, id).toString();
		void goto(qs ? `?${qs}` : page.url.pathname, { replace, reset: false });
	}
	const setFilter = (patch: Partial<LogFilters>): void => go({ ...filters, ...patch });
	function clearFilters(): void {
		search = '';
		go({ ...filters, agentId: '', sessionId: '', kind: '', status: '', model: '', q: '' });
	}
	function onSearch(value: string): void {
		search = value;
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => setFilter({ q: value.trim() }), 300);
	}
	const open = (id: string): void => go(filters, id, false);
	const navigate = (id: string): void => go(filters, id, true);
	const close = (): void => go(filters, null, true);

	$effect(() => {
		void filterKey;
		untrack(() => void core.load(filters));
	});
	$effect(() => {
		const id = selectedId;
		untrack(() => (id ? void core.openDetail(id) : core.closeDetail()));
	});

	// --- infinite scroll ----------------------------------------------------------------------------
	$effect(() => {
		void logs.items.length;
		void logs.nextCursor;
		if (!sentinel || !scroller || !logs.nextCursor) return;
		const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void core.loadMore(), { root: scroller, rootMargin: '240px' });
		io.observe(sentinel);
		return () => io.disconnect();
	});

	const atTop = (): boolean => (scroller?.scrollTop ?? 0) < 40;
	function showNew(): void {
		scroller?.scrollTo({ top: 0 });
		void core.showNew();
	}
	function toggleChart(): void {
		chartOpen = !chartOpen;
		writePref(CHART_KEY, chartOpen ? '1' : '0');
	}

	onMount(() => {
		if (readPref(CHART_KEY) === '0') chartOpen = false;
		void agentsStore.load();
		const tick = setInterval(() => (now = Date.now()), 30_000);
		const off = live.onModelCallEvent((e) => core.onEvent(e, atTop()));
		return () => {
			clearInterval(tick);
			clearTimeout(searchTimer);
			off();
		};
	});

	const rel = (ms: number): string => {
		const t = timeAgo(ms, now);
		return t === 'now' ? 'just now' : /^\d+[mhd]$/.test(t) ? `${t} ago` : t;
	};
	const description = $derived(
		stats
			? `${stats.totals.count.toLocaleString()} call${stats.totals.count === 1 ? '' : 's'} · ${formatTokens(stats.totals.inputTokens + stats.totals.outputTokens)} tokens · ${formatUsd(stats.totals.costUsd)}${stats.totals.errors ? ` · ${stats.totals.errors} error${stats.totals.errors === 1 ? '' : 's'}` : ''}`
			: 'Every model call your agents make, with tokens and cost.'
	);
	const chips = $derived(
		[
			filters.agentId && { key: 'agentId', label: `Agent: ${agentName(filters.agentId)}` },
			filters.sessionId && { key: 'sessionId', label: `Session: ${filters.sessionId.length > 22 ? `${filters.sessionId.slice(0, 22)}…` : filters.sessionId}` },
			filters.kind && { key: 'kind', label: `Kind: ${kindLabel(filters.kind)}` },
			filters.status && { key: 'status', label: `Status: ${filters.status}` },
			filters.model && { key: 'model', label: `Model: ${filters.model}` }
		].filter((c): c is { key: keyof LogFilters; label: string } => !!c)
	);
	const modelChoices = $derived([...new Set([...(stats?.models ?? []), ...(filters.model ? [filters.model] : [])])]);
	const filtering = $derived(nFilters > 0 || !!filters.q);
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title="Logs" {description}>
		{#snippet actions()}
			<NativeSelect value={filters.range} onchange={(e: Event) => setFilter({ range: (e.currentTarget as HTMLSelectElement).value as LogFilters['range'] })} size="sm" aria-label="Time range" class="min-w-0">
				{#each RANGES as r (r.id)}<NativeSelectOption value={r.id}>{r.label}</NativeSelectOption>{/each}
			</NativeSelect>
			<Popover.Root bind:open={filterOpen}>
				<Popover.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="outline" size="sm" aria-label="Filters">
							<FunnelIcon /><span class="hidden sm:inline">Filters</span>
							{#if nFilters > 0}<Badge shape="number" variant="brand" class="h-4 min-w-4 px-1 text-[10px]">{nFilters}</Badge>{/if}
						</Button>
					{/snippet}
				</Popover.Trigger>
				<Popover.Content elevation="floating" align="end" class="flex w-[min(92vw,20rem)] flex-col gap-3 p-3">
					<label class="flex flex-col gap-1 text-xs text-muted-foreground">Agent
						<NativeSelect value={filters.agentId} onchange={(e: Event) => setFilter({ agentId: (e.currentTarget as HTMLSelectElement).value })} size="sm" class="w-full text-foreground">
							<NativeSelectOption value="">All agents</NativeSelectOption>
							{#each agentsStore.state.agents as a (a.id)}<NativeSelectOption value={a.id}>{a.name}</NativeSelectOption>{/each}
						</NativeSelect>
					</label>
					<label class="flex flex-col gap-1 text-xs text-muted-foreground">Kind
						<NativeSelect value={filters.kind} onchange={(e: Event) => setFilter({ kind: (e.currentTarget as HTMLSelectElement).value })} size="sm" class="w-full text-foreground">
							<NativeSelectOption value="">All kinds</NativeSelectOption>
							{#each KINDS as k (k.id)}<NativeSelectOption value={k.id}>{k.label}</NativeSelectOption>{/each}
						</NativeSelect>
					</label>
					<label class="flex flex-col gap-1 text-xs text-muted-foreground">Status
						<NativeSelect value={filters.status} onchange={(e: Event) => setFilter({ status: (e.currentTarget as HTMLSelectElement).value })} size="sm" class="w-full text-foreground">
							<NativeSelectOption value="">Any status</NativeSelectOption>
							{#each STATUSES as s (s)}<NativeSelectOption value={s} class="capitalize">{s}</NativeSelectOption>{/each}
						</NativeSelect>
					</label>
					<label class="flex flex-col gap-1 text-xs text-muted-foreground">Model
						<NativeSelect value={filters.model} onchange={(e: Event) => setFilter({ model: (e.currentTarget as HTMLSelectElement).value })} size="sm" class="w-full text-foreground">
							<NativeSelectOption value="">All models</NativeSelectOption>
							{#each modelChoices as m (m)}<NativeSelectOption value={m}>{m}</NativeSelectOption>{/each}
						</NativeSelect>
					</label>
					<Button variant="ghost" size="sm" disabled={!filtering} onclick={clearFilters}>Clear filters</Button>
				</Popover.Content>
			</Popover.Root>
			<Button variant="outline" size="icon-sm" aria-label="Refresh" title="Refresh" disabled={logs.loading} onclick={() => void core.load(filters)}>
				{#if logs.loading}<Spinner class="size-4" />{:else}<ArrowClockwiseIcon class="size-4" />{/if}
			</Button>
		{/snippet}
	</PageHeader>

	<!-- Full width on purpose: the call table has many columns. Same padding as PageBody size="full"; it keeps its own scroller for the "new calls" banner. -->
	<div bind:this={scroller} class="relative min-h-0 flex-1 overflow-y-auto">
		{#if logs.newCount > 0}
			<div class="pointer-events-none sticky top-2 z-10 flex justify-center">
				<Button size="sm" class="pointer-events-auto shadow-md" onclick={showNew}>
					<ArrowUpIcon />{logs.newCount} new call{logs.newCount === 1 ? '' : 's'}
				</Button>
			</div>
		{/if}
		<div class="flex flex-col gap-3 p-3 md:p-4 {logs.newCount > 0 ? '-mt-8' : ''}">
			<div class="flex flex-wrap items-center gap-2">
				<InputGroup.Root class="h-8 min-w-0 flex-1 md:max-w-64 md:flex-none">
					<InputGroup.Addon><MagnifyingGlassIcon /></InputGroup.Addon>
					<InputGroup.Input value={search} oninput={(e: Event) => onSearch((e.currentTarget as HTMLInputElement).value)} placeholder="Search model or agent" aria-label="Search model or agent" class="text-[13px]" />
					{#if search}
						<InputGroup.Addon align="inline-end">
							<InputGroup.Button size="icon-xs" aria-label="Clear search" onclick={() => (onSearch(''), setFilter({ q: '' }))}><XIcon /></InputGroup.Button>
						</InputGroup.Addon>
					{/if}
				</InputGroup.Root>
				{#each chips as c (c.key)}
					<Badge variant="secondary" class="gap-1 pr-1">
						<span class="max-w-48 truncate">{c.label}</span>
						<button type="button" class="rounded-sm p-0.5 hover:bg-accent" aria-label="Remove filter {c.label}" onclick={() => setFilter({ [c.key]: '' })}><XIcon class="size-3" /></button>
					</Badge>
				{/each}
				<Button variant="ghost" size="sm" class="ml-auto text-muted-foreground" aria-expanded={chartOpen} onclick={toggleChart}>
					Chart <CaretDownIcon class="transition-transform {chartOpen ? '' : '-rotate-90'}" />
				</Button>
			</div>

			{#if chartOpen}<LogHistogram {stats} loading={logs.loading} error={logs.statsError} />{/if}

			{#if logs.error && logs.items.length === 0}
				<Empty.Root class="border">
					<Empty.Header>
						<Empty.Media variant="icon"><WarningCircleIcon /></Empty.Media>
						<Empty.Title>Could not load the logs</Empty.Title>
						<Empty.Description>{logs.error}</Empty.Description>
					</Empty.Header>
					<Empty.Content><Button size="sm" variant="outline" onclick={() => void core.load(filters)}>Try again</Button></Empty.Content>
				</Empty.Root>
			{:else if logs.loading && logs.items.length === 0}
				<div class="flex flex-col gap-2">{#each [0, 1, 2, 3, 4, 5] as n (n)}<Skeleton class="h-10 w-full" />{/each}</div>
			{:else if logs.items.length === 0}
				<Empty.Root class="border">
					<Empty.Header>
						<Empty.Media variant="icon">{#if filtering}<MagnifyingGlassIcon />{:else}<PulseIcon />{/if}</Empty.Media>
						<Empty.Title>{filtering ? 'No matching calls' : 'No model calls yet'}</Empty.Title>
						<Empty.Description>
							{filtering ? 'Nothing in this time range matches the filters.' : 'Every call to a model shows up here with its timing, tokens and cost, as soon as an agent runs.'}
						</Empty.Description>
					</Empty.Header>
					{#if filtering}<Empty.Content><Button size="sm" variant="outline" onclick={clearFilters}>Clear filters</Button></Empty.Content>{/if}
				</Empty.Root>
			{:else}
				<Surface class="overflow-hidden {logs.loading ? 'opacity-60' : ''}">
					<Table.Root class="min-w-[980px]">
						<Table.Header>
							<Table.Row class="hover:bg-transparent">
								<Table.Head>Date</Table.Head>
								<Table.Head>Agent</Table.Head>
								<Table.Head>Model</Table.Head>
								<Table.Head>Provider</Table.Head>
								<Table.Head>Kind</Table.Head>
								<Table.Head class="text-right">Input</Table.Head>
								<Table.Head class="text-right">Output</Table.Head>
								<Table.Head class="text-right">Cost</Table.Head>
								<Table.Head class="text-right">Speed</Table.Head>
								<Table.Head class="text-right">Latency</Table.Head>
								<Table.Head>Status</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each logs.items as c (c.id)}
								<Table.Row
									role="button"
									tabindex={0}
									aria-label="Open call {c.modelId} {rel(c.startedAt)}"
									data-state={c.id === selectedId ? 'selected' : undefined}
									class="cursor-pointer outline-none focus-visible:bg-accent"
									onclick={() => open(c.id)}
									onkeydown={(e: KeyboardEvent) => {
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault();
											open(c.id);
										}
									}}
								>
									<Table.Cell class="text-xs whitespace-nowrap text-muted-foreground" title={formatDateTime(c.startedAt)}>{rel(c.startedAt)}</Table.Cell>
									<Table.Cell>
										<span class="flex items-center gap-2 whitespace-nowrap">
											{#if c.agentId}<AgentAvatar seed={c.agentId} color={agentsStore.find(c.agentId)?.color} size={18} />{/if}{agentName(c.agentId)}
										</span>
									</Table.Cell>
									<Table.Cell class="max-w-56 truncate font-mono text-xs" title={c.modelId}>{c.modelId}</Table.Cell>
									<Table.Cell class="text-xs whitespace-nowrap text-muted-foreground">{c.provider}</Table.Cell>
									<Table.Cell><Badge variant="outline">{kindLabel(c.kind)}</Badge></Table.Cell>
									<Table.Cell class="text-right font-mono text-xs tabular-nums">{c.inputTokens === null ? '—' : formatTokens(c.inputTokens)}</Table.Cell>
									<Table.Cell class="text-right font-mono text-xs tabular-nums">{c.outputTokens === null ? '—' : formatTokens(c.outputTokens)}</Table.Cell>
									<Table.Cell class="text-right font-mono text-xs tabular-nums">{c.costUsd === null ? '—' : formatUsd(c.costUsd)}</Table.Cell>
									<Table.Cell class="text-right font-mono text-xs whitespace-nowrap tabular-nums text-muted-foreground">{formatSpeed(tokensPerSecond(c))}</Table.Cell>
									<Table.Cell class="text-right font-mono text-xs whitespace-nowrap tabular-nums text-muted-foreground">
										{c.firstChunkMs === null ? '' : `${formatDuration(c.firstChunkMs)} / `}{formatDuration(c.durationMs)}
									</Table.Cell>
									<Table.Cell><Badge variant={statusVariant(c.status)} class="capitalize" title={c.errorMessage ?? undefined}>{c.status}</Badge></Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</Surface>
				<div bind:this={sentinel} class="flex min-h-10 items-center justify-center">
					{#if logs.nextCursor}
						<Button variant="ghost" size="sm" class="text-muted-foreground" disabled={logs.loadingMore} onclick={() => void core.loadMore()}>
							{#if logs.loadingMore}<Spinner />{/if}Load more
						</Button>
					{:else}
						<span class="text-xs text-muted-foreground">End of the log</span>
					{/if}
				</div>
				{#if logs.error}<p class="text-center text-xs text-destructive-text" role="alert">{logs.error}</p>{/if}
			{/if}
		</div>
	</div>
</div>

<LogDetailSheet id={selectedId} detail={logs.detail} loading={logs.detailLoading} error={logs.detailError} onNavigate={navigate} onClose={close} />
