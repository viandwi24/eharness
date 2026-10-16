<script lang="ts">
	import { MessageResponse } from '#lib/components/ai/message/index.js';
	import { BIG_TEXT, previewText, sizeLabel } from './big.js';

	let { text, streaming = false }: { text: string; streaming?: boolean } = $props();

	// Markdown of a very long reply is expensive: settled text over the limit is a plain preview
	// until the reader asks for the formatted whole. Streaming text always renders normally.
	let expanded = $state(false);
	const preview = $derived(previewText(text, BIG_TEXT, 3000));
	const lazy = $derived(preview.big && !expanded && !streaming);
</script>

{#if lazy}
	<div class="flex flex-col gap-2">
		<pre class="m-0 font-sans text-[14.5px] leading-[1.6] whitespace-pre-wrap text-foreground">{preview.shown}…</pre>
		<button type="button" class="self-start text-[12.5px] text-muted-foreground underline underline-offset-4 hover:text-foreground" onclick={() => (expanded = true)}>
			Show full text ({sizeLabel(text.length)})
		</button>
	</div>
{:else}
	<MessageResponse content={text} />
{/if}
