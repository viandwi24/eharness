<script lang="ts">
	import { page } from '$app/state';
	import ChatPane from '#lib/components/app/ChatPane.svelte';
	import { PANEL_OPEN_KEY, readPref, writePref } from '#lib/stores/prefs.js';

	const agentId = $derived(page.params.agentId ?? '');
	// `?t=` names the chat thread (its id or session id); without it the newest one opens
	const threadParam = $derived(page.url.searchParams.get('t'));
	let innerWidth = $state(1280);
	let panelOpen = $state(readPref(PANEL_OPEN_KEY) !== '0'); // desktop: second column, remembered
	let popoverOpen = $state(false); // below lg: popover on the header button
	// a column only where the chat keeps a readable width next to the rail, the agent list and the 352px panel
	const wide = $derived(innerWidth >= 1200);
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

<ChatPane {agentId} {threadParam} panelOpen={open} {wide} bind:popoverOpen onTogglePanel={toggle} />
