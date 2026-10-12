<script lang="ts">
	import Surface from '#lib/components/app/Surface.svelte';
	import { api } from '#lib/api/index.js';
	import type { components } from '#lib/api/schema.js';
	import { badgeFor } from '#lib/board/board.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { REPORT_LABELS, type Program } from '#lib/programs/form.js';
	import { openTask } from '#lib/stores/drawer.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';
	import { formatUsd } from '#lib/time.js';

	type Task = components['schemas']['Task'];

	/** Run history (newest first) of one program: its task sessions with their final report. */
	let { program }: { program: Program } = $props();

	let runs = $state<Task[] | null>(null);
	let error = $state('');
	let seq = 0;

	$effect(() => {
		const id = program.id;
		void live.state.revs.programs;
		void live.state.tasks; // a run that ends updates its task
		const mine = ++seq;
		api.get('/programs/{id}/runs', { params: { id } }).then(
			(r) => {
				if (mine !== seq) return;
				runs = r.runs;
				error = '';
			},
			(e) => {
				if (mine === seq) error = e instanceof Error ? e.message : 'Could not load runs';
			}
		);
	});

	const when = (ms: number): string => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
</script>

<section class="flex flex-col gap-2" aria-label="Run history">
	<h3 class="text-sm font-medium">Run history</h3>
	{#if error}
		<p class="text-xs text-destructive-text" role="alert">{error}</p>
	{:else if !runs}
		<Skeleton class="h-12 w-full" />
		<Skeleton class="h-12 w-full" />
	{:else if !runs.length}
		<p class="text-xs text-muted-foreground">No runs yet.</p>
	{:else}
		<Surface as="ul" class="divide-y divide-border overflow-hidden rounded-lg">
			{#each runs as t (t.id)}
				{@const b = badgeFor(t.status, t.summary)}
				<li class="flex flex-col gap-1 px-3 py-2 text-xs">
					<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
						<Badge variant={b.variant}>{b.label}</Badge>
						{#if t.report && REPORT_LABELS[t.report.status].label !== b.label}<Badge variant={REPORT_LABELS[t.report.status].variant}>{REPORT_LABELS[t.report.status].label}</Badge>{/if}
						{#if t.deliverables}<Badge variant={t.deliverables.status === 'pass' ? 'success' : 'destructive'}>{t.deliverables.status === 'pass' ? 'deliverables ok' : 'deliverables failed'}</Badge>{/if}
						<span class="flex-1"></span>
						{#if t.costUsd > 0}<span class="font-mono text-muted-foreground">{formatUsd(t.costUsd)}</span>{/if}
						<button type="button" class="text-info-text underline underline-offset-4" onclick={() => openTask(t.id)}>Open task</button>
						<span class="text-muted-foreground">{when(t.startedAt)}</span>
					</div>
					{#if t.summary}<p class="text-muted-foreground">{t.summary}</p>{/if}
					{#if t.report?.outputs.length}
						<ul class="flex flex-wrap gap-1.5">
							{#each t.report.outputs as path (path)}<li class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{path}</li>{/each}
						</ul>
					{/if}
				</li>
			{/each}
		</Surface>
	{/if}
</section>
