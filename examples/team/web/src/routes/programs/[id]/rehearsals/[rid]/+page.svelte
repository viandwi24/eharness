<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import FlaskIcon from 'phosphor-svelte/lib/Flask';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import { onDestroy } from 'svelte';
	import { api } from '#lib/api/index.js';
	import ConfirmDialog from '#lib/components/app/ConfirmDialog.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import RehearsalDialog from '#lib/components/app/RehearsalDialog.svelte';
	import RehearsalResult from '#lib/components/app/RehearsalResult.svelte';
	import TestCaseDialog from '#lib/components/app/TestCaseDialog.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import type { Program } from '#lib/programs/form.js';
	import { isFinished, type Rehearsal } from '#lib/rehearsal/model.js';

	let rehearsal = $state<Rehearsal | null>(null);
	let program = $state<Program | null>(null);
	let error = $state('');
	let again = $state(false);
	let saveCase = $state(false);
	let confirmDelete = $state(false);
	let seq = 0;

	const programId = $derived(page.params.id ?? '');
	const rid = $derived(page.params.rid ?? '');

	async function load(): Promise<void> {
		const mine = ++seq;
		try {
			const r = await api.get('/rehearsals/{id}', { params: { id: rid } });
			if (mine !== seq) return;
			rehearsal = r;
			error = '';
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not load the test run';
		}
	}
	$effect(() => {
		void rid;
		void load();
		api.get('/programs/{id}', { params: { id: programId } }).then((p) => (program = p), () => undefined);
	});
	// a running rehearsal grows: simulated actions and would-ask decisions show up as they happen
	const timer = setInterval(() => {
		if (rehearsal === null || !isFinished(rehearsal)) void load();
	}, 1500);
	onDestroy(() => clearInterval(timer));

	async function remove(): Promise<void> {
		try {
			await api.delete('/rehearsals/{id}', { params: { id: rid } });
			await goto(`/programs/${programId}`);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not delete the test run');
		}
	}
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader
		title="Test run"
		description={program ? program.name : 'Result of a test run on sample data.'}
		breadcrumb={[{ label: 'Programs', href: '/programs' }, { label: program?.name ?? 'Program', href: `/programs/${programId}` }]}
		backHref={`/programs/${programId}`}
	>
		{#if rehearsal && program}
			<Button size="sm" variant="ghost" aria-label="Delete this test run" disabled={!isFinished(rehearsal)} onclick={() => (confirmDelete = true)}><TrashIcon class="size-4" /></Button>
			<Button size="sm" variant="outline" disabled={!isFinished(rehearsal)} onclick={() => (saveCase = true)}>Save as test case</Button>
			<Button size="sm" onclick={() => (again = true)}><FlaskIcon class="size-4" /> Run again</Button>
		{/if}
	</PageHeader>

	<PageBody size="narrow">
		{#if error}
			<Empty.Root class="border border-dashed border-border">
				<Empty.Header><Empty.Title>Test run not found</Empty.Title><Empty.Description>{error}</Empty.Description></Empty.Header>
				<Empty.Content><Button href="/programs/{programId}" variant="outline">Back to the program</Button></Empty.Content>
			</Empty.Root>
		{:else if !rehearsal}
			<Skeleton class="h-24 w-full" />
			<Skeleton class="h-40 w-full" />
		{:else}
			<RehearsalResult {rehearsal} program={program ?? undefined} />
		{/if}
	</PageBody>
</div>

{#if rehearsal && program}
	<RehearsalDialog {program} bind:open={again} initial={rehearsal.sample} />
	<TestCaseDialog {program} bind:open={saveCase} from={rehearsal} onSaved={() => void goto(`/programs/${programId}`)} />
	<ConfirmDialog bind:open={confirmDelete} title="Delete this test run?" description="The result and its files are removed." onConfirm={remove} />
{/if}
