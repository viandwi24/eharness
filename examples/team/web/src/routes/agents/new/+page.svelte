<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { openNewAgent } from '#lib/stores/dialogs.svelte.js';

	// Old deep link: the form is a dialog now.
	onMount(() => {
		// Open the dialog after the redirect landed: opened first, the navigation left it stuck "open"
		// without showing, and every New agent button stayed dead until a reload.
		void goto('/', { replaceState: true }).then(() => openNewAgent());
	});
</script>
