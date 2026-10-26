<script lang="ts">
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import XIcon from 'phosphor-svelte/lib/X';
	import { api } from '#lib/api/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { displayCell, type GridColumn } from '#lib/tables/grid.js';
	import { aggregateOf, type Filter, type MetricDraft, metricName, type MetricOp } from '#lib/tables/tables.js';

	/** Group rows and count / add up / average them, with a simple bar for the first number. */
	let { open = $bindable(false), table, fields, filter }: { open?: boolean; table: string; fields: GridColumn[]; filter: Filter | undefined } = $props();

	const OPS: { id: MetricOp; label: string }[] = [
		{ id: 'count', label: 'Count rows' },
		{ id: 'sum', label: 'Sum of' },
		{ id: 'avg', label: 'Average of' },
		{ id: 'min', label: 'Smallest' },
		{ id: 'max', label: 'Largest' }
	];

	let groupBy = $state<string[]>(['']);
	let metrics = $state<MetricDraft[]>([{ op: 'count', field: '' }]);
	let useFilter = $state(true);
	let busy = $state(false);
	let error = $state('');
	let result = $state<{ groups: string[]; metrics: { key: string; label: string }[]; rows: Record<string, unknown>[] } | null>(null);
	let seq = 0;

	const groupable = $derived(fields.filter((f) => f.type !== 'json' && f.kind !== 'system'));
	const numeric = $derived(fields.filter((f) => f.type === 'number' || f.type === 'date'));
	const labelOf = (field: string): string => fields.find((f) => f.field === field)?.label ?? field;
	const typeOf = (field: string) => fields.find((f) => f.field === field)?.type ?? 'string';
	const metricLabel = (m: MetricDraft): string => (m.op === 'count' ? 'Rows' : `${OPS.find((o) => o.id === m.op)?.label.replace(' of', '')} ${labelOf(m.field)}`);

	async function run(): Promise<void> {
		const mine = ++seq;
		error = '';
		const ready = metrics.filter((m) => m.op === 'count' || m.field);
		const spec = aggregateOf(groupBy, ready, useFilter ? filter : undefined);
		if (!spec.ok) {
			error = spec.error;
			return;
		}
		const groups = spec.body.groupBy ?? [];
		const first = Object.keys(spec.body.metrics)[0];
		if (groups.length && first) spec.body.sort = { by: first, dir: 'desc' };
		busy = true;
		try {
			const r = await api.post('/tables/{table}/aggregate', { params: { table }, body: spec.body });
			if (mine !== seq) return;
			const seen = new Set<string>();
			const ms = ready.length ? ready : [{ op: 'count' as const, field: '' }];
			result = {
				groups,
				metrics: ms.map((m) => ({ key: metricName(m), label: metricLabel(m) })).filter((m) => (seen.has(m.key) ? false : (seen.add(m.key), true))),
				rows: r.groups
			};
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not summarize';
		} finally {
			if (mine === seq) busy = false;
		}
	}

	// recompute shortly after any change while open
	$effect(() => {
		if (!open) return;
		void JSON.stringify([groupBy, metrics, useFilter, filter]);
		const t = setTimeout(() => void run(), 250);
		return () => clearTimeout(t);
	});

	const fmt = (v: unknown, field?: string): string => {
		if (v === null || v === undefined || v === '') return '(empty)';
		if (typeof v === 'number') return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
		return displayCell(v, field ? typeOf(field) : 'string');
	};
	const max = $derived(result && result.metrics[0] ? Math.max(0, ...result.rows.map((r) => Number(r[result!.metrics[0]!.key]) || 0)) : 0);
</script>

<Sheet.Root bind:open>
	<Sheet.Content side="right" class="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
		<Sheet.Header class="border-b border-border pb-4">
			<Sheet.Title>Summarize</Sheet.Title>
			<Sheet.Description>Group rows and count or add them up.</Sheet.Description>
		</Sheet.Header>
		<div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
			<div class="flex flex-col gap-2">
				<span class="text-sm font-medium">Group by</span>
				<div class="flex flex-wrap items-center gap-2">
					{#each groupBy as _, i (i)}
						<div class="flex items-center gap-1">
							<NativeSelect bind:value={groupBy[i]} size="sm" aria-label="Group field {i + 1}" class="w-44">
								<NativeSelectOption value="">{i === 0 ? 'No grouping (totals)' : '—'}</NativeSelectOption>
								{#each groupable as f (f.key)}<NativeSelectOption value={f.field}>{f.label}</NativeSelectOption>{/each}
							</NativeSelect>
							{#if groupBy.length > 1}<Button variant="ghost" size="icon-sm" aria-label="Remove group" onclick={() => (groupBy = groupBy.filter((_, j) => j !== i))}><XIcon class="size-4" /></Button>{/if}
						</div>
					{/each}
					{#if groupBy.length < 2 && groupBy[0]}<Button variant="ghost" size="sm" onclick={() => (groupBy = [...groupBy, ''])}><PlusIcon class="size-4" /> Then by</Button>{/if}
				</div>
			</div>

			<div class="flex flex-col gap-2">
				<span class="text-sm font-medium">Show</span>
				{#each metrics as m, i (i)}
					<div class="flex flex-wrap items-center gap-1.5">
						<NativeSelect bind:value={m.op} size="sm" aria-label="Measure" class="w-36">
							{#each OPS as o (o.id)}<NativeSelectOption value={o.id}>{o.label}</NativeSelectOption>{/each}
						</NativeSelect>
						{#if m.op !== 'count'}
							<NativeSelect bind:value={m.field} size="sm" aria-label="Field" class="w-44">
								<NativeSelectOption value="">Pick a field</NativeSelectOption>
								{#each m.op === 'sum' || m.op === 'avg' ? numeric.filter((f) => f.type === 'number') : numeric as f (f.key)}<NativeSelectOption value={f.field}>{f.label}</NativeSelectOption>{/each}
							</NativeSelect>
						{/if}
						{#if metrics.length > 1}<Button variant="ghost" size="icon-sm" aria-label="Remove" onclick={() => (metrics = metrics.filter((_, j) => j !== i))}><XIcon class="size-4" /></Button>{/if}
					</div>
				{/each}
				{#if metrics.length < 5}
					<div><Button variant="ghost" size="sm" class="-ml-2" disabled={!numeric.length} title={numeric.length ? '' : 'Add a Number field to add up values'} onclick={() => (metrics = [...metrics, { op: 'sum', field: numeric.find((f) => f.type === 'number')?.field ?? '' }])}><PlusIcon class="size-4" /> Add a number</Button></div>
				{/if}
			</div>

			<label class="flex items-center gap-2 text-sm {filter ? '' : 'text-muted-foreground'}">
				<Checkbox checked={useFilter && !!filter} disabled={!filter} onCheckedChange={(v) => (useFilter = v === true)} />
				Only rows matching the current filter and search{filter ? '' : ' (none set)'}
			</label>

			<div class="flex flex-col gap-2 border-t border-border pt-4">
				{#if error}
					<p class="text-sm text-destructive-text" role="alert">{error}</p>
				{:else if !result}
					<Skeleton class="h-24 w-full" />
				{:else if result.rows.length === 0}
					<p class="text-sm text-muted-foreground">No rows to summarize.</p>
				{:else if !result.groups.length}
					<div class="grid grid-cols-2 gap-2 {busy ? 'opacity-60' : ''}">
						{#each result.metrics as m (m.key)}
							<div class="rounded-lg border border-border p-3">
								<p class="text-xs text-muted-foreground">{m.label}</p>
								<p class="text-2xl font-semibold tabular-nums">{fmt(result.rows[0]?.[m.key])}</p>
							</div>
						{/each}
					</div>
				{:else}
					<div class="overflow-x-auto rounded-lg border border-border {busy ? 'opacity-60' : ''}">
						<table class="w-full text-[13px]">
							<thead class="bg-muted/60 text-xs text-muted-foreground">
								<tr>
									{#each result.groups as g (g)}<th class="px-3 py-2 text-left font-medium">{labelOf(g)}</th>{/each}
									{#each result.metrics as m (m.key)}<th class="px-3 py-2 text-right font-medium">{m.label}</th>{/each}
									<th class="w-1/3 px-3 py-2"><span class="sr-only">Bar</span></th>
								</tr>
							</thead>
							<tbody>
								{#each result.rows as r, i (i)}
									{@const first = Number(r[result.metrics[0]?.key ?? '']) || 0}
									<tr class="border-t border-border">
										{#each result.groups as g (g)}<td class="max-w-48 truncate px-3 py-1.5 {r[g] === null || r[g] === undefined || r[g] === '' ? 'text-muted-foreground italic' : ''}">{fmt(r[g], g)}</td>{/each}
										{#each result.metrics as m (m.key)}<td class="px-3 py-1.5 text-right tabular-nums">{fmt(r[m.key])}</td>{/each}
										<td class="px-3 py-1.5">
											<div class="h-2 rounded-full bg-muted">
												<div class="h-2 rounded-full bg-chart-1" style="width: {max > 0 ? Math.max(2, (first / max) * 100) : 0}%"></div>
											</div>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					<p class="text-xs text-muted-foreground">{result.rows.length} group{result.rows.length === 1 ? '' : 's'}{result.rows.length >= 200 ? ' (the first 200)' : ''}, largest first.</p>
				{/if}
			</div>
		</div>
	</Sheet.Content>
</Sheet.Root>
