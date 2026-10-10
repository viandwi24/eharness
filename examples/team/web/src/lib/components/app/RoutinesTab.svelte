<script lang="ts">
	import ClockIcon from 'phosphor-svelte/lib/Clock';
	import { api } from '#lib/api/index.js';
	import type { components } from '#lib/api/schema.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { describeSpec, relativeTime, routineBadge } from '#lib/routines/schedule.js';
	import RoutineEditor from './RoutineEditor.svelte';
	import RoutineRuns from './RoutineRuns.svelte';

	type Routine = components['schemas']['Routine'];

	let { agentId, routines, onChange }: { agentId: string; routines: Routine[]; onChange: () => void } = $props();

	let editorOpen = $state(false);
	let editing = $state<Routine | undefined>(undefined);
	let runsFor = $state<Routine | null>(null);
	let busy = $state<string | null>(null);

	function edit(r?: Routine): void {
		editing = r;
		editorOpen = true;
	}

	async function act(r: Routine, action: 'pause' | 'resume' | 'run'): Promise<void> {
		busy = r.id;
		try {
			await api.post(`/routines/{id}/${action}`, { params: { id: r.id } });
			if (action === 'run') toast.success(`${r.name} started`);
			onChange();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : `Could not ${action} the routine`);
		} finally {
			busy = null;
		}
	}

	async function remove(r: Routine): Promise<void> {
		if (!confirm(`Delete routine "${r.name}"? Its run history is removed too.`)) return;
		try {
			await api.delete('/routines/{id}', { params: { id: r.id } });
			onChange();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not delete the routine');
		}
	}
</script>

<div class="flex flex-col gap-2">
	{#each routines as r (r.id)}
		{@const b = routineBadge(r)}
		<div class="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
			<div class="flex items-center gap-2">
				<ClockIcon class="size-4 shrink-0 text-muted-foreground" />
				<div class="min-w-0 flex-1">
					<div class="truncate font-medium">{r.name}</div>
					<div class="text-xs text-muted-foreground">{describeSpec(r.schedule)}</div>
				</div>
				<Badge variant={b.variant}>{b.label}</Badge>
			</div>
			<div class="text-xs text-muted-foreground">
				{#if r.status === 'active'}Next {relativeTime(r.nextFireAt)}{:else}Not scheduled{/if}
				· Last {r.lastFireAt ? `${relativeTime(r.lastFireAt)}${r.lastStatus ? `, ${r.lastStatus.replace('_', ' ')}` : ''}` : 'never'}
			</div>
			<div class="flex flex-wrap gap-1.5">
				{#if r.status === 'active'}
					<Button size="sm" variant="outline" disabled={busy === r.id} onclick={() => void act(r, 'pause')}>Pause</Button>
				{:else}
					<Button size="sm" variant="outline" disabled={busy === r.id} onclick={() => void act(r, 'resume')}>Resume</Button>
				{/if}
				<Button size="sm" variant="outline" disabled={busy === r.id} onclick={() => void act(r, 'run')}>Run now</Button>
				<Button size="sm" variant="ghost" onclick={() => (runsFor = r)}>Runs</Button>
				<Button size="sm" variant="ghost" onclick={() => edit(r)}>Edit</Button>
				<Button size="sm" variant="ghost" onclick={() => void remove(r)}>Delete</Button>
			</div>
		</div>
	{:else}
		<p class="text-muted-foreground">No routines for this agent.</p>
	{/each}
	<Button size="sm" variant="outline" class="self-start" onclick={() => edit()}>New routine</Button>
</div>

<RoutineEditor bind:open={editorOpen} {agentId} routine={editing} onSaved={() => onChange()} />
<RoutineRuns bind:routine={runsFor} />
