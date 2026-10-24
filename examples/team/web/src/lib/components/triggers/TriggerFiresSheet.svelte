<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import WarningCircleIcon from 'phosphor-svelte/lib/WarningCircle';
	import XIcon from 'phosphor-svelte/lib/X';
	import { api } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import FilterChips from '#lib/components/app/FilterChips.svelte';
	import { eventTime, mergeFresh, typeLabel, type EventTypeInfo } from '#lib/events/events.js';
	import { formatDuration } from '#lib/logs/logs.js';
	import { FIRE_RESULTS, actionKindLabel, fireDetailRows, fireLabel, fireReasonText, fireVariant, sessionRoute, type Trigger, type TriggerFire } from '#lib/triggers/triggers.js';

	/** The firing log of one trigger: every event it saw pass the filters, and what became of it. */
	let { trigger, types, onClose }: { trigger: Trigger | null; types: EventTypeInfo[]; onClose: () => void } = $props();

	const SIZE = 50;
	let result = $state('');
	let rows = $state<TriggerFire[]>([]);
	let next = $state<string | null>(null);
	let loading = $state(false);
	let loadingMore = $state(false);
	let error = $state<string | null>(null);
	let req = 0;

	const query = (extra: Record<string, string> = {}): never => ({ limit: SIZE, ...(result ? { result } : {}), ...extra }) as never;

	async function load(): Promise<void> {
		if (!trigger) return;
		const mine = ++req;
		const id = trigger.id;
		loading = true;
		error = null;
		try {
			const res = await api.get('/triggers/{id}/fires', { params: { id }, query: query() });
			if (mine !== req) return;
			rows = res.items;
			next = res.next ?? null;
		} catch (e) {
			if (mine === req) error = e instanceof Error ? e.message : String(e);
		} finally {
			if (mine === req) loading = false;
		}
	}

	async function refreshQuiet(): Promise<void> {
		if (!trigger || loading || loadingMore || document.hidden) return;
		const mine = req;
		try {
			const res = await api.get('/triggers/{id}/fires', { params: { id: trigger.id }, query: query() });
			if (mine !== req || loading) return;
			rows = mergeFresh(res.items, rows);
			if (rows.length === res.items.length) next = res.next ?? null;
		} catch {
			// a missed refresh is not worth a message
		}
	}

	async function loadMore(): Promise<void> {
		if (!trigger || !next || loadingMore || loading) return;
		const mine = req;
		loadingMore = true;
		try {
			const res = await api.get('/triggers/{id}/fires', { params: { id: trigger.id }, query: query({ cursor: next }) });
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
		void trigger?.id;
		void result;
		untrack(() => {
			rows = [];
			next = null;
			void load();
		});
	});

	// the filter starts clean for each trigger
	$effect(() => {
		void trigger?.id;
		untrack(() => (result = ''));
	});

	onMount(() => {
		const tick = setInterval(() => void refreshQuiet(), 10_000);
		return () => clearInterval(tick);
	});
</script>

<Sheet.Root open={trigger !== null} onOpenChange={(o) => !o && onClose()}>
	<Sheet.Content side="right" showCloseButton={false} class="flex flex-col gap-0 p-0" style="width: min(42rem, 100vw); max-width: none">
		<header class="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
			<Sheet.Title class="mr-auto truncate text-sm font-medium">Firing log{trigger ? `: ${trigger.name}` : ''}</Sheet.Title>
			<Button variant="ghost" size="icon-sm" aria-label="Close" onclick={onClose}><XIcon class="size-4" /></Button>
		</header>
		<div class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
			<FilterChips label="Result" options={[{ value: '', label: 'All' }, ...FIRE_RESULTS.map((r) => ({ value: r.id, label: r.label }))]} value={result} onChange={(v) => (result = v)} />
		</div>

		<div class="min-h-0 flex-1 overflow-y-auto p-3">
			{#if error && rows.length === 0}
				<Empty.Root class="border">
					<Empty.Header>
						<Empty.Media variant="icon"><WarningCircleIcon /></Empty.Media>
						<Empty.Title>Could not load the log</Empty.Title>
						<Empty.Description>{error}</Empty.Description>
					</Empty.Header>
					<Empty.Content><Button size="sm" variant="outline" onclick={() => void load()}>Try again</Button></Empty.Content>
				</Empty.Root>
			{:else if loading && rows.length === 0}
				<div class="flex flex-col gap-2">{#each [0, 1, 2, 3] as n (n)}<Skeleton class="h-14 w-full" />{/each}</div>
			{:else if rows.length === 0}
				<Empty.Root class="border">
					<Empty.Header>
						<Empty.Title>{result ? 'No firings with this result' : 'Nothing fired yet'}</Empty.Title>
						<Empty.Description>{result ? 'Try another result.' : 'When an event passes the filters, what the trigger did is listed here. Events that do not match are not logged.'}</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{:else}
				<ul class="flex flex-col gap-2" data-testid="fires">
					{#each rows as f (f.id)}
						{@const reason = fireReasonText(f)}
						{@const details = fireDetailRows(f.detail)}
						<li class="rounded-lg border border-border p-3 text-[13px]">
							<div class="flex flex-wrap items-center gap-2">
								<Badge variant={fireVariant(f.result)}>{fireLabel(f.result)}</Badge>
								<span class="font-mono text-xs text-muted-foreground">{eventTime(f.at)}</span>
								<span class="text-xs text-muted-foreground">{actionKindLabel(f.actionKind)}</span>
								<span class="ml-auto font-mono text-xs text-muted-foreground tabular-nums">{formatDuration(f.durationMs)}</span>
							</div>
							<div class="mt-1.5 flex flex-wrap items-center gap-x-2">
								<span>{typeLabel(types, f.eventType)}</span>
								<a href="/events?e={encodeURIComponent(f.eventId)}" class="text-xs underline underline-offset-2 hover:text-foreground">Open the event</a>
							</div>
							{#if reason}<p class="mt-1 text-xs {f.result === 'error' ? 'text-destructive-text' : 'text-muted-foreground'}">{reason}</p>{/if}
							{#if details.length > 0}
								<dl class="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
									{#each details as d (d.key)}
										<div class="flex min-w-0 gap-1">
											<dt class="text-muted-foreground">{d.label}</dt>
											<dd class="min-w-0 font-mono break-all">
												{#if d.key === 'sessionId' && sessionRoute(d.value)}<a href={sessionRoute(d.value)} class="underline underline-offset-2">{d.value}</a>{:else}{d.value}{/if}
											</dd>
										</div>
									{/each}
								</dl>
							{/if}
						</li>
					{/each}
				</ul>
				<div class="flex min-h-10 items-center justify-center">
					{#if next}
						<Button variant="ghost" size="sm" class="text-muted-foreground" disabled={loadingMore} onclick={() => void loadMore()}>{#if loadingMore}<Spinner />{/if}Load more</Button>
					{:else}
						<span class="text-xs text-muted-foreground">End of the log</span>
					{/if}
				</div>
				{#if error}<p class="text-center text-xs text-destructive-text" role="alert">{error}</p>{/if}
			{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>
