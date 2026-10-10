<script lang="ts">
	import { api } from '#lib/api/index.js';
	import type { components } from '#lib/api/schema.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { openSession } from '#lib/stores/drawer.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';

	type Routine = components['schemas']['Routine'];
	type Run = components['schemas']['RoutineRun'];

	let { routine = $bindable() }: { routine: Routine | null } = $props();

	let runs = $state<Run[] | null>(null);
	let error = $state('');
	let seq = 0;

	$effect(() => {
		const id = routine?.id;
		void live.state.revs.routines;
		if (!id) {
			runs = null;
			return;
		}
		const mine = ++seq;
		api.get('/routines/{id}/runs', { params: { id } }).then(
			(r) => {
				if (mine === seq) (runs = r.runs, (error = ''));
			},
			(e) => {
				if (mine === seq) error = e instanceof Error ? e.message : 'Could not load runs';
			}
		);
	});

	const variant = (s: Run['status']): 'success' | 'destructive' | 'warning' | 'info' | 'outline' =>
		s === 'succeeded' ? 'success' : s === 'failed' ? 'destructive' : s === 'needs_action' ? 'warning' : s === 'skipped' ? 'outline' : 'info';

	const when = (ms: number): string => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
</script>

<Sheet.Root open={routine !== null} onOpenChange={(o) => !o && (routine = null)}>
	<Sheet.Content side="right" class="flex w-full flex-col gap-0 p-0 sm:max-w-md">
		<Sheet.Header class="border-b border-border p-4">
			<Sheet.Title class="truncate">{routine?.name ?? 'Routine'}: runs</Sheet.Title>
			<Sheet.Description>Newest first. Task-mode runs open on the board.</Sheet.Description>
		</Sheet.Header>
		<div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4 text-sm">
			{#if error}<p class="text-destructive-text">{error}</p>{/if}
			{#if !runs && !error}<p class="text-muted-foreground">Loading…</p>{/if}
			{#if runs && !runs.length}<p class="text-muted-foreground">No runs yet.</p>{/if}
			{#each runs ?? [] as r (r.id)}
				<div class="flex flex-col gap-1 rounded-lg border border-border bg-card p-3">
					<div class="flex items-center gap-2">
						<Badge variant={variant(r.status)}>{r.status.replace('_', ' ')}</Badge>
						{#if r.trigger === 'manual'}<Badge variant="outline">manual</Badge>{/if}
						<span class="ml-auto text-xs text-muted-foreground">{when(r.scheduledAt)}</span>
					</div>
					{#if r.reason}<p class="text-xs text-muted-foreground">{r.reason}</p>{/if}
					{#if routine?.sessionMode === 'task' && r.status !== 'skipped'}
						<button type="button" class="self-start text-xs text-info-text underline underline-offset-4" onclick={() => void openSession(r.sessionId)}>Open task</button>
					{/if}
				</div>
			{/each}
		</div>
	</Sheet.Content>
</Sheet.Root>
