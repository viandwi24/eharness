<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { openNewAgent } from '#lib/stores/dialogs.svelte.js';

	// Old deep link: the form is a dialog now.
	onMount(() => {
		openNewAgent();
		void goto('/', { replaceState: true });
	});
</script>
