<script lang="ts">
	import { untrack } from 'svelte';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import { api } from '#lib/api/index.js';
	import type { components } from '#lib/api/schema.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { live } from '#lib/stores/live.svelte.js';
	import { closeRoutineDialog, routineDialog } from '#lib/stores/dialogs.svelte.js';
	import RoutineEditor from './RoutineEditor.svelte';
	import RoutineRuns from './RoutineRuns.svelte';

	type Routine = components['schemas']['Routine'];
	const FORM_ID = 'routine-dialog-form';

	let routine = $state<Routine | undefined>(undefined);
	let loadError = $state('');
	let saving = $state(false);
	let valid = $state(false);
	let session = $state(0);

	const editing = $derived(routineDialog.routineId !== null);

	$effect(() => {
		if (!routineDialog.open) return;
		untrack(() => session++); // reading it here would re-run this effect forever
		routine = undefined;
		loadError = '';
		const id = routineDialog.routineId;
		if (!id) return;
		let stale = false;
		api.get('/routines').then(
			(r) => {
				if (stale) return;
				routine = r.routines.find((x) => x.id === id);
				if (!routine) loadError = 'This routine no longer exists.';
			},
			(e) => {
				if (!stale) loadError = e instanceof Error ? e.message : 'Could not load the routine';
			}
		);
		return () => {
			stale = true;
		};
	});

	async function remove(): Promise<void> {
		if (!routine || !confirm(`Delete routine "${routine.name}"? Its run history is removed too.`)) return;
		try {
			await api.delete('/routines/{id}', { params: { id: routine.id } });
			live.state.revs.routines++;
			closeRoutineDialog();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not delete the routine');
		}
	}
</script>

<Dialog.Root bind:open={routineDialog.open}>
	<Dialog.Content class="flex max-h-[90svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
		<Dialog.Header class="border-b border-border px-5 py-4">
			<Dialog.Title>{editing ? 'Edit routine' : 'New routine'}</Dialog.Title>
			<Dialog.Description>The agent runs the prompt on a schedule, with a fresh context each time plus its memory.</Dialog.Description>
		</Dialog.Header>
		<div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
			{#if editing && !routine}
				{#if loadError}
					<p class="text-sm text-destructive-text" role="alert">{loadError}</p>
				{:else}
					<div class="flex items-center gap-2 text-sm text-muted-foreground"><Spinner class="size-4" /> Loading…</div>
				{/if}
			{:else}
				{#key session}
					<RoutineEditor
						agentId={routineDialog.agentId ?? ''}
						{routine}
						formId={FORM_ID}
						bind:saving
						bind:valid
						onSaved={() => {
							live.state.revs.routines++;
							closeRoutineDialog();
						}}
					/>
				{/key}
				{#if routine}<RoutineRuns {routine} />{/if}
			{/if}
		</div>
		<Dialog.Footer class="border-t border-border px-5 py-3 sm:justify-between">
			{#if routine}
				<Button type="button" variant="ghost" class="text-destructive-text" onclick={() => void remove()}>
					<TrashIcon class="size-4" /> Delete
				</Button>
			{:else}
				<span></span>
			{/if}
			<div class="flex flex-col-reverse gap-2 sm:flex-row">
				<Button type="button" variant="ghost" onclick={closeRoutineDialog}>Cancel</Button>
				<Button type="submit" form={FORM_ID} disabled={saving || !valid || (editing && !routine)}>
					{saving ? 'Saving…' : editing ? 'Save routine' : 'Create routine'}
				</Button>
			</div>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
