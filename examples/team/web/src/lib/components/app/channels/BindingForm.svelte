<script lang="ts">
	import { untrack } from 'svelte';
	import { api } from '#lib/api/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { agentChoices, isAccount, type ChannelConnection } from '#lib/channels/model.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';

	// Choose the agent that answers on a connection. Binding starts the transport; changing the
	// agent keeps every other setting of the connection.
	let { conn, onChange }: { conn: ChannelConnection; onChange: () => void } = $props();

	let agentId = $state(untrack(() => conn.binding?.agentId ?? ''));
	let busy = $state(false);
	const agents = $derived(agentChoices(agentsStore.state.agents));
	const bound = $derived(conn.binding !== null);
	const account = $derived(isAccount(conn));
	// keep the chooser on the saved binding unless the person is changing it
	$effect(() => {
		const saved = conn.binding?.agentId ?? '';
		untrack(() => {
			if (!agents.some((a) => a.id === agentId) || agentId === '') agentId = saved;
		});
	});

	async function bind(): Promise<void> {
		busy = true;
		try {
			await api.put('/channels/connections/{id}/binding', { params: { id: conn.id }, body: { agentId } });
			toast.success(bound ? 'Agent changed' : account ? 'Account bound: starting' : 'Bound: polling started');
			onChange();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not bind');
		} finally {
			busy = false;
		}
	}
</script>

<div class="flex flex-wrap items-end gap-2" data-testid="binding">
	<label class="flex min-w-48 flex-1 flex-col gap-1">
		<span class="text-xs font-medium">{account ? 'Agent that owns this account' : 'Agent that answers on this bot'}</span>
		<NativeSelect bind:value={agentId} aria-label="Agent" disabled={busy}>
			<NativeSelectOption value="" disabled>Choose an agent…</NativeSelectOption>
			{#each agents as a (a.id)}<NativeSelectOption value={a.id}>{a.name}</NativeSelectOption>{/each}
		</NativeSelect>
	</label>
	<Button size="sm" onclick={() => void bind()} disabled={busy || agentId === '' || agentId === conn.binding?.agentId} data-testid="bind">{bound ? 'Change agent' : 'Bind and start'}</Button>
</div>
