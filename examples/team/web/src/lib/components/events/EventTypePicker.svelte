<script lang="ts">
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { groupCatalog, toggleType, type EventTypeInfo } from '#lib/events/events.js';

	/** Event types as checkboxes grouped by source (chat / app), each with a short hint. */
	let {
		types,
		selected = $bindable([]),
		hints = false,
		id = 'event-types',
		onchange
	}: { types: EventTypeInfo[]; selected?: string[]; onchange?: (types: string[]) => void; /** Show the adapter's note under each type (the catalog of one connection has them). */ hints?: boolean; id?: string } = $props();

	const groups = $derived(groupCatalog(types));
</script>

<div class="flex flex-col gap-3" role="group" aria-label="Event types">
	{#each groups as g (g.source)}
		<div>
			<div class="mb-1 text-xs font-semibold text-muted-foreground">{g.label}</div>
			<div class="flex flex-col">
				{#each g.types as t (t.type)}
					<label class="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-muted/50">
						<Checkbox class="mt-0.5" checked={selected.includes(t.type)} onCheckedChange={() => {
							selected = toggleType(selected, t.type);
							onchange?.(selected);
						}} aria-label={t.label} data-testid="{id}-{t.type}" />
						<span class="min-w-0 text-[13px] leading-5">
							<span>{t.label}</span> <span class="font-mono text-[11px] text-muted-foreground">{t.type}</span>
							{#if hints && t.note}
								<span class="block text-xs text-muted-foreground">{t.note}</span>
							{/if}
						</span>
					</label>
				{/each}
			</div>
		</div>
	{/each}
</div>
