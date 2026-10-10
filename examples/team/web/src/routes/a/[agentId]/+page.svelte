<script lang="ts">
	import { page } from '$app/state';
	import ChatPane from '#lib/components/app/ChatPane.svelte';
	import ContextPanel from '#lib/components/app/ContextPanel.svelte';
	import * as Sheet from '#lib/components/ui/sheet/index.js';

	const agentId = $derived(page.params.agentId ?? '');
	let innerWidth = $state(1280);
	let panelOpen = $state(true); // desktop: inline column
	let sheetOpen = $state(false); // below lg: sheet
	const wide = $derived(innerWidth >= 1024);

	function toggle() {
		if (wide) panelOpen = !panelOpen;
		else sheetOpen = !sheetOpen;
	}
</script>

<svelte:window bind:innerWidth />

<ChatPane {agentId} onTogglePanel={toggle} />

{#if wide && panelOpen}
	<aside class="h-full w-80 shrink-0 border-l border-border bg-background">
		<ContextPanel {agentId} />
	</aside>
{/if}

<Sheet.Root bind:open={sheetOpen}>
	<Sheet.Content side="right" class="w-80 p-0">
		<Sheet.Header class="sr-only"><Sheet.Title>Agent context</Sheet.Title></Sheet.Header>
		<ContextPanel {agentId} />
	</Sheet.Content>
</Sheet.Root>
