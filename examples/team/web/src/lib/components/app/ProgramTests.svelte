<script lang="ts">
	import FlaskIcon from 'phosphor-svelte/lib/Flask';
	import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimple';
	import PlayIcon from 'phosphor-svelte/lib/Play';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import { onDestroy } from 'svelte';
	import { api } from '#lib/api/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import type { Program } from '#lib/programs/form.js';
	import { expectLines, summaryText, testBadge, type TestCase, type TestSummary } from '#lib/rehearsal/model.js';

	type CaseView = TestCase & { stale: boolean };
	import ConfirmDialog from './ConfirmDialog.svelte';
	import Surface from './Surface.svelte';
	import TestCaseDialog from './TestCaseDialog.svelte';

	/** The saved test cases of a program: run all of them after an edit and see pass or fail for each. */
	let { program, onChange }: { program: Program; onChange?: (() => void) | undefined } = $props();

	let cases = $state<CaseView[] | null>(null);
	let summary = $state<TestSummary | null>(null);
	let error = $state('');
	let running = $state(false);
	let editing = $state<TestCase | undefined>(undefined);
	let dialog = $state(false);
	let removing = $state<TestCase | undefined>(undefined);
	let confirmRemove = $state(false);
	let seq = 0;

	async function load(): Promise<void> {
		const mine = ++seq;
		try {
			const r = await api.get('/programs/{id}/tests', { params: { id: program.id } });
			if (mine !== seq) return;
			cases = r.cases;
			summary = r.summary;
			error = '';
			onChange?.();
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not load the test cases';
		}
	}

	// reload when the program changes (an edit makes results stale); poll while cases run
	$effect(() => {
		void program.id;
		void program.updatedAt; // an edit (or a pause) may have made results stale
		void load();
	});
	const timer = setInterval(() => {
		if (summary !== null && summary.running > 0) void load();
	}, 1500);
	onDestroy(() => clearInterval(timer));

	async function run(caseId?: string): Promise<void> {
		running = true;
		try {
			await api.post('/programs/{id}/tests/run', { params: { id: program.id }, body: caseId ? { caseId } : {} });
			await load();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not run the tests');
		} finally {
			running = false;
		}
	}

	async function remove(): Promise<void> {
		if (!removing) return;
		try {
			await api.delete('/program-tests/{id}', { params: { id: removing.id } });
			await load();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not delete the test case');
		}
	}
</script>

<section class="flex flex-col gap-3" data-testid="program-tests">
	<div class="flex flex-wrap items-center gap-2">
		<p class="flex-1 text-sm text-muted-foreground">{summary ? summaryText(summary) : ''}</p>
		<Button size="sm" variant="outline" onclick={() => { editing = undefined; dialog = true; }}><PlusIcon class="size-4" /> Add test case</Button>
		<Button size="sm" disabled={running || !cases?.length || (summary?.running ?? 0) > 0} onclick={() => void run()}><PlayIcon class="size-4" /> Run all tests</Button>
	</div>

	{#if error}
		<p class="text-sm text-destructive-text" role="alert">{error}</p>
	{:else if cases === null}
		<Skeleton class="h-16 w-full" />
	{:else if cases.length === 0}
		<Empty.Root class="border border-dashed border-border">
			<Empty.Header>
				<Empty.Media variant="icon"><FlaskIcon /></Empty.Media>
				<Empty.Title>No test cases yet</Empty.Title>
				<Empty.Description>Do a test run you are happy with and save it as a test case. Then every edit of the program can be checked against it with one click.</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<ul class="flex flex-col gap-2">
			{#each cases as c (c.id)}
				{@const b = testBadge(c.lastResult, c.stale)}
				<li>
					<Surface class="flex flex-col gap-1.5 p-3 text-sm" data-testid="test-case">
						<div class="flex flex-wrap items-center gap-2">
							<span class="font-medium">{c.name}</span>
							<Badge variant={b.variant}>{b.label}</Badge>
							<span class="flex-1"></span>
							{#if c.lastResult?.rehearsalId}
								<a class="text-xs text-info-text underline underline-offset-4" href="/programs/{program.id}/rehearsals/{c.lastResult.rehearsalId}">Last run</a>
							{/if}
							<Button size="icon-sm" variant="ghost" aria-label="Run {c.name}" disabled={running || c.lastResult?.status === 'running'} onclick={() => void run(c.id)}><PlayIcon class="size-4" /></Button>
							<Button size="icon-sm" variant="ghost" aria-label="Edit {c.name}" onclick={() => { editing = c; dialog = true; }}><PencilSimpleIcon class="size-4" /></Button>
							<Button size="icon-sm" variant="ghost" aria-label="Delete {c.name}" onclick={() => { removing = c; confirmRemove = true; }}><TrashIcon class="size-4" /></Button>
						</div>
						<ul class="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
							{#each expectLines(c.expect) as line (line)}<li class="rounded bg-muted px-1.5 py-0.5">{line}</li>{/each}
						</ul>
						{#if c.lastResult && c.lastResult.status !== 'pass' && c.lastResult.failures.length}
							<ul class="ml-4 list-disc text-xs text-destructive-text">{#each c.lastResult.failures as f (f)}<li>{f}</li>{/each}</ul>
						{/if}
					</Surface>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<TestCaseDialog {program} bind:open={dialog} edit={editing} onSaved={() => void load()} />
{#if removing}
	<ConfirmDialog bind:open={confirmRemove} title="Delete test case {removing.name}?" description="The case is removed. The test runs it already made stay in the history." onConfirm={remove} />
{/if}
