<script lang="ts">
	import ChatsIcon from 'phosphor-svelte/lib/ChatsCircle';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { openNewAgent } from '#lib/stores/dialogs.svelte.js';

	const lead = $derived(agentsStore.state.agents.find((a) => a.role === 'lead'));
</script>

<div class="flex flex-1 items-center justify-center p-6">
	<Empty.Root class="max-w-md border-0">
		<Empty.Header>
			<Empty.Media variant="icon"><ChatsIcon /></Empty.Media>
			<Empty.Title>Pick an agent</Empty.Title>
			<Empty.Description>Choose someone from the sidebar to start a conversation, or create a new agent.</Empty.Description>
		</Empty.Header>
		<Empty.Content class="flex-row justify-center">
			{#if lead}<Button href="/a/{lead.id}" variant="outline">Open {lead.name}</Button>{/if}
			<Button onclick={openNewAgent}><PlusIcon class="size-4" /> New agent</Button>
		</Empty.Content>
	</Empty.Root>
</div>
