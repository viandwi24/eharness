<script lang="ts">
	import ArrowDownIcon from 'phosphor-svelte/lib/ArrowDown';
	import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUp';
	import type { ModelCallStats } from '#lib/api/client.js';
	import Surface from '#lib/components/app/Surface.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { formatTokens } from '#lib/context.js';
	import { axisUsd, cacheHitRate, costByAgentSeries, costBySourceSeries, deltaOf, errorRate, formatPercent, statusSeries, tokenSeries, type Delta } from '#lib/logs/charts.js';
	import { formatDuration } from '#lib/logs/logs.js';
	import { readPref, writePref } from '#lib/stores/prefs.js';
	import { formatUsd } from '#lib/time.js';
	import { onMount } from 'svelte';
	import BarChart from './BarChart.svelte';

	/** Stat tiles with the change against the previous equal range, three charts and a by-model / by-agent table. */
	let {
		stats,
		loading = false,
		error = null,
		agentIds,
		agentName
	}: {
		stats: ModelCallStats | null;
		loading?: boolean;
		error?: string | null;
		/** Stable agent order: decides each agent's color. */
		agentIds: string[];
		agentName: (id: string) => string;
	} = $props();

	const COST_KEY = 'team.logs.costBy';
	const TABLE_KEY = 'team.logs.tableBy';
	let costBy = $state<'source' | 'agent'>('source');
	let tableBy = $state<'model' | 'agent'>('model');
	onMount(() => {
		if (readPref(COST_KEY) === 'agent') costBy = 'agent';
		if (readPref(TABLE_KEY) === 'agent') tableBy = 'agent';
	});
	const pickCost = (v: 'source' | 'agent'): void => ((costBy = v), writePref(COST_KEY, v));
	const pickTable = (v: 'model' | 'agent'): void => ((tableBy = v), writePref(TABLE_KEY, v));

	type Tile = { label: string; value: string; sub?: string; delta: Delta | null; worseWhen?: 'up' };
	const tiles = $derived.by((): Tile[] => {
		if (!stats) return [];
		const t = stats.totals;
		const p = stats.previous;
		const dur = (ms: number | null): string => (ms === null ? '—' : formatDuration(ms));
		const hit = cacheHitRate(t);
		return [
			{ label: 'Cost', value: formatUsd(t.costUsd), delta: deltaOf(t.costUsd, p.costUsd) },
			{ label: 'Calls', value: t.count.toLocaleString(), delta: deltaOf(t.count, p.count) },
			{ label: 'Input tokens', value: formatTokens(t.inputTokens), delta: deltaOf(t.inputTokens, p.inputTokens) },
			{ label: 'Output tokens', value: formatTokens(t.outputTokens), delta: deltaOf(t.outputTokens, p.outputTokens) },
			{ label: 'Cached input', value: formatTokens(t.cachedTokens), sub: hit === null ? undefined : `${formatPercent(hit)} cache hit`, delta: deltaOf(t.cachedTokens, p.cachedTokens) },
			{ label: 'Reasoning tokens', value: formatTokens(t.reasoningTokens), delta: deltaOf(t.reasoningTokens, p.reasoningTokens) },
			{ label: 'Error rate', value: formatPercent(errorRate(t)), sub: `${t.errors.toLocaleString()} error${t.errors === 1 ? '' : 's'}${t.aborted ? ` · ${t.aborted} aborted` : ''}`, delta: deltaOf(errorRate(t) ?? 0, p.count > 0 ? (errorRate(p) ?? 0) : null), worseWhen: 'up' },
			{ label: 'Latency (median)', value: dur(t.p50Ms), delta: t.p50Ms !== null && p.p50Ms !== null ? deltaOf(t.p50Ms, p.p50Ms) : null, worseWhen: 'up' },
			{ label: 'Latency (p95)', value: dur(t.p95Ms), delta: t.p95Ms !== null && p.p95Ms !== null ? deltaOf(t.p95Ms, p.p95Ms) : null, worseWhen: 'up' }
		];
	});

	const starts = $derived(stats?.buckets.map((b) => b.start) ?? []);
	const costSeries = $derived(stats ? (costBy === 'source' ? costBySourceSeries(stats.buckets) : costByAgentSeries(stats.buckets, agentIds, agentName)) : []);
	const tokens = $derived(stats ? tokenSeries(stats.buckets) : []);
	const statuses = $derived(stats ? statusSeries(stats.buckets) : []);
	const rows = $derived(stats ? (tableBy === 'model' ? stats.byModel : stats.byAgent) : []);
	const maxCost = $derived(Math.max(0, ...rows.map((r) => r.costUsd)));
	const rowName = (key: string | null): string => (tableBy === 'model' ? (key ?? '—') : key === null ? 'No agent' : agentName(key));
	const tone = (t: Tile): string => {
		if (!t.delta || !t.worseWhen) return 'text-muted-foreground';
		return t.delta.dir === t.worseWhen ? 'text-destructive-text' : t.delta.dir === 'flat' || t.delta.dir === 'new' ? 'text-muted-foreground' : 'text-success-text';
	};
	const count = (n: number): string => n.toLocaleString();
	const toggle = 'h-7 px-2.5 text-xs';
</script>

<!-- The chart palette: the validated categorical order (blue, orange, aqua, yellow, magenta, green, violet), a neutral for "other", and the reserved status colors. -->
<div class="viz-root flex min-w-0 flex-col gap-3">
	{#if error && !stats}
		<p class="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">Could not load the charts: {error}</p>
	{:else if !stats}
		<div class="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-9">{#each Array(9) as _, n (n)}<Skeleton class="h-[76px] w-full rounded-lg" />{/each}</div>
		<Skeleton class="h-52 w-full rounded-lg" />
	{:else}
		<div class="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-9 {loading ? 'opacity-60' : ''}" aria-label="Totals of the selected range and the change since the range before it">
			{#each tiles as t (t.label)}
				<Surface class="flex min-w-0 flex-col gap-0.5 px-3 py-2.5">
					<span class="truncate text-xs text-muted-foreground" title={t.label}>{t.label}</span>
					<span class="font-mono text-xl leading-tight tracking-tight tabular-nums">{t.value}</span>
					<span class="flex min-h-4 items-center gap-1 text-[11px] {tone(t)}">
						{#if t.delta}
							{#if t.delta.dir === 'up'}<ArrowUpIcon class="size-3" aria-hidden="true" />{:else if t.delta.dir === 'down'}<ArrowDownIcon class="size-3" aria-hidden="true" />{/if}
							<span class="tabular-nums">{t.delta.text}</span><span class="text-muted-foreground">vs before</span>
						{:else}<span class="text-muted-foreground">no earlier data</span>{/if}
					</span>
					{#if t.sub}<span class="truncate text-[11px] text-muted-foreground" title={t.sub}>{t.sub}</span>{/if}
				</Surface>
			{/each}
		</div>

		<div class="grid gap-3 xl:grid-cols-2">
			<Surface class="p-3">
				<BarChart title="Cost" {starts} bucketMs={stats.bucketMs} series={costSeries} format={formatUsd} axisFormat={axisUsd} {loading} empty="No cost in this range.">
					{#snippet actions()}
						<div class="flex gap-1" role="group" aria-label="Group cost by">
							<Button variant={costBy === 'source' ? 'secondary' : 'ghost'} size="sm" class={toggle} aria-pressed={costBy === 'source'} onclick={() => pickCost('source')}>By source</Button>
							<Button variant={costBy === 'agent' ? 'secondary' : 'ghost'} size="sm" class={toggle} aria-pressed={costBy === 'agent'} onclick={() => pickCost('agent')}>By agent</Button>
						</div>
					{/snippet}
				</BarChart>
			</Surface>
			<Surface class="p-3">
				<BarChart title="Tokens" {starts} bucketMs={stats.bucketMs} series={tokens} format={formatTokens} {loading} empty="No tokens in this range." />
			</Surface>
			<Surface class="p-3 xl:col-span-2">
				<BarChart title="Calls by status" {starts} bucketMs={stats.bucketMs} series={statuses} format={count} height={140} {loading} empty="No calls in this range." />
			</Surface>
		</div>

		<Surface class="overflow-hidden">
			<div class="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
				<span class="text-[13px] font-medium">Breakdown</span>
				<div class="flex gap-1" role="group" aria-label="Break down by">
					<Button variant={tableBy === 'model' ? 'secondary' : 'ghost'} size="sm" class={toggle} aria-pressed={tableBy === 'model'} onclick={() => pickTable('model')}>By model</Button>
					<Button variant={tableBy === 'agent' ? 'secondary' : 'ghost'} size="sm" class={toggle} aria-pressed={tableBy === 'agent'} onclick={() => pickTable('agent')}>By agent</Button>
				</div>
			</div>
			{#if rows.length === 0}
				<p class="px-3 py-6 text-center text-xs text-muted-foreground">No calls in this range.</p>
			{:else}
				<Table.Root class="min-w-[720px]">
					<Table.Header>
						<Table.Row class="hover:bg-transparent">
							<Table.Head>{tableBy === 'model' ? 'Model' : 'Agent'}</Table.Head>
							<Table.Head class="text-right">Calls</Table.Head>
							<Table.Head class="text-right">Input</Table.Head>
							<Table.Head class="text-right">Output</Table.Head>
							<Table.Head class="w-44 text-right">Cost</Table.Head>
							<Table.Head class="text-right">Avg latency</Table.Head>
							<Table.Head class="text-right">Errors</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each rows as r (r.key ?? '')}
							<Table.Row>
								<Table.Cell class="max-w-64 truncate {tableBy === 'model' ? 'font-mono text-xs' : ''}" title={rowName(r.key)}>{rowName(r.key)}</Table.Cell>
								<Table.Cell class="text-right font-mono text-xs tabular-nums">{count(r.calls)}</Table.Cell>
								<Table.Cell class="text-right font-mono text-xs tabular-nums">{formatTokens(r.inputTokens)}</Table.Cell>
								<Table.Cell class="text-right font-mono text-xs tabular-nums">{formatTokens(r.outputTokens)}</Table.Cell>
								<Table.Cell class="text-right font-mono text-xs tabular-nums">
									<span class="flex items-center justify-end gap-2">
										<span class="h-1.5 w-16 overflow-hidden rounded-full bg-muted" aria-hidden="true"><span class="block h-full rounded-full" style="width: {maxCost > 0 ? (r.costUsd / maxCost) * 100 : 0}%; background: var(--viz-1)"></span></span>
										{formatUsd(r.costUsd)}
									</span>
								</Table.Cell>
								<Table.Cell class="text-right font-mono text-xs whitespace-nowrap tabular-nums text-muted-foreground">{formatDuration(r.avgDurationMs)}</Table.Cell>
								<Table.Cell class="text-right font-mono text-xs tabular-nums {r.errors > 0 ? 'text-destructive-text' : 'text-muted-foreground'}">{count(r.errors)}</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
		</Surface>
	{/if}
</div>

<style>
	.viz-root {
		--viz-1: #2a78d6;
		--viz-2: #eb6834;
		--viz-3: #1baf7a;
		--viz-4: #eda100;
		--viz-5: #e87ba4;
		--viz-6: #008300;
		--viz-7: #6250d6;
		--viz-other: #898781;
		--viz-ok: #0ca30c;
		--viz-aborted: #fab219;
		--viz-error: #d03b3b;
	}
	:global(.dark) .viz-root {
		--viz-1: #3987e5;
		--viz-2: #d95926;
		--viz-3: #199e70;
		--viz-4: #c98500;
		--viz-5: #d55181;
		--viz-6: #008300;
		--viz-7: #9085e9;
		--viz-other: #8a8984;
	}
</style>
