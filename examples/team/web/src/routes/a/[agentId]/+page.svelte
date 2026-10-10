<script lang="ts">
	import { page } from '$app/state';
	import ChatPane from '#lib/components/app/ChatPane.svelte';
	import ContextPanel from '#lib/components/app/ContextPanel.svelte';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { PANEL_OPEN_KEY, readPref, writePref } from '#lib/stores/prefs.js';

	const agentId = $derived(page.params.agentId ?? '');
	let innerWidth = $state(1280);
	let panelOpen = $state(readPref(PANEL_OPEN_KEY) !== '0'); // desktop: inline column, remembered
	let sheetOpen = $state(false); // below lg: sheet
	const wide = $derived(innerWidth >= 1024);
	const open = $derived(wide ? panelOpen : sheetOpen);

	function toggle(): void {
		if (wide) {
			panelOpen = !panelOpen;
			writePref(PANEL_OPEN_KEY, panelOpen ? '1' : '0');
		} else sheetOpen = !sheetOpen;
	}

	// Cmd/Ctrl + . toggles the details panel from anywhere on the page.
	function onkeydown(e: KeyboardEvent): void {
		if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === '.') {
			e.preventDefault();
			toggle();
		}
	}
</script>

<svelte:window bind:innerWidth {onkeydown} />

<ChatPane {agentId} panelOpen={open} onTogglePanel={toggle} />

{#if wide && panelOpen}
	<aside class="h-full w-80 shrink-0 border-l border-border bg-background" aria-label="Agent details">
		<ContextPanel {agentId} />
	</aside>
{/if}

<Sheet.Root bind:open={sheetOpen}>
	<Sheet.Content side="right" class="w-[min(92vw,22rem)] gap-0 p-0" showCloseButton={false}>
		<Sheet.Header class="sr-only"><Sheet.Title>Agent details</Sheet.Title></Sheet.Header>
		<ContextPanel {agentId} onClose={() => (sheetOpen = false)} />
	</Sheet.Content>
</Sheet.Root>
