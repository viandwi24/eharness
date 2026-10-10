<script lang="ts">
	import Surface from '#lib/components/app/Surface.svelte';
	import ClockIcon from 'phosphor-svelte/lib/Clock';
	import PauseIcon from 'phosphor-svelte/lib/Pause';
	import PlayIcon from 'phosphor-svelte/lib/Play';
	import LightningIcon from 'phosphor-svelte/lib/Lightning';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import { api } from '#lib/api/index.js';
	import type { components } from '#lib/api/schema.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { routineAction } from '#lib/routines/actions.js';
	import { describeSpec, relativeTime, routineBadge } from '#lib/routines/schedule.js';
	import { openEditRoutine, openNewRoutine } from '#lib/stores/dialogs.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';

	type Routine = components['schemas']['Routine'];

	// `routines` / `onChange` are accepted for older callers; the tab loads and refreshes itself.
	let { agentId }: { agentId: string; routines?: Routine[]; onChange?: () => void } = $props();

	let routines = $state<Routine[] | null>(null);
	let error = $state('');
	let busy = $state<string | null>(null);
	let seq = 0;

	async function load(): Promise<void> {
		const mine = ++seq;
		try {
			const r = await api.get('/routines', { query: { agentId } });
			if (mine !== seq) return;
			routines = r.routines;
			error = '';
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not load routines';
		}
	}

	$effect(() => {
		void agentId;
		void live.state.revs.routines;
		void load();
	});

	async function act(r: Routine, action: 'pause' | 'resume' | 'run'): Promise<void> {
		busy = r.id;
		await routineAction(r, action);
		busy = null;
	}
</script>

{#snippet iconAction(label: string, disabled: boolean, onclick: () => void, icon: typeof PlayIcon)}
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<Button {...props} variant="ghost" size="icon-sm" aria-label={label} {disabled} {onclick}>
					{@const Icon = icon}
					<Icon class="size-4" />
				</Button>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content>{label}</Tooltip.Content>
	</Tooltip.Root>
{/snippet}

<Tooltip.Provider>
	<div class="flex flex-col gap-2 text-sm">
		<div class="flex items-center justify-between">
			<span class="text-xs text-muted-foreground">{routines ? `${routines.length} routine${routines.length === 1 ? '' : 's'}` : ''}</span>
			<Button size="sm" variant="outline" onclick={() => openNewRoutine(agentId)}><PlusIcon class="size-4" /> New routine</Button>
		</div>

		{#if error}
			<p class="text-xs text-destructive-text" role="alert">{error} <button class="underline underline-offset-4" onclick={() => void load()}>Retry</button></p>
		{:else if !routines}
			<Skeleton class="h-14 w-full" />
			<Skeleton class="h-14 w-full" />
		{:else if !routines.length}
			<Empty.Root class="border border-dashed border-border p-6">
				<Empty.Header>
					<Empty.Media variant="icon"><ClockIcon /></Empty.Media>
					<Empty.Title>No routines yet</Empty.Title>
					<Empty.Description>Schedule a prompt and this agent runs it on its own.</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{:else}
			<Surface as="ul" class="flex flex-col divide-y divide-border overflow-hidden">
				{#each routines as r (r.id)}
					{@const b = routineBadge(r)}
					<li class="flex items-center gap-1 pr-1.5 pl-3">
						<button type="button" class="flex min-w-0 flex-1 flex-col gap-0.5 py-2.5 text-left outline-none focus-visible:underline" onclick={() => openEditRoutine(r.id)}>
							<span class="flex items-center gap-2">
								<span class="truncate font-medium">{r.name}</span>
								<Badge variant={b.variant} class="shrink-0">{b.label}</Badge>
							</span>
							<span class="truncate text-xs text-muted-foreground">
								{describeSpec(r.schedule)} · {r.status === 'active' ? `next ${relativeTime(r.nextFireAt)}` : 'not scheduled'}
							</span>
						</button>
						{#if r.status === 'active'}
							{@render iconAction('Pause', busy === r.id, () => void act(r, 'pause'), PauseIcon)}
						{:else}
							{@render iconAction('Resume', busy === r.id, () => void act(r, 'resume'), PlayIcon)}
						{/if}
						{@render iconAction('Run now', busy === r.id, () => void act(r, 'run'), LightningIcon)}
					</li>
				{/each}
			</Surface>
		{/if}
	</div>
</Tooltip.Provider>
