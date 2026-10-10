<script lang="ts">
	import { page } from '$app/state';
	import ChatPane from '#lib/components/app/ChatPane.svelte';
	import { PANEL_OPEN_KEY, readPref, writePref } from '#lib/stores/prefs.js';

	const agentId = $derived(page.params.agentId ?? '');
	let innerWidth = $state(1280);
	let panelOpen = $state(readPref(PANEL_OPEN_KEY) !== '0'); // desktop: second column, remembered
	let popoverOpen = $state(false); // below lg: popover on the header button
	const wide = $derived(innerWidth >= 1024);
	const open = $derived(wide ? panelOpen : popoverOpen);

	function toggle(): void {
		if (wide) {
			panelOpen = !panelOpen;
			writePref(PANEL_OPEN_KEY, panelOpen ? '1' : '0');
		} else popoverOpen = !popoverOpen;
	}

	// Cmd/Ctrl + . toggles the session panel from anywhere on the page.
	function onkeydown(e: KeyboardEvent): void {
		if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === '.') {
			e.preventDefault();
			toggle();
		}
	}
</script>

<svelte:window bind:innerWidth {onkeydown} />

<ChatPane {agentId} panelOpen={open} {wide} bind:popoverOpen onTogglePanel={toggle} />
