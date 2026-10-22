<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import PauseIcon from 'phosphor-svelte/lib/Pause';
	import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimple';
	import PlayIcon from 'phosphor-svelte/lib/Play';
	import { onMount } from 'svelte';
	import { api } from '#lib/api/index.js';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import ProgramMemory from '#lib/components/app/ProgramMemory.svelte';
	import Surface from '#lib/components/app/Surface.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { authoritySummary, budgetSummary, programBadge, type Program } from '#lib/programs/form.js';
	import { programAction } from '#lib/programs/actions.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { openEditProgram } from '#lib/stores/dialogs.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';

	let program = $state<Program | null>(null);
	let error = $state('');
	let seq = 0;

	const id = $derived(page.params.id ?? '');
	const agent = $derived(program ? agentsStore.state.agents.find((a) => a.id === program?.agentId) : undefined);
	const badge = $derived(program ? programBadge(program) : null);

	async function load(): Promise<void> {
		const mine = ++seq;
		try {
			const p = await api.get('/programs/{id}', { params: { id } });
			if (mine !== seq) return;
			program = p;
			error = '';
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not load the program';
		}
	}

	onMount(() => {
		void agentsStore.load();
	});
	$effect(() => {
		void id;
		void live.state.revs.programs;
		void load();
	});
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title={program?.name ?? 'Program'} description="The standing order, its notes and its runs." breadcrumb={[{ label: 'Programs', href: '/programs' }]} backHref="/programs">
		{#if program}
			<Button size="sm" variant="outline" onclick={() => openEditProgram(program?.id ?? '')}><PencilSimpleIcon class="size-4" /> Edit</Button>
		{/if}
	</PageHeader>

	<PageBody size="wide">
		{#if error}
			<Empty.Root class="border border-dashed border-border">
				<Empty.Header><Empty.Title>Program not found</Empty.Title><Empty.Description>{error}</Empty.Description></Empty.Header>
				<Empty.Content><Button href="/programs" variant="outline">Back to programs</Button></Empty.Content>
			</Empty.Root>
		{:else if !program}
			<Skeleton class="h-24 w-full" />
			<Skeleton class="h-40 w-full" />
		{:else}
			<Surface class="flex flex-col gap-2 p-4 text-sm">
				<div class="flex flex-wrap items-center gap-2">
					{#if badge}<Badge variant={badge.variant}>{badge.label}</Badge>{/if}
					<span class="text-muted-foreground">{agent?.name ?? 'Unknown agent'}</span>
					<span class="flex-1"></span>
					{#if program.status === 'active'}
						<Button size="sm" variant="ghost" onclick={() => program && void programAction(program, 'pause')}><PauseIcon class="size-4" /> Pause</Button>
					{:else}
						<Button size="sm" variant="ghost" onclick={() => program && void programAction(program, 'resume')}><PlayIcon class="size-4" /> Activate</Button>
					{/if}
				</div>
				<p class="line-clamp-3 whitespace-pre-wrap">{program.brief}</p>
				{#if program.notes.length}
					<div class="text-xs" data-testid="program-notes-list">
						<p class="font-medium">Standing agreements</p>
						<ul class="list-disc pl-4 text-muted-foreground">
							{#each program.notes as note (note)}<li>{note}</li>{/each}
						</ul>
					</div>
				{/if}
				<p class="text-xs text-muted-foreground">Authority: {authoritySummary(program.authority)} · Budget: {budgetSummary(program.budget)}{program.deliverables.length ? ` · ${program.deliverables.length} deliverable${program.deliverables.length === 1 ? '' : 's'}` : ''}</p>
			</Surface>

			<ProgramMemory {program} />
		{/if}
	</PageBody>
</div>
