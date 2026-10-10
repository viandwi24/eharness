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
</script>

<div class="flex flex-col gap-4">
	<div class="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
		<WarningIcon class="mt-0.5 size-5 shrink-0 text-destructive-text" />
		<div class="flex flex-col gap-1">
			<h3 class="text-sm font-medium">Could not connect</h3>
			<p class="text-sm text-muted-foreground" role="alert">{view.message}</p>
		</div>
	</div>
	<FlowFooter>
		<Button variant="ghost" onclick={onCancel} disabled={busy}>Close</Button>
		{#if canBack}<Button variant="outline" onclick={onBack} disabled={busy}>Back</Button>{/if}
		{#if view.retryable}<Button onclick={onRetry} disabled={busy}>Try again</Button>{/if}
	</FlowFooter>
</div>
