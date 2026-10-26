<script lang="ts">
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import SigmaIcon from 'phosphor-svelte/lib/Sigma';
	import XIcon from 'phosphor-svelte/lib/X';
	import { api } from '#lib/api/index.js';
	import Surface from '#lib/components/app/Surface.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { aggregateOf, type Filter, formatCell, type MetricDraft, metricName, type MetricOp } from '#lib/tables/tables.js';

	/** Group the rows by up to 3 fields and compute count / sum / avg / min / max. */
	let { table, fields, numericFields, filter }: { table: string; fields: string[]; numericFields: string[]; filter: Filter | undefined } = $props();

	const OPS: MetricOp[] = ['count', 'sum', 'avg', 'min', 'max'];
	let groupBy = $state<string[]>(['']);
	let metrics = $state<MetricDraft[]>([{ op: 'count', field: '' }]);
	let useFilter = $state(true);
	let busy = $state(false);
	let error = $state('');
	let result = $state<{ columns: string[]; groups: Record<string, unknown>[] } | null>(null);

	async function run(): Promise<void> {
		error = '';
		const spec = aggregateOf(groupBy, metrics, useFilter ? filter : undefined);
		if (!spec.ok) {
			error = spec.error;
			return;
		}
		busy = true;
		try {
			const r = await api.post('/tables/{table}/aggregate', { params: { table }, body: spec.body });
			result = { columns: [...(spec.body.groupBy ?? []), ...Object.keys(spec.body.metrics)], groups: r.groups };
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not compute the summary';
		} finally {
			busy = false;
		}
	}

	const fmt = (v: unknown): string => (typeof v === 'number' && !Number.isInteger(v) ? v.toLocaleString(undefined, { maximumFractionDigits: 4 }) : v === null || v === undefined ? '—' : formatCell(v));
</script>

<div class="flex flex-col gap-4">
	<Surface class="flex flex-col gap-4 p-4">
		<div class="flex flex-col gap-2">
			<span class="text-sm font-medium">Group by</span>
			<div class="flex flex-wrap items-center gap-2">
				{#each groupBy as _, i (i)}
					<div class="flex items-center gap-1">
						<NativeSelect bind:value={groupBy[i]} size="sm" aria-label="Group field {i + 1}" class="w-40">
							<NativeSelectOption value="">{i === 0 ? 'Nothing (one total)' : '—'}</NativeSelectOption>
							{#each fields as f (f)}<NativeSelectOption value={f}>{f}</NativeSelectOption>{/each}
						</NativeSelect>
						{#if groupBy.length > 1}
							<Button variant="ghost" size="icon-sm" aria-label="Remove group field" onclick={() => (groupBy = groupBy.filter((_, j) => j !== i))}><XIcon class="size-4" /></Button>
						{/if}
					</div>
				{/each}
				{#if groupBy.length < 3}
					<Button variant="ghost" size="sm" onclick={() => (groupBy = [...groupBy, ''])}><PlusIcon class="size-4" /> Field</Button>
				{/if}
			</div>
		</div>
		<div class="flex flex-col gap-2">
			<span class="text-sm font-medium">Metrics</span>
			{#each metrics as m, i (i)}
				<div class="flex flex-wrap items-center gap-1.5">
					<NativeSelect bind:value={m.op} size="sm" aria-label="Metric" class="w-28">
						{#each OPS as o (o)}<NativeSelectOption value={o}>{o}</NativeSelectOption>{/each}
					</NativeSelect>
					{#if m.op !== 'count'}
						<span class="text-xs text-muted-foreground">of</span>
						<NativeSelect bind:value={m.field} size="sm" aria-label="Metric field" class="w-40">
							<NativeSelectOption value="">Pick a field</NativeSelectOption>
							{#each m.op === 'sum' || m.op === 'avg' ? numericFields : fields as f (f)}<NativeSelectOption value={f}>{f}</NativeSelectOption>{/each}
						</NativeSelect>
					{/if}
					<span class="font-mono text-xs text-muted-foreground">→ {metricName(m)}</span>
					{#if metrics.length > 1}
						<Button variant="ghost" size="icon-sm" aria-label="Remove metric" onclick={() => (metrics = metrics.filter((_, j) => j !== i))}><XIcon class="size-4" /></Button>
					{/if}
				</div>
			{/each}
			<div><Button variant="ghost" size="sm" onclick={() => (metrics = [...metrics, { op: 'sum', field: '' }])}><PlusIcon class="size-4" /> Metric</Button></div>
		</div>
		<div class="flex flex-wrap items-center justify-between gap-3">
			<label class="flex items-center gap-2 text-sm {filter ? '' : 'text-muted-foreground'}">
				<Checkbox checked={useFilter && !!filter} disabled={!filter} onCheckedChange={(v) => (useFilter = v === true)} />
				Only rows matching the current filter
			</label>
			<Button size="sm" disabled={busy} onclick={() => void run()}><SigmaIcon class="size-4" /> Compute</Button>
		</div>
		{#if error}<p class="text-sm text-destructive-text" role="alert">{error}</p>{/if}
	</Surface>

	{#if result}
		{#if result.groups.length === 0}
			<p class="text-sm text-muted-foreground">No rows to summarise.</p>
		{:else}
			<Surface class="overflow-hidden">
				<Table.Root>
					<Table.Header>
						<Table.Row>
							{#each result.columns as c (c)}<Table.Head class="font-mono">{c}</Table.Head>{/each}
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each result.groups as g, i (i)}
							<Table.Row>
								{#each result.columns as c (c)}
									<Table.Cell class="max-w-64 truncate" data-numeric={typeof g[c] === 'number' ? true : undefined}>{fmt(g[c])}</Table.Cell>
								{/each}
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Surface>
			<p class="text-xs text-muted-foreground">{result.groups.length} group{result.groups.length === 1 ? '' : 's'}{result.groups.length >= 200 ? ' (the first 200)' : ''}.</p>
		{/if}
	{/if}
</div>
