<script lang="ts">
	import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwise';
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRight';
	import { api } from '#lib/api/index.js';
	import Surface from '#lib/components/app/Surface.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { formatTime } from '#lib/format.js';
	import { formatDuration, outcomeTone, type ScriptRun } from '#lib/scripts/scripts.js';
	import RunTrace from './RunTrace.svelte';

	/** The run history, newest first: real runs, dry runs or both; a row opens its full trace. */
	let { script, rev = 0 }: { script: string; rev?: number } = $props();

	const SIZE = 30;
	let filter = $state<'all' | 'real' | 'dry'>('all');
	let runs = $state<ScriptRun[] | null>(null);
	let more = $state(false);
	let loading = $state(false);
	let loadingMore = $state(false);
	let error = $state('');
	let open = $state<string | null>(null);
	let seq = 0;

	const dryRun = (): 'true' | 'false' | undefined => (filter === 'dry' ? 'true' : filter === 'real' ? 'false' : undefined);

	async function load(): Promise<void> {
		const mine = ++seq;
		loading = true;
		try {
			const d = dryRun();
			const r = await api.get('/scripts/{script}/runs', { params: { script }, query: { limit: SIZE, ...(d ? { dryRun: d } : {}) } });
			if (mine !== seq) return;
			runs = r.runs;
			more = r.runs.length === SIZE;
			error = '';
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not load the runs';
		} finally {
			if (mine === seq) loading = false;
		}
	}

	async function loadMore(): Promise<void> {
		const last = runs?.at(-1);
		if (!last || loadingMore) return;
		const mine = seq;
		loadingMore = true;
		try {
			const d = dryRun();
			const r = await api.get('/scripts/{script}/runs', { params: { script }, query: { limit: SIZE, before: last.id, ...(d ? { dryRun: d } : {}) } });
			if (mine !== seq || !runs) return;
			const seen = new Set(runs.map((x) => x.id));
			runs = [...runs, ...r.runs.filter((x) => !seen.has(x.id))];
			more = r.runs.length === SIZE;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not load more runs';
		} finally {
			loadingMore = false;
		}
	}

	$effect(() => {
		void rev;
		void filter;
		void script;
		void load();
	});
</script>

<div class="flex flex-col gap-3">
	<div class="flex flex-wrap items-center gap-2">
		<NativeSelect bind:value={filter} aria-label="Which runs" class="w-40">
			<NativeSelectOption value="all">All runs</NativeSelectOption>
			<NativeSelectOption value="real">Real runs</NativeSelectOption>
			<NativeSelectOption value="dry">Dry runs</NativeSelectOption>
		</NativeSelect>
		<span class="flex-1"></span>
		<Button variant="outline" size="icon-sm" aria-label="Refresh" title="Refresh" disabled={loading} onclick={() => void load()}>
			{#if loading}<Spinner class="size-4" />{:else}<ArrowClockwiseIcon class="size-4" />{/if}
		</Button>
	</div>

	{#if error && !runs}
		<p class="text-sm text-destructive-text" role="alert">{error} <button class="underline underline-offset-4" onclick={() => void load()}>Retry</button></p>
	{:else if !runs}
		<div class="flex flex-col gap-2">{#each [0, 1, 2] as i (i)}<Skeleton class="h-10 w-full" />{/each}</div>
	{:else if !runs.length}
		<p class="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">No runs yet.</p>
	{:else}
		<Surface>
			<ul class="divide-y divide-border">
				{#each runs as r (r.id)}
					<li>
						<button type="button" class="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-sm hover:bg-accent/40" aria-expanded={open === r.id} onclick={() => (open = open === r.id ? null : r.id)}>
							<CaretRightIcon class="size-3.5 shrink-0 text-muted-foreground transition-transform {open === r.id ? 'rotate-90' : ''}" />
							<span class="w-20 shrink-0 text-xs text-muted-foreground" title={new Date(r.startedAt).toLocaleString()}>{formatTime(r.startedAt)}</span>
							<Badge variant={outcomeTone(r.outcome)}>{r.outcome}</Badge>
							{#if r.dryRun}<Badge variant="secondary">dry</Badge>{/if}
							<span class="text-xs text-muted-foreground">{r.trigger} · v{r.version} · {formatDuration(r.durationMs)}</span>
							{#if r.error || r.reason}<span class="min-w-0 flex-1 truncate text-xs {r.error ? 'text-destructive-text' : 'text-muted-foreground'}" title={r.error ?? r.reason ?? ''}>{r.error ?? r.reason}</span>{/if}
						</button>
						{#if open === r.id}
							<div class="border-t border-border bg-[color-mix(in_srgb,var(--muted)_30%,var(--card))] px-4 py-3">
								<RunTrace run={r} />
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		</Surface>
		<div class="flex justify-center">
			{#if more}
				<Button variant="ghost" size="sm" class="text-muted-foreground" disabled={loadingMore} onclick={() => void loadMore()}>{#if loadingMore}<Spinner />{/if}Load more</Button>
			{:else}
				<span class="text-xs text-muted-foreground">End of the runs</span>
			{/if}
		</div>
		{#if error}<p class="text-center text-xs text-destructive-text" role="alert">{error}</p>{/if}
	{/if}
</div>
