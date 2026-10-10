<script lang="ts">
	import { page } from '$app/state';
	import AgentEditor from '#lib/components/app/AgentEditor.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import { agentsStore } from '#lib/stores/agents.svelte.js';

	const idOrSlug = $derived(page.params.agentId ?? '');
	const agent = $derived(agentsStore.find(idOrSlug));
	let error = $state('');

	$effect(() => {
		if (!agentsStore.find(idOrSlug)) {
			agentsStore.get(idOrSlug).catch((e: unknown) => (error = e instanceof Error ? e.message : String(e)));
		}
	});
</script>

<div class="flex min-w-0 flex-1 flex-col overflow-y-auto">
	<PageHeader title={agent ? `${agent.name} settings` : 'Agent settings'} />
	{#if agent}
		{#key agent.id}
			<AgentEditor {agent} />
		{/key}
	{:else}
		<p class="p-4 text-sm text-muted-foreground">{error || 'Loading…'}</p>
	{/if}
</div>
