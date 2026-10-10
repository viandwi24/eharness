<script lang="ts">
	import type { Snippet } from 'svelte';

	/** The action bar every connect step ends with: a muted strip across the dialog, actions on the right. */
	let { children, class: className = '' }: { children: Snippet; class?: string } = $props();
</script>

<div class="-mx-5 mt-1 -mb-4 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3 {className}">
	{@render children()}
</div>
