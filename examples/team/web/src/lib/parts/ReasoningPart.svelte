<script lang="ts">
	import { Reasoning, ReasoningContent, ReasoningTrigger } from '#lib/components/ai/reasoning/index.js';

	let { text, streaming, durationMs }: { text: string; streaming: boolean; durationMs?: number } = $props();

	// Reasoning measures its own duration while streaming; for stored parts use the persisted one.
	const seconds = $derived(durationMs === undefined ? undefined : Math.max(1, Math.round(durationMs / 1000)));
</script>

<!-- Open while streaming, auto-closes when the part is done. -->
<Reasoning isStreaming={streaming} duration={seconds}>
	<ReasoningTrigger />
	<ReasoningContent content={text} />
</Reasoning>
