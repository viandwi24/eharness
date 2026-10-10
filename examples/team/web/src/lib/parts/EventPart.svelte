<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import { MessageResponse } from '#lib/components/ai/message/index.js';

	let { name, text }: { name: string; text: string } = $props();

	const PREVIEW_LINES = 8;
	let expanded = $state(false);
	const lines = $derived(text.split('\n'));
	const long = $derived(lines.length > PREVIEW_LINES);
	const shown = $derived(expanded || !long ? text : lines.slice(0, PREVIEW_LINES).join('\n'));
	// Subagent reports are long markdown; other events are one dim line.
	const isReport = $derived(name.includes('report') || long);
</script>

{#if isReport}
	<div class="w-full rounded-xl border border-border bg-muted/40 p-3 text-[13.5px]">
		<div class="mb-1.5 font-mono text-[11px] font-medium tracking-[0.8px] text-muted-foreground uppercase">{name}</div>
		<MessageResponse content={shown} class="text-[13.5px]" />
		{#if long}
			<Button variant="ghost" size="sm" class="mt-1.5" onclick={() => (expanded = !expanded)}>
				{expanded ? 'Show less' : `Show more (${lines.length - PREVIEW_LINES} lines)`}
			</Button>
		{/if}
	</div>
{:else}
	<p class="w-full text-center text-xs text-muted-foreground">
		<span class="font-mono">{name}</span>{text ? `: ${text}` : ''}
	</p>
{/if}
