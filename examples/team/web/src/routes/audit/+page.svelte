<script lang="ts">
	import Surface from '#lib/components/app/Surface.svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount, untrack } from 'svelte';
	import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwise';
	import ClipboardTextIcon from 'phosphor-svelte/lib/ClipboardText';
	import FileCsvIcon from 'phosphor-svelte/lib/FileCsv';
	import FunnelIcon from 'phosphor-svelte/lib/Funnel';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import WarningCircleIcon from 'phosphor-svelte/lib/WarningCircle';
	import XIcon from 'phosphor-svelte/lib/X';
	import { api } from '#lib/api/index.js';
	import { AgentAvatar } from '#lib/components/ai/agent-avatar/index.js';
	import FilterChips from '#lib/components/app/FilterChips.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import AuditDetailSheet from '#lib/components/audit/AuditDetailSheet.svelte';
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
		KINDS,
		RANGES,
		RESULTS,
		type AuditFilters,
		type AuditRow,
		activeFilterCount,
		auditTime,
		connectorText,
		filtersFromParams,
		paramsFromFilters,
		queryOf,
		requesterText,
		resultLabel,
		resultVariant,
		roleText,
		rowAction,
		targetText
	} from '#lib/audit/audit.js';
	import { downloadAuditCsv } from '#lib/audit/download.js';
	import { ACTION_LABEL } from '#lib/channels/model.js';
	import { formatDuration } from '#lib/logs/logs.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';

	const SIZE = 50;
	const REFRESH_MS = 30_000;

	const filters = $derived(filtersFromParams(page.url.searchParams));
	const filterKey = $derived(paramsFromFilters(filters).toString());
	const nFilters = $derived(activeFilterCount(filters));

	let rows = $state<AuditRow[]>([]);
	let next = $state<string | null>(null);
	let loading = $state(true);
	let loadingMore = $state(false);
	let error = $state<string | null>(null);
	let exporting = $state(false);
	let exportError = $state<string | null>(null);
	let selectedId = $state<string | null>(null);
	let filterOpen = $state(false);
	let connections = $state<{ id: string; label: string }[]>([]);
	let chatText = $state(page.url.searchParams.get('chat') ?? '');
	let requesterTextInput = $state(page.url.searchParams.get('requester') ?? '');
	let timer: ReturnType<typeof setTimeout> | undefined;
	let req = 0;

	const selectedIndex = $derived(selectedId === null ? -1 : rows.findIndex((r) => r.id === selectedId));
	const selected = $derived(selectedIndex >= 0 ? (rows[selectedIndex] ?? null) : null);
	const filtering = $derived(nFilters > 0);
	const actionNames = $derived(Object.entries(ACTION_LABEL).sort((a, b) => a[1].localeCompare(b[1])));

	function go(next: AuditFilters): void {
		const qs = paramsFromFilters(next).toString();
		void goto(qs ? `?${qs}` : page.url.pathname, { replace: true, reset: false });
	}
	const setFilter = (patch: Partial<AuditFilters>): void => go({ ...filters, ...patch });
	function setText(key: 'chat' | 'requester', value: string): void {
		if (key === 'chat') chatText = value;
		else requesterTextInput = value;
		clearTimeout(timer);
		timer = setTimeout(() => setFilter({ [key]: value.trim() }), 300);
	}
	function clearFilters(): void {
		chatText = '';
		requesterTextInput = '';
		go({ ...filters, connectionId: '', transport: '', kind: 'action', action: '', chat: '', requester: '', agentId: '', result: '' });
	}

	async function load(): Promise<void> {
		const mine = ++req;
		loading = true;
		error = null;
		try {
			const res = await api.get('/audit/actions', { query: { ...queryOf(filters, Date.now()), limit: SIZE } as never });
			if (mine !== req) return;
			rows = res.items;
			next = res.next ?? null;
		} catch (e) {
			if (mine === req) error = e instanceof Error ? e.message : String(e);
		} finally {
			if (mine === req) loading = false;
		}
	}

	/** A quiet refresh: new rows on top without the skeleton (the audit has no live event of its own). */
	async function refreshQuiet(): Promise<void> {
		if (loading || loadingMore || document.hidden) return;
		const mine = req;
		try {
			const res = await api.get('/audit/actions', { query: { ...queryOf(filters, Date.now()), limit: SIZE } as never });
			if (mine !== req || loading) return;
			const seen = new Set(res.items.map((r) => r.id));
			// keep the older pages already loaded below the fresh first page
			rows = [...res.items, ...rows.filter((r) => !seen.has(r.id) && r.at < (res.items.at(-1)?.at ?? 0))];
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
			const res = await api.get('/audit/actions', { query: { ...queryOf(filters, Date.now()), limit: SIZE, cursor: next } as never });
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

	async function exportCsv(): Promise<void> {
		exporting = true;
		exportError = null;
		try {
			await downloadAuditCsv(queryOf(filters, Date.now()));
		} catch (e) {
			exportError = e instanceof Error ? e.message : String(e);
		} finally {
			exporting = false;
		}
	}

	$effect(() => {
		void filterKey;
		untrack(() => {
			selectedId = null;
			void load();
		});
	});

	onMount(() => {
		void agentsStore.load();
		void api
			.get('/channels/connections')
			.then((r) => (connections = r.items.map((c) => ({ id: c.id, label: c.label }))))
			.catch(() => undefined);
		const tick = setInterval(() => void refreshQuiet(), REFRESH_MS);
		return () => {
			clearInterval(tick);
			clearTimeout(timer);
		};
	});

	const agentLabel = (r: AuditRow): string => r.agentName ?? (r.agentId ? (agentsStore.find(r.agentId)?.name ?? r.agentId.slice(0, 8)) : '—');
	const connectionName = (id: string): string => connections.find((c) => c.id === id)?.label ?? id;
	const chips = $derived(
		[
			filters.connectionId && { key: 'connectionId', label: `Connection: ${connectionName(filters.connectionId)}` },
			filters.transport && { key: 'transport', label: filters.transport === 'user' ? 'Telegram accounts' : 'Telegram bots' },
			filters.kind !== 'action' && { key: 'kind', label: KINDS.find((k) => k.id === filters.kind)?.label ?? filters.kind },
			filters.action && { key: 'action', label: `Action: ${ACTION_LABEL[filters.action] ?? filters.action}` },
			filters.chat && { key: 'chat', label: `Chat: ${filters.chat}` },
			filters.requester && { key: 'requester', label: `Asked by: ${filters.requester}` },
			filters.agentId && { key: 'agentId', label: `Agent: ${agentsStore.find(filters.agentId)?.name ?? filters.agentId.slice(0, 8)}` },
			filters.result && { key: 'result', label: `Result: ${resultLabel(filters.result)}` }
		].filter((c): c is { key: keyof AuditFilters; label: string } => !!c)
	);
	const removeChip = (key: keyof AuditFilters): void => {
		if (key === 'chat') chatText = '';
		if (key === 'requester') requesterTextInput = '';
		setFilter({ [key]: key === 'kind' ? 'action' : '' } as Partial<AuditFilters>);
	};
	const description = $derived(
		loading && rows.length === 0 ? 'What your agents did on chat platforms.' : `${rows.length}${next ? '+' : ''} action${rows.length === 1 ? '' : 's'} on chat platforms${filtering ? ' match the filters' : ''}. Who asked, where, and how it went.`
	);
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title="Audit" {description}>
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
				<Popover.Content elevation="floating" align="end" class="flex max-h-[80vh] w-[min(92vw,22rem)] flex-col gap-3 overflow-y-auto p-3">
					<label class="flex flex-col gap-1 text-xs text-muted-foreground">Connection
						<NativeSelect value={filters.connectionId} onchange={(e: Event) => setFilter({ connectionId: (e.currentTarget as HTMLSelectElement).value })} size="sm" class="w-full text-foreground">
							<NativeSelectOption value="">All connections</NativeSelectOption>
							{#each connections as c (c.id)}<NativeSelectOption value={c.id}>{c.label}</NativeSelectOption>{/each}
						</NativeSelect>
					</label>
					<label class="flex flex-col gap-1 text-xs text-muted-foreground">Connector
						<NativeSelect value={filters.transport} onchange={(e: Event) => setFilter({ transport: (e.currentTarget as HTMLSelectElement).value as AuditFilters['transport'] })} size="sm" class="w-full text-foreground">
							<NativeSelectOption value="">Telegram bots and accounts</NativeSelectOption>
							<NativeSelectOption value="bot">Telegram bots</NativeSelectOption>
							<NativeSelectOption value="user">Telegram accounts</NativeSelectOption>
						</NativeSelect>
					</label>
					<label class="flex flex-col gap-1 text-xs text-muted-foreground">Show
						<NativeSelect value={filters.kind} onchange={(e: Event) => setFilter({ kind: (e.currentTarget as HTMLSelectElement).value as AuditFilters['kind'] })} size="sm" class="w-full text-foreground">
							{#each KINDS as k (k.id)}<NativeSelectOption value={k.id}>{k.label}</NativeSelectOption>{/each}
						</NativeSelect>
					</label>
					<label class="flex flex-col gap-1 text-xs text-muted-foreground">Action
						<NativeSelect value={filters.action} onchange={(e: Event) => setFilter({ action: (e.currentTarget as HTMLSelectElement).value })} size="sm" class="w-full text-foreground">
							<NativeSelectOption value="">Any action</NativeSelectOption>
							{#each actionNames as [name, label] (name)}<NativeSelectOption value={name}>{label}</NativeSelectOption>{/each}
						</NativeSelect>
					</label>
					<label class="flex flex-col gap-1 text-xs text-muted-foreground">Chat
						<Input value={chatText} oninput={(e: Event) => setText('chat', (e.currentTarget as HTMLInputElement).value)} placeholder="Part of the chat name" class="h-8 text-[13px] text-foreground" />
					</label>
					<label class="flex flex-col gap-1 text-xs text-muted-foreground">Asked by
						<Input value={requesterTextInput} oninput={(e: Event) => setText('requester', (e.currentTarget as HTMLInputElement).value)} placeholder="Name, or web owner" class="h-8 text-[13px] text-foreground" />
					</label>
					<label class="flex flex-col gap-1 text-xs text-muted-foreground">Agent
						<NativeSelect value={filters.agentId} onchange={(e: Event) => setFilter({ agentId: (e.currentTarget as HTMLSelectElement).value })} size="sm" class="w-full text-foreground">
							<NativeSelectOption value="">All agents</NativeSelectOption>
							{#each agentsStore.state.agents as a (a.id)}<NativeSelectOption value={a.id}>{a.name}</NativeSelectOption>{/each}
						</NativeSelect>
					</label>
					<label class="flex flex-col gap-1 text-xs text-muted-foreground">Result
						<NativeSelect value={filters.result} onchange={(e: Event) => setFilter({ result: (e.currentTarget as HTMLSelectElement).value as AuditFilters['result'] })} size="sm" class="w-full text-foreground">
							<NativeSelectOption value="">Any result</NativeSelectOption>
							{#each RESULTS as r (r.id)}<NativeSelectOption value={r.id}>{r.label}</NativeSelectOption>{/each}
						</NativeSelect>
					</label>
					<Button variant="ghost" size="sm" disabled={!filtering} onclick={clearFilters}>Clear filters</Button>
				</Popover.Content>
			</Popover.Root>
			<Button variant="outline" size="sm" aria-label="Export CSV" title="Export the rows of this view as CSV" disabled={exporting} onclick={() => void exportCsv()}>
				{#if exporting}<Spinner class="size-4" />{:else}<FileCsvIcon class="size-4" />{/if}<span class="hidden sm:inline">Export CSV</span>
			</Button>
			<Button variant="outline" size="icon-sm" aria-label="Refresh" title="Refresh" disabled={loading} onclick={() => void load()}>
				{#if loading}<Spinner class="size-4" />{:else}<ArrowClockwiseIcon class="size-4" />{/if}
			</Button>
		{/snippet}
	</PageHeader>

	<div class="relative min-h-0 flex-1 overflow-y-auto">
		<div class="flex flex-col gap-3 p-3 md:p-4">
			<div class="flex flex-wrap items-center gap-2">
				<FilterChips label="Time range" options={RANGES.filter((r) => r.id !== 'custom').map((r) => ({ value: r.id, label: r.label }))} value={filters.range === 'custom' ? '' : filters.range} onChange={(v) => setFilter({ range: v as AuditFilters['range'], from: '', to: '' })} />
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
				</div>
			{/if}
			{#if exportError}<p class="text-xs text-destructive-text" role="alert">{exportError}</p>{/if}

			{#if error && rows.length === 0}
				<Empty.Root class="border">
					<Empty.Header>
						<Empty.Media variant="icon"><WarningCircleIcon /></Empty.Media>
						<Empty.Title>Could not load the audit</Empty.Title>
						<Empty.Description>{error}</Empty.Description>
					</Empty.Header>
					<Empty.Content><Button size="sm" variant="outline" onclick={() => void load()}>Try again</Button></Empty.Content>
				</Empty.Root>
			{:else if loading && rows.length === 0}
				<div class="flex flex-col gap-2" data-testid="audit-loading">{#each [0, 1, 2, 3, 4, 5] as n (n)}<Skeleton class="h-10 w-full" />{/each}</div>
			{:else if rows.length === 0}
				<Empty.Root class="border" data-testid="audit-empty">
					<Empty.Header>
						<Empty.Media variant="icon">{#if filtering}<MagnifyingGlassIcon />{:else}<ClipboardTextIcon />{/if}</Empty.Media>
						<Empty.Title>{filtering ? 'No matching actions' : 'Nothing recorded yet'}</Empty.Title>
						<Empty.Description>
							{filtering ? 'Nothing in this time range matches the filters.' : 'When an agent bans, pins, promotes or changes something on a chat platform, it shows up here with who asked and how it went.'}
						</Empty.Description>
					</Empty.Header>
					{#if filtering}<Empty.Content><Button size="sm" variant="outline" onclick={clearFilters}>Clear filters</Button></Empty.Content>{/if}
				</Empty.Root>
			{:else}
				<Surface class="overflow-hidden {loading ? 'opacity-60' : ''}">
					<Table.Root class="min-w-[1000px]" data-testid="audit-table">
						<Table.Header>
							<Table.Row class="hover:bg-transparent">
								<Table.Head>Time</Table.Head>
								<Table.Head>Connector</Table.Head>
								<Table.Head>Action</Table.Head>
								<Table.Head>Target</Table.Head>
								<Table.Head>Requested by</Table.Head>
								<Table.Head>Agent</Table.Head>
								<Table.Head>Result</Table.Head>
								<Table.Head class="text-right">Duration</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each rows as r (r.id)}
								<Table.Row
									role="button"
									tabindex={0}
									aria-label="Open {rowAction(r)} {auditTime(r.at)}"
									data-state={r.id === selectedId ? 'selected' : undefined}
									class="cursor-pointer outline-none focus-visible:bg-accent"
									onclick={() => (selectedId = r.id)}
									onkeydown={(e: KeyboardEvent) => {
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault();
											selectedId = r.id;
										}
									}}
								>
									<Table.Cell class="font-mono text-xs whitespace-nowrap text-muted-foreground">{auditTime(r.at)}</Table.Cell>
									<Table.Cell class="text-xs whitespace-nowrap"><span class="block">{r.connectionLabel}</span><span class="block text-muted-foreground">{connectorText(r)}</span></Table.Cell>
									<Table.Cell class="whitespace-nowrap">{rowAction(r)}{#if r.kind === 'read'}<span class="ml-1 text-xs text-muted-foreground">(lookup)</span>{/if}</Table.Cell>
									<Table.Cell class="max-w-64 truncate text-xs" title={targetText(r)}>{targetText(r) || '—'}</Table.Cell>
									<Table.Cell class="text-xs whitespace-nowrap">{requesterText(r)}{#if roleText(r)}<span class="text-muted-foreground"> · {roleText(r)}</span>{/if}</Table.Cell>
									<Table.Cell>
										<span class="flex items-center gap-2 whitespace-nowrap">
											{#if r.agentId}<AgentAvatar seed={r.agentId} color={agentsStore.find(r.agentId)?.color} size={18} />{/if}{agentLabel(r)}
										</span>
									</Table.Cell>
									<Table.Cell><Badge variant={resultVariant(r.result)} title={r.note ?? undefined}>{resultLabel(r.result)}</Badge></Table.Cell>
									<Table.Cell class="text-right font-mono text-xs whitespace-nowrap tabular-nums text-muted-foreground">{formatDuration(r.durationMs)}</Table.Cell>
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
						<span class="text-xs text-muted-foreground">End of the audit</span>
					{/if}
				</div>
				{#if error}<p class="text-center text-xs text-destructive-text" role="alert">{error}</p>{/if}
			{/if}
		</div>
	</div>
</div>

<AuditDetailSheet
	row={selected}
	onPrev={selectedIndex > 0 ? () => (selectedId = rows[selectedIndex - 1]?.id ?? selectedId) : undefined}
	onNext={selectedIndex >= 0 && selectedIndex < rows.length - 1 ? () => (selectedId = rows[selectedIndex + 1]?.id ?? selectedId) : undefined}
	onClose={() => (selectedId = null)}
/>
