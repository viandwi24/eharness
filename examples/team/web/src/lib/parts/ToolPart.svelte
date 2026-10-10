<script lang="ts">
	import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '#lib/components/ai/tool/index.js';
	import type { PartView } from './map.js';

	let { view }: { view: Extract<PartView, { kind: 'tool' }> } = $props();

	const hasInput = $derived(view.input !== undefined && view.input !== null);
	const hasOutput = $derived(view.output !== undefined && view.output !== null && view.output !== '');
</script>

<!-- Collapsed by default; the header always shows the friendly title and the status badge. -->
<Tool>
	<ToolHeader type={`tool-${view.toolName}`} state={view.state} title={view.title} />
	<ToolContent>
		{#if hasInput}<ToolInput input={view.input} />{/if}
		{#if hasOutput || view.errorText}
			<ToolOutput output={view.output} errorText={view.errorText} />
		{:else if !hasInput}
			<p class="text-muted-foreground">No details yet.</p>
		{/if}
	</ToolContent>
</Tool>
