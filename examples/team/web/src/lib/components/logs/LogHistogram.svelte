<script lang="ts">
	import type { ModelCallStats } from '#lib/api/client.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { formatTokens } from '#lib/context.js';
	import { bucketLabel, formatDateTime } from '#lib/logs/logs.js';
	import { formatUsd } from '#lib/time.js';

	/** Calls per bucket as bars; the share with errors is stacked on top in the destructive color. */
	let { stats, loading = false, error = null }: { stats: ModelCallStats | null; loading?: boolean; error?: string | null } = $props();

	const max = $derived(Math.max(1, ...(stats?.buckets.map((b) => b.count) ?? [1])));
	const labels = $derived.by(() => {
		const b = stats?.buckets ?? [];
		if (b.length < 2) return [];
		const at = [0, Math.floor((b.length - 1) / 2), b.length - 1];
		return at.map((i) => ({ i, text: bucketLabel(b[i]!.start, stats!.bucketMs) }));
	});
</script>

<div class="flex flex-col gap-1.5">
	{#if error && !stats}
		<p class="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">Could not load the chart: {error}</p>
	{:else if !stats}
		<Skeleton class="h-24 w-full rounded-lg" />
	{:else}
		<div
			class="flex h-24 items-end gap-px rounded-lg border border-border bg-card px-2 pt-2 pb-0 {loading ? 'opacity-60' : ''}"
			role="img"
			aria-label="Calls over time: {stats.totals.count} calls, {stats.totals.errors} errors"
		>
			{#each stats.buckets as b (b.start)}
				{@const ok = b.count - b.errors}
				<div
					class="group relative flex h-full min-w-px flex-1 flex-col justify-end"
					title="{formatDateTime(b.start)}&#10;{b.count} call{b.count === 1 ? '' : 's'}{b.errors ? `, ${b.errors} error${b.errors === 1 ? '' : 's'}` : ''}&#10;{formatTokens(b.inputTokens)} in · {formatTokens(b.outputTokens)} out · {formatUsd(b.costUsd)}"
				>
					{#if b.errors > 0}<div class="w-full rounded-t-[2px] bg-destructive" style="height: {(b.errors / max) * 100}%; min-height: 2px"></div>{/if}
					{#if ok > 0}<div class="w-full bg-muted-foreground opacity-50 group-hover:opacity-80 {b.errors > 0 ? '' : 'rounded-t-[2px]'}" style="height: {(ok / max) * 100}%; min-height: 2px"></div>{/if}
				</div>
			{/each}
		</div>
		<div class="flex justify-between px-1 text-[11px] text-muted-foreground tabular-nums" aria-hidden="true">
			{#each labels as l (l.i)}<span>{l.text}</span>{/each}
		</div>
	{/if}
</div>
