<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { decide } from '#lib/decisions/actions.js';
	import { type Decision, editBody } from '#lib/decisions/model.js';
	import type { ProgramForm } from '#lib/programs/form.js';
	import { live } from '#lib/stores/live.svelte.js';
	import ProgramEditor from './ProgramEditor.svelte';

	type Proposal = Extract<Decision, { kind: 'proposal' }>;
	let { decision = $bindable(null) }: { decision: Proposal | null } = $props();

	const FORM_ID = 'decision-edit-form';
	let valid = $state(false);
	let saving = $state(false);
	let runOnce = $state(false);
	let error = $state('');
	$effect(() => {
		if (decision) runOnce = decision.payload.runOnce;
	});

	async function apply(form: ProgramForm): Promise<void> {
		if (!decision) return;
		saving = true;
		error = '';
		try {
			await decide(decision.id, 'approve', { edit: editBody(form, runOnce) });
			toast.success('Approved with your changes');
			decision = null;
			await live.loadDecisions();
			live.state.revs.decisions++;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not approve';
		} finally {
			saving = false;
		}
	}
</script>

<Dialog.Root open={decision !== null} onOpenChange={(o) => { if (!o) decision = null; }}>
	<Dialog.Content elevation="floating" class="flex max-h-[90svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
		<Dialog.Header class="border-b border-border px-5 py-4">
			<Dialog.Title>Edit and approve</Dialog.Title>
			<Dialog.Description>Change what the program may do, then approve. It is created with exactly this authority and nothing else.</Dialog.Description>
		</Dialog.Header>
		<div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
			{#if decision}
				{#key decision.id}
					<label class="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm">
						<span>
							<span class="block font-medium">Run it once, right now</span>
							<span class="text-xs text-muted-foreground">A one-off plan: created with no schedule and started when you approve. Off: a standing program as configured below.</span>
						</span>
						<Switch bind:checked={runOnce} aria-label="Run once" />
					</label>
					<ProgramEditor proposed={decision.payload.program} formId={FORM_ID} bind:valid onApply={(f) => void apply(f)} />
					{#if error}<p class="text-xs text-destructive-text" role="alert">{error}</p>{/if}
				{/key}
			{/if}
		</div>
		<Dialog.Footer class="border-t border-border px-5 py-3">
			<Button type="button" variant="ghost" onclick={() => (decision = null)}>Cancel</Button>
			<Button type="submit" form={FORM_ID} disabled={saving || !valid}>{saving ? 'Approving…' : 'Approve'}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
