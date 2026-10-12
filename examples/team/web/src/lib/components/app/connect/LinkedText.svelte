<script lang="ts">
	import { linkParts } from '#lib/connectors/flow-view.js';

	/** Text from a flow, with the web addresses it mentions turned into links. */
	let { text }: { text: string } = $props();
</script>

{#each linkParts(text) as part, i (i)}{#if part.href}<a class="underline underline-offset-4" href={part.href} target="_blank" rel="noreferrer">{part.text}</a>{:else}{part.text}{/if}{/each}
