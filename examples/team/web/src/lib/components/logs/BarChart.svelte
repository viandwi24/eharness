<script lang="ts">
	import type { Snippet } from 'svelte';
	import { axisLabel, bucketTitle, labelIndices, niceScale, stackTotal, type Series } from '#lib/logs/charts.js';

	/**
	 * Stacked columns over time: one column per bucket, one segment per series. Colors are CSS
	 * variables of the surrounding `.viz-root`. Legend above (with each series' total), recessive
	 * grid, a hover band with an exact-value tooltip, and a hidden table for screen readers.
	 */
	let {
		title,
		starts,
		bucketMs,
		series,
		format,
		axisFormat,
		height = 170,
		loading = false,
		empty = 'Nothing in this range.',
		actions
	}: {
		title: string;
		starts: number[];
		bucketMs: number;
		series: Series[];
		format: (n: number) => string;
		/** The y-axis labels (default `format`): round ticks read better without extra decimals. */
		axisFormat?: (n: number) => string;
		height?: number;
		loading?: boolean;
		empty?: string;
		/** Controls at the right of the title (a toggle). */
		actions?: Snippet;
	} = $props();

	const M = { left: 46, right: 8, top: 8, bottom: 20 };
	let width = $state(640);
	let hover = $state<number | null>(null);

	const n = $derived(starts.length);
	const totals = $derived(starts.map((_, i) => stackTotal(series, i)));
	const scale = $derived(niceScale(Math.max(0, ...totals)));
	const plotW = $derived(Math.max(10, width - M.left - M.right));
	const plotH = $derived(height - M.top - M.bottom);
	const slot = $derived(plotW / Math.max(1, n));
	const barW = $derived(Math.max(1, slot - (slot > 6 ? 2 : 1)));
	const y = (v: number): number => M.top + plotH - (v / scale.max) * plotH;
	const x = (i: number): number => M.left + i * slot + (slot - barW) / 2;
	const ticks = $derived(labelIndices(n, Math.max(2, Math.floor(plotW / 84))));
	const hasData = $derived(totals.some((t) => t > 0));
	const grand = (s: Series): number => s.values.reduce((a, b) => a + b, 0);
	// segment rects per column, bottom to top
	const columns = $derived(
		starts.map((_, i) => {
			let acc = 0;
			return series.flatMap((s) => {
				const v = s.values[i] ?? 0;
				if (!(v > 0)) return [];
				const top = y(acc + v);
				const bottom = y(acc);
				acc += v;
				return [{ key: s.key, color: s.color, y: top, h: Math.max(1, bottom - top) }];
			});
		})
	);
	const tipLeft = $derived(hover === null ? 0 : M.left + hover * slot + slot / 2);
	const flip = $derived(hover !== null && tipLeft > width * 0.6);

	function at(e: PointerEvent): void {
		const box = (e.currentTarget as SVGElement).getBoundingClientRect();
		const i = Math.floor((e.clientX - box.left - M.left) / slot);
		hover = i >= 0 && i < n ? i : null;
	}
</script>

<div class="flex min-w-0 flex-col gap-2">
	<div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
		<h3 class="text-[13px] font-medium">{title}</h3>
		{#if actions}<div class="ml-auto order-2">{@render actions()}</div>{/if}
		<ul class="order-3 flex w-full flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-label="{title} legend">
			{#each series as s (s.key)}
				<li class="flex items-center gap-1.5">
					<span class="size-2.5 shrink-0 rounded-[3px]" style="background: {s.color}"></span>
					<span>{s.label}</span>
					<span class="font-mono tabular-nums text-foreground">{format(grand(s))}</span>
				</li>
			{/each}
		</ul>
	</div>
	<div class="relative min-w-0 {loading ? 'opacity-60' : ''}" bind:clientWidth={width}>
		{#if !hasData}
			<p class="flex items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground" style="height: {height}px">{empty}</p>
		{:else}
			<svg {width} {height} role="img" aria-label="{title}: {format(totals.reduce((a, b) => a + b, 0))} in total" class="block touch-none select-none" onpointermove={at} onpointerdown={at} onpointerleave={() => (hover = null)}>
				{#each scale.lines as v (v)}
					<line x1={M.left} x2={width - M.right} y1={y(v)} y2={y(v)} stroke="var(--border)" stroke-width="1" opacity={v === 0 ? 1 : 0.6} />
					<text x={M.left - 6} y={y(v)} dy="0.32em" text-anchor="end" font-size="10.5" fill="var(--muted-foreground)" class="tabular-nums">{(axisFormat ?? format)(v)}</text>
				{/each}
				{#if hover !== null}
					<rect x={M.left + hover * slot} y={M.top} width={slot} height={plotH} fill="var(--foreground)" opacity="0.07" />
				{/if}
				{#each columns as col, i (starts[i])}
					{#each col as seg (seg.key)}
						<rect x={x(i)} y={seg.y} width={barW} height={seg.h} fill={seg.color} stroke="var(--card)" stroke-width="1" />
					{/each}
				{/each}
				{#each ticks as i (i)}
					<text x={M.left + i * slot + slot / 2} y={height - 5} text-anchor="middle" font-size="10.5" fill="var(--muted-foreground)">{axisLabel(starts[i]!, bucketMs)}</text>
				{/each}
			</svg>
			{#if hover !== null}
				<div class="pointer-events-none absolute z-10 min-w-40 rounded-lg border border-border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md" style="top: 4px; {flip ? `right: ${width - tipLeft + 10}px` : `left: ${tipLeft + 10}px`}">
					<div class="mb-1 font-medium">{bucketTitle(starts[hover]!, bucketMs)}</div>
					{#each [...series].reverse() as s (s.key)}
						{@const v = s.values[hover] ?? 0}
						{#if v > 0}
							<div class="flex items-center gap-1.5">
								<span class="size-2.5 shrink-0 rounded-[3px]" style="background: {s.color}"></span>
								<span class="text-muted-foreground">{s.label}</span>
								<span class="ml-auto pl-3 font-mono tabular-nums">{format(v)}</span>
							</div>
						{/if}
					{/each}
					{#if series.filter((s) => (s.values[hover!] ?? 0) > 0).length > 1}
						<div class="mt-1 flex border-t border-border pt-1"><span class="text-muted-foreground">Total</span><span class="ml-auto pl-3 font-mono tabular-nums">{format(totals[hover]!)}</span></div>
					{/if}
					{#if totals[hover] === 0}<div class="text-muted-foreground">Nothing</div>{/if}
				</div>
			{/if}
			<table class="sr-only">
				<caption>{title}</caption>
				<thead><tr><th>Time</th>{#each series as s (s.key)}<th>{s.label}</th>{/each}</tr></thead>
				<tbody>
					{#each starts as start, i (start)}
						<tr><th>{bucketTitle(start, bucketMs)}</th>{#each series as s (s.key)}<td>{format(s.values[i] ?? 0)}</td>{/each}</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</div>
</div>
