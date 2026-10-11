<script lang="ts">
	import ConfirmDialog from './ConfirmDialog.svelte';
	import { untrack } from 'svelte';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import { api } from '#lib/api/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import type { Program } from '#lib/programs/form.js';
	import { live } from '#lib/stores/live.svelte.js';
	import { closeProgramDialog, programDialog } from '#lib/stores/dialogs.svelte.js';
	import ProgramEditor from './ProgramEditor.svelte';
	import ProgramRuns from './ProgramRuns.svelte';

	const FORM_ID = 'program-dialog-form';

	let program = $state<Program | undefined>(undefined);
	let loadError = $state('');
	let saving = $state(false);
	let valid = $state(false);
	let session = $state(0);

	const editing = $derived(programDialog.programId !== null);

	$effect(() => {
		if (!programDialog.open) return;
		untrack(() => session++); // reading it here would re-run this effect forever
		program = undefined;
		loadError = '';
		const id = programDialog.programId;
		if (!id) return;
		let stale = false;
		api.get('/programs/{id}', { params: { id } }).then(
			(p) => {
				if (!stale) program = p;
			},
			(e) => {
				if (!stale) loadError = e instanceof Error ? e.message : 'Could not load the program';
			}
		);
		return () => {
			stale = true;
		};
	});

	let confirmDelete = $state(false);
	async function remove(): Promise<void> {
		if (!program) return;
		try {
			await api.delete('/programs/{id}', { params: { id: program.id } });
			live.state.revs.programs++;
			closeProgramDialog();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not delete the program');
		}
	}
</script>

<Dialog.Root bind:open={programDialog.open}>
	<Dialog.Content elevation="floating" class="flex max-h-[90svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
		<Dialog.Header class="border-b border-border px-5 py-4">
			<Dialog.Title>{editing ? 'Edit program' : 'New program'}</Dialog.Title>
			<Dialog.Description>
				A standing order: the agent does this on its own, inside the authority you grant, and reports when it is done. A run already going keeps the authority it started with.
			</Dialog.Description>
		</Dialog.Header>
		<div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
			{#if editing && !program}
				{#if loadError}
					<p class="text-sm text-destructive-text" role="alert">{loadError}</p>
				{:else}
					<div class="flex items-center gap-2 text-sm text-muted-foreground"><Spinner class="size-4" /> Loading…</div>
				{/if}
			{:else}
				{#key session}
					<ProgramEditor
						agentId={programDialog.agentId ?? ''}
						{program}
						formId={FORM_ID}
						bind:saving
						bind:valid
						onSaved={() => {
							live.state.revs.programs++;
							closeProgramDialog();
						}}
					/>
				{/key}
				{#if program}<ProgramRuns {program} />{/if}
			{/if}
		</div>
		<Dialog.Footer class="border-t border-border px-5 py-3 sm:justify-between">
			{#if program}
				<Button type="button" variant="ghost" class="text-destructive-text" onclick={() => (confirmDelete = true)}>
					<TrashIcon class="size-4" /> Delete
				</Button>
			{:else}
				<span></span>
			{/if}
			<div class="flex flex-col-reverse gap-2 sm:flex-row">
				<Button type="button" variant="ghost" onclick={closeProgramDialog}>Cancel</Button>
				<Button type="submit" form={FORM_ID} disabled={saving || !valid || (editing && !program)}>
					{saving ? 'Saving…' : editing ? 'Save program' : 'Create program'}
				</Button>
			</div>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

{#if program}
	<ConfirmDialog bind:open={confirmDelete} title="Delete program {program.name}?" description="Its schedule is removed. The tasks of its past runs stay on the board." onConfirm={remove} />
{/if}
