<script lang="ts">
	let { summary }: { summary: string } = $props();
	let open = $state(false);
</script>

<div class="w-full text-center text-xs text-muted-foreground">
	<button type="button" class="inline-flex items-center gap-2 hover:text-foreground" onclick={() => (open = !open)}>
		<span class="h-px w-8 bg-border"></span>
		Conversation summarised
		<span class="h-px w-8 bg-border"></span>
	</button>
	{#if open}<p class="mx-auto mt-2 max-w-prose text-left whitespace-pre-wrap">{summary}</p>{/if}
</div>
