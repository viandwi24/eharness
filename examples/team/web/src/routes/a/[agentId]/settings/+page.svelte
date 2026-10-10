<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { agentsStore } from '#lib/stores/agents.svelte.js';
	import { openEditAgent } from '#lib/stores/dialogs.svelte.js';

	// Deep links keep working: settings now live in the agent dialog over the chat.
	const idOrSlug = $derived(page.params.agentId ?? '');
	let done = false;
	$effect(() => {
		if (done) return;
		done = true;
		const id = agentsStore.find(idOrSlug)?.id ?? idOrSlug;
		void goto(`/a/${idOrSlug}`, { replaceState: true }).then(() => openEditAgent(id));
	});
</script>

<div class="flex min-w-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">Opening agent settings…</div>
