<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import { MessageResponse } from '#lib/components/ai/message/index.js';
	import { discussCard, proposalOutcomeCard } from './event.js';

	let { name, text }: { name: string; text: string } = $props();

	const PREVIEW_LINES = 8;
	let expanded = $state(false);
	const lines = $derived(text.split('\n'));
	const long = $derived(lines.length > PREVIEW_LINES);
	const shown = $derived(expanded || !long ? text : lines.slice(0, PREVIEW_LINES).join('\n'));
	// Subagent reports are long markdown; other events are one dim line.
	const discuss = $derived(discussCard(name, text) ?? proposalOutcomeCard(name, text));
	const isReport = $derived(name.includes('report') || long);
</script>

{#if discuss}
	<div class="w-full rounded-xl border border-border bg-muted/40 p-3 text-[13.5px]" data-testid="discuss-card">
		<div class="text-xs font-medium text-muted-foreground">{discuss.label}</div>
		{#if discuss.title}<p class="mt-0.5 font-medium break-words">{discuss.title}</p>{/if}
		{#if discuss.body}
			<MessageResponse content={expanded || !long ? discuss.body : discuss.body.split('\n').slice(0, PREVIEW_LINES).join('\n')} class="mt-1.5 text-[13.5px]" />
			{#if long}
				<Button variant="ghost" size="sm" class="mt-1.5" onclick={() => (expanded = !expanded)}>{expanded ? 'Show less' : 'Show more'}</Button>
			{/if}
		{/if}
	</div>
{:else if isReport}
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
