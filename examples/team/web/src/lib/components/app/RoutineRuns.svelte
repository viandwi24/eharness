<script lang="ts">
	import { formatDateTime } from '#lib/time.js';
	import Surface from '#lib/components/app/Surface.svelte';
	import { api } from '#lib/api/index.js';
	import type { components } from '#lib/api/schema.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { openSession } from '#lib/stores/drawer.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';

	type Routine = components['schemas']['Routine'];
	type Run = components['schemas']['RoutineRun'];

	/** Inline run history (newest first) for one routine; refreshes on live routine updates. */
	let { routine }: { routine: Routine } = $props();

	let runs = $state<Run[] | null>(null);
	let error = $state('');
	let seq = 0;

	$effect(() => {
		const id = routine.id;
		void live.state.revs.routines;
		const mine = ++seq;
		api.get('/routines/{id}/runs', { params: { id } }).then(
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

	const variant = (s: Run['status']): 'success' | 'destructive' | 'warning' | 'info' | 'outline' =>
		s === 'succeeded' ? 'success' : s === 'failed' ? 'destructive' : s === 'needs_action' ? 'warning' : s === 'skipped' ? 'outline' : 'info';

	const when = (ms: number): string => formatDateTime(ms);
</script>

<section class="flex flex-col gap-2" aria-label="Run history">
	<h3 class="text-sm font-medium">Run history</h3>
	{#if error}
		<p class="text-xs text-destructive-text" role="alert">{error}</p>
	{:else if !runs}
		<Skeleton class="h-9 w-full" />
		<Skeleton class="h-9 w-full" />
	{:else if !runs.length}
		<p class="text-xs text-muted-foreground">No runs yet.</p>
	{:else}
		<Surface as="ul" class="divide-y divide-border overflow-hidden rounded-lg">
			{#each runs as r (r.id)}
				<li class="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-xs">
					<Badge variant={variant(r.status)}>{r.status.replace('_', ' ')}</Badge>
					{#if r.trigger === 'manual'}<Badge variant="outline">manual</Badge>{/if}
					{#if r.reason}<span class="min-w-0 flex-1 truncate text-muted-foreground" title={r.reason}>{r.reason}</span>{:else}<span class="flex-1"></span>{/if}
					{#if routine.sessionMode === 'task' && r.status !== 'skipped'}
						<button type="button" class="text-info-text underline underline-offset-4" onclick={() => void openSession(r.sessionId)}>Open task</button>
					{/if}
					<span class="text-muted-foreground">{when(r.scheduledAt)}</span>
				</li>
			{/each}
		</Surface>
	{/if}
</section>
