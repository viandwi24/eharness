<script lang="ts">
	/** Preformatted text, clamped to a few lines until expanded. */
	let { text, mono = false, max = 700 }: { text: string; mono?: boolean; max?: number } = $props();
	let full = $state(false);
	const long = $derived(text.length > max);
</script>

<div class="min-w-0">
	<p class="text-[13px] leading-relaxed break-words whitespace-pre-wrap {mono ? 'font-mono text-xs' : ''}">{long && !full ? `${text.slice(0, max)}…` : text}</p>
	{#if long}
		<button type="button" class="mt-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onclick={() => (full = !full)}>
			{full ? 'Show less' : `Show all (${text.length.toLocaleString()} chars)`}
		</button>
	{/if}
</div>
