<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import FlaskIcon from 'phosphor-svelte/lib/Flask';
	import PauseIcon from 'phosphor-svelte/lib/Pause';
	import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimple';
	import PlayIcon from 'phosphor-svelte/lib/Play';
	import { onMount } from 'svelte';
	import { api } from '#lib/api/index.js';
	import ConfirmDialog from '#lib/components/app/ConfirmDialog.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import ProgramRehearsals from '#lib/components/app/ProgramRehearsals.svelte';
	import ProgramTests from '#lib/components/app/ProgramTests.svelte';
	import RehearsalDialog from '#lib/components/app/RehearsalDialog.svelte';
	import Surface from '#lib/components/app/Surface.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { authoritySummary, budgetSummary, programBadge, type Program } from '#lib/programs/form.js';
	import { activationText, programAction } from '#lib/programs/actions.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { openEditProgram } from '#lib/stores/dialogs.svelte.js';
	import { live } from '#lib/stores/live.svelte.js';

	let program = $state<Program | null>(null);
	let error = $state('');
	let tab = $state('tests');
	let testRun = $state(false);
	let warning = $state<string | null>(null);
	let confirmActivate = $state(false);
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
		// the "Test run" button of the editor lands here with ?test=1
		if (page.url.searchParams.get('test') === '1') testRun = true;
	});
	$effect(() => {
		void id;
		void live.state.revs.programs;
		void load();
	});

	async function resume(): Promise<void> {
		if (!program) return;
		// failing test cases are a warning, never a block
		const text = await activationText(program);
		if (text !== null) {
			warning = text;
			confirmActivate = true;
			return;
		}
		await programAction(program, 'resume');
	}
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title={program?.name ?? 'Program'} description="Test runs and test cases of this program." breadcrumb={[{ label: 'Programs', href: '/programs' }]} backHref="/programs">
		{#if program}
			<Button size="sm" variant="outline" onclick={() => openEditProgram(program?.id ?? '')}><PencilSimpleIcon class="size-4" /> Edit</Button>
			<Button size="sm" onclick={() => (testRun = true)}><FlaskIcon class="size-4" /> Test run</Button>
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
						<Button size="sm" variant="ghost" onclick={() => void resume()}><PlayIcon class="size-4" /> Activate</Button>
					{/if}
				</div>
				<p class="line-clamp-3 whitespace-pre-wrap">{program.brief}</p>
				<p class="text-xs text-muted-foreground">Authority: {authoritySummary(program.authority)} · Budget: {budgetSummary(program.budget)}{program.deliverables.length ? ` · ${program.deliverables.length} deliverable${program.deliverables.length === 1 ? '' : 's'}` : ''}</p>
			</Surface>

			<Tabs.Root bind:value={tab} class="flex flex-col gap-3">
				<Tabs.List variant="line" class="h-10 shrink-0 gap-4 border-b border-border">
					<Tabs.Trigger value="tests">Tests</Tabs.Trigger>
					<Tabs.Trigger value="rehearsals">Test runs</Tabs.Trigger>
				</Tabs.List>
				<Tabs.Content value="tests"><ProgramTests {program} /></Tabs.Content>
				<Tabs.Content value="rehearsals"><ProgramRehearsals {program} /></Tabs.Content>
			</Tabs.Root>
		{/if}
	</PageBody>
</div>

{#if program}
	<RehearsalDialog {program} bind:open={testRun} />
	<ConfirmDialog
		bind:open={confirmActivate}
		title="Activate {program.name}?"
		description={warning ?? ''}
		confirmLabel="Activate anyway"
		confirmVariant="default"
		onConfirm={async () => {
			if (program) await programAction(program, 'resume');
		}}
	/>
{/if}
