<script lang="ts">
	import ArrowBendDownRightIcon from 'phosphor-svelte/lib/ArrowBendDownRight';
	import type { PartView } from './map.js';

	let { view }: { view: Extract<PartView, { kind: 'input' }> } = $props();

	const label = $derived(
		view.approvalNote
			? `Note on ${view.approvalNote.toolName}`
			: view.source === 'user'
				? 'You added'
				: view.source === 'event'
					? 'Event delivered'
					: view.source.replace('plugin:', '')
	);
	// The framed <user-note> is what the model saw; show the person's own words when present.
	const body = $derived(view.approvalNote ? view.approvalNote.text.replace(/<\/?user-note>/g, '').trim() : view.text);
</script>

<div class="flex w-full items-start gap-2 text-[13px] text-muted-foreground">
	<ArrowBendDownRightIcon class="mt-0.5 size-3.5 shrink-0" />
	<div class="min-w-0">
		<span class="font-medium text-foreground-2">{label}:</span>
		<span class="whitespace-pre-wrap">{body}</span>
	</div>
</div>
