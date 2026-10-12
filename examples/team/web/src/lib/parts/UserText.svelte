<script lang="ts">
	import { collapseText } from './collapse.js';

	/** What the person wrote: long messages collapse behind "Show more". */
	let { text }: { text: string } = $props();
	let open = $state(false);
	const c = $derived(collapseText(text));
</script>

<span class="whitespace-pre-wrap">{open || !c.collapsed ? text : `${c.shown}…`}</span>
{#if c.collapsed}
	<button
		type="button"
		class="mt-1 block text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
		aria-expanded={open}
		onclick={() => (open = !open)}
	>
		{open ? 'Show less' : `Show more (${c.hidden.toLocaleString('en')} more characters)`}
	</button>
{/if}
