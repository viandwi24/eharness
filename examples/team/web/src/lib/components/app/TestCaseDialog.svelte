<script lang="ts">
	import { untrack } from 'svelte';
	import { api, fieldErrors } from '#lib/api/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import type { Program } from '#lib/programs/form.js';
	import {
		emptyExpectForm,
		emptySampleForm,
		expectFromForm,
		formFromExpect,
		formFromSample,
		sampleFromForm,
		type ExpectForm,
		type Rehearsal,
		type SampleForm,
		type TestCase,
		validateSampleForm
	} from '#lib/rehearsal/model.js';
	import ExpectFields from './ExpectFields.svelte';
	import SampleFields from './SampleFields.svelte';

	/**
	 * A test case of a program: sample data plus what the run must satisfy. Opened for a new case, to
	 * edit one, or with `from` (a finished rehearsal) to save its sample as a case.
	 */
	let {
		program,
		open = $bindable(false),
		edit,
		from,
		onSaved
	}: { program: Program; open?: boolean; edit?: TestCase | undefined; from?: Rehearsal | undefined; onSaved?: (c: TestCase) => void } = $props();

	let name = $state('');
	let sample = $state<SampleForm>(emptySampleForm());
	let expectForm = $state<ExpectForm>(emptyExpectForm());
	let errors = $state<Record<string, string>>({});
	let formError = $state('');
	let saving = $state(false);
	const worker = $derived(program.worker !== null);

	$effect(() => {
		if (!open) return;
		untrack(() => {
			name = edit?.name ?? (from ? `Test of ${new Date(from.startedAt).toLocaleDateString()}` : '');
			sample = edit ? formFromSample(edit.sample) : from ? formFromSample(from.sample) : emptySampleForm();
			expectForm = edit
				? formFromExpect(edit.expect)
				: { ...emptyExpectForm(), deliverablesPass: program.deliverables.length > 0, reportStatus: from?.report && from.report.status === 'done' ? 'done' : '' };
			errors = {};
			formError = '';
		});
	});

	async function submit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		errors = from ? {} : validateSampleForm(sample, worker);
		if (!name.trim()) errors.name = 'Give the test case a name.';
		formError = '';
		if (Object.keys(errors).length) return;
		saving = true;
		try {
			const expect = expectFromForm(expectForm);
			const saved = edit
				? await api.patch('/program-tests/{id}', { params: { id: edit.id }, body: { name: name.trim(), sample: sampleFromForm(sample, worker), expect } })
				: await api.post('/programs/{id}/tests', {
						params: { id: program.id },
						body: { name: name.trim(), expect, ...(from ? { rehearsalId: from.id } : { sample: sampleFromForm(sample, worker) }) }
					});
			toast.success(edit ? 'Test case saved' : 'Test case added');
			open = false;
			onSaved?.(saved);
		} catch (err) {
			errors = fieldErrors(err);
			formError = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content elevation="floating" class="flex max-h-[90svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
		<Dialog.Header class="border-b border-border px-5 py-4">
			<Dialog.Title>{edit ? 'Edit test case' : 'Save as a test case'}</Dialog.Title>
			<Dialog.Description>
				A test case is sample data plus what a good run looks like. Run all tests after you edit the program to see what the edit broke.
			</Dialog.Description>
		</Dialog.Header>
		<form id="test-case-form" class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4 text-sm" onsubmit={submit}>
			<label class="flex flex-col gap-1">
				<span class="font-medium">Name</span>
				<Input bind:value={name} placeholder="A quiet week" aria-invalid={!!errors.name} />
				{#if errors.name}<span class="text-xs text-destructive-text">{errors.name}</span>{/if}
			</label>
			{#if from}
				<p class="text-xs text-muted-foreground">The case uses the sample data of this test run ({from.sample.copy.length} copied path(s), {from.sample.files.length} attached file(s){from.sample.task ? `, task “${from.sample.task.title}”` : ''}).</p>
			{:else}
				<SampleFields bind:form={sample} {worker} {errors} />
			{/if}
			<ExpectFields bind:form={expectForm} />
			{#if formError && !Object.keys(errors).length}<p class="text-xs text-destructive-text" role="alert">{formError}</p>{/if}
		</form>
		<Dialog.Footer class="border-t border-border px-5 py-3">
			<Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
			<Button type="submit" form="test-case-form" disabled={saving}>{saving ? 'Saving…' : edit ? 'Save test case' : 'Add test case'}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
