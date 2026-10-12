<script lang="ts">
	import WarningIcon from 'phosphor-svelte/lib/Warning';
	import FlowFooter from './FlowFooter.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { FlowView } from '#lib/api/index.js';

	let {
		view,
		busy,
		canBack,
		onRetry,
		onBack,
		onCancel
	}: { view: Extract<FlowView, { type: 'error' }>; busy: boolean; canBack: boolean; onRetry: () => void; onBack: () => void; onCancel: () => void } = $props();

	// A connector may start its message with a short heading: `Wrong code: That code is not right.`
	const parts = $derived.by(() => {
		const m = /^([^:.\n]{3,40}): (.+)$/s.exec(view.message);
		return m ? { title: m[1] as string, text: m[2] as string } : { title: 'Could not connect', text: view.message };
	});
</script>

<div class="flex flex-col gap-4">
	<div class="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
		<WarningIcon class="mt-0.5 size-5 shrink-0 text-destructive-text" />
		<div class="flex flex-col gap-1">
			<h3 class="text-sm font-medium">{parts.title}</h3>
			<p class="text-sm text-muted-foreground" role="alert">{parts.text}</p>
		</div>
	</div>
	<FlowFooter>
		<Button variant="ghost" onclick={onCancel} disabled={busy}>Close</Button>
		{#if canBack}<Button variant="outline" onclick={onBack} disabled={busy}>Back</Button>{/if}
		{#if view.retryable}<Button onclick={onRetry} disabled={busy}>Try again</Button>{/if}
	</FlowFooter>
</div>
