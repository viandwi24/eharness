<script lang="ts">
	import type { Snippet } from 'svelte';
	import { shell } from '#lib/stores/shell.svelte.js';

	/** Puts the page header on the shell of the layout's inset panel (above the content plate). */
	let { children }: { children: Snippet } = $props();

	$effect(() => {
		const mine = children;
		shell.header = mine;
		return () => {
			if (shell.header === mine) shell.header = null;
		};
	});
</script>
