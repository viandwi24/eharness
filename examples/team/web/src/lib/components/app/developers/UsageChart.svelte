<script lang="ts">
	import { chartDays, costText } from '#lib/developers/model.js';

	/** Requests and cost per UTC day: bars scaled to the busiest day (a plain list of divs, no library). */
	let { days, span = 14 }: { days: { day: number; requests: number; costUsd: number }[]; span?: number } = $props();

	const rows = $derived(chartDays(days, span, Date.now()));
	const max = $derived(Math.max(1, ...rows.map((d) => d.requests)));
	const label = (day: number): string => new Date(day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
</script>

<div class="flex h-28 items-end gap-1" role="img" aria-label="Requests per day over the last {span} days" data-testid="usage-chart">
	{#each rows as d (d.day)}
		<div class="flex h-full min-w-0 flex-1 flex-col justify-end" title="{label(d.day)}: {d.requests} request{d.requests === 1 ? '' : 's'}, {costText(d.costUsd)}">
			<div class="w-full rounded-t bg-primary/70" style="height: {d.requests === 0 ? 2 : Math.max(4, (d.requests / max) * 100)}%"></div>
		</div>
	{/each}
</div>
<div class="mt-1 flex justify-between text-[10px] text-muted-foreground"><span>{label(rows[0]?.day ?? 0)}</span><span>{label(rows.at(-1)?.day ?? 0)} (UTC)</span></div>
