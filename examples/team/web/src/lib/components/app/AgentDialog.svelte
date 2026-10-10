<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { untrack } from 'svelte';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import type { Agent } from '#lib/api/index.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { agentDialog, closeAgentDialog } from '#lib/stores/dialogs.svelte.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import AgentEditor from './AgentEditor.svelte';
	import MemoryEditor from './MemoryEditor.svelte';

	const FORM_ID = 'agent-dialog-form';

	let agent = $state<Agent | undefined>(undefined);
	let loadError = $state('');
	let saving = $state(false);
	let valid = $state(false);
	// Bumped on every open so the editor remounts with fresh form state.
	let session = $state(0);
	let tab = $state<'settings' | 'memory'>('settings');

	const editing = $derived(agentDialog.mode === 'edit');

	$effect(() => {
		if (!agentDialog.open) return;
		untrack(() => session++); // reading it here would re-run this effect forever
		tab = agentDialog.mode === 'edit' ? agentDialog.tab : 'settings';
		agent = undefined;
		loadError = '';
		const id = agentDialog.agentId;
		if (agentDialog.mode !== 'edit' || !id) return;
		let stale = false;
		agentsStore.get(id).then(
			(a) => {
				if (!stale) agent = a;
			},
			(e) => {
				if (!stale) loadError = e instanceof Error ? e.message : 'Could not load the agent';
			}
		);
		return () => {
			stale = true;
		};
	});
</script>

<Dialog.Root bind:open={agentDialog.open}>
	<Dialog.Content class="flex max-h-[90svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
		<Dialog.Header class="border-b border-border px-5 py-4">
			<Dialog.Title>{editing ? 'Edit agent' : 'New agent'}</Dialog.Title>
			<Dialog.Description>
				{editing ? 'Change how this agent looks, thinks and what it can use.' : 'Give it a name and instructions. You can change everything later.'}
			</Dialog.Description>
		</Dialog.Header>
		<Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col gap-0">
			{#if editing}
				<Tabs.List variant="line" class="h-10 shrink-0 gap-4 border-b border-border px-5">
					<Tabs.Trigger value="settings">Settings</Tabs.Trigger>
					<Tabs.Trigger value="memory">Memory</Tabs.Trigger>
				</Tabs.List>
			{/if}
			<!-- Both panes stay mounted (the form keeps its edits while the memory tab is open). -->
			<div class="min-h-0 flex-1 overflow-y-auto px-5 py-4" hidden={editing && tab !== 'settings'}>
				{#if editing && !agent}
					{#if loadError}
						<p class="text-sm text-destructive-text" role="alert">{loadError}</p>
					{:else}
						<div class="flex items-center gap-2 text-sm text-muted-foreground"><Spinner class="size-4" /> Loading…</div>
					{/if}
				{:else}
					{#key session}
						<AgentEditor {agent} bare formId={FORM_ID} bind:saving bind:valid onDone={() => closeAgentDialog()} />
					{/key}
				{/if}
			</div>
			{#if editing && agent}
				<div class="min-h-0 flex-1 overflow-y-auto px-5 py-4" hidden={tab !== 'memory'}>
					{#key session}
						<MemoryEditor scope="agent" agentId={agent.id} compact />
					{/key}
				</div>
			{/if}
		</Tabs.Root>
		<Dialog.Footer class="border-t border-border px-5 py-3">
			<Button type="button" variant="ghost" onclick={closeAgentDialog}>{editing && tab === 'memory' ? 'Close' : 'Cancel'}</Button>
			<Button type="submit" form={FORM_ID} disabled={saving || !valid || (editing && !agent)} class={editing && tab === 'memory' ? 'hidden' : ''}>
				{saving ? 'Saving…' : editing ? 'Save changes' : 'Create agent'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
