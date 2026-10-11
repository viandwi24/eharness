<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { api, fieldErrors } from '#lib/api/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import type { Program } from '#lib/programs/form.js';
	import { emptySampleForm, formFromSample, parseBudget, sampleFromForm, type RehearsalSample, type SampleForm, validateSampleForm } from '#lib/rehearsal/model.js';
	import SampleFields from './SampleFields.svelte';

	/** The "Test run" dialog of a program: pick sample data, start a rehearsal, land on its result. */
	let { program, open = $bindable(false), initial }: { program: Program; open?: boolean; initial?: RehearsalSample | undefined } = $props();

	let form = $state<SampleForm>(emptySampleForm());
	let budget = $state('');
	let errors = $state<Record<string, string>>({});
	let formError = $state('');
	let starting = $state(false);
	const worker = $derived(program.worker !== null);

	$effect(() => {
		if (!open) return;
		untrack(() => {
			form = initial ? formFromSample(initial) : emptySampleForm();
			budget = '';
			errors = {};
			formError = '';
		});
	});

	async function submit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		errors = validateSampleForm(form, worker);
		formError = '';
		const cap = parseBudget(budget);
		if (cap === null) errors.budget = 'The cap is an amount above 0 and at most 5 USD.';
		if (Object.keys(errors).length || cap === null) return;
		starting = true;
		try {
			const r = await api.post('/programs/{id}/rehearsals', {
				params: { id: program.id },
				body: { sample: sampleFromForm(form, worker), ...(cap === undefined ? {} : { budgetUsd: cap }) }
			});
			open = false;
			await goto(`/programs/${program.id}/rehearsals/${r.id}`);
		} catch (err) {
			errors = fieldErrors(err);
			formError = err instanceof Error ? err.message : String(err);
			if (!Object.keys(errors).length) toast.error(formError);
		} finally {
			starting = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content elevation="floating" class="flex max-h-[90svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
		<Dialog.Header class="border-b border-border px-5 py-4">
			<Dialog.Title>Test run: {program.name}</Dialog.Title>
			<Dialog.Description>
				Runs the program as saved, on sample data, in a safe mode: files go to a scratch area (your library is not changed), calls to outside systems that would change something are simulated, and decisions it would ask for are only listed.
			</Dialog.Description>
		</Dialog.Header>
		<form id="rehearsal-form" class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4 text-sm" onsubmit={submit}>
			<SampleFields bind:form {worker} {errors} />
			<label class="flex flex-col gap-1 sm:w-64">
				<span class="font-medium">Spend cap (USD)</span>
				<Input bind:value={budget} inputmode="decimal" placeholder="0.50" aria-invalid={!!errors.budget} />
				{#if errors.budget}<span class="text-xs text-destructive-text">{errors.budget}</span>{:else}<span class="text-xs text-muted-foreground">A test run has a small cap of its own (default 0.50, at most 5). It does not count toward the program's budget.</span>{/if}
			</label>
			{#if formError && !Object.keys(errors).length}<p class="text-xs text-destructive-text" role="alert">{formError}</p>{/if}
		</form>
		<Dialog.Footer class="border-t border-border px-5 py-3">
			<Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
			<Button type="submit" form="rehearsal-form" disabled={starting}>{starting ? 'Starting…' : 'Start test run'}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
